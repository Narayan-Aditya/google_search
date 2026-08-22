// Insta Handle Finder — LinkedIn search-post exporter (orchestrator).
//
// Fourth job runner in the same service worker, isolated the same way the others are: its
// own storage key, its own tab, its own alarm and its own message namespace, so no two
// runners can corrupt each other's state.
//
// It shares downloadJson() (and the offscreen document behind it) with
// background-profiles.js on purpose — Chrome allows exactly one offscreen document, so one
// file owns it and the rest call in. background.js imports that file first.
//
// Division of labour: this file owns *which search* and *what to keep*; the injected
// content-li-fetch.js owns *how to scroll through one result list*, because a scroll-through
// outlives an MV3 worker but not the tab it runs in.

const LI_STATE_KEY = "linkedinRunState";
const LI_SHARD_PREFIX = "liPosts:";
const LI_ALARM = "linkedinNextSearch";
const LI_NOTIF_ID = "linkedin-pause";

const LI_INJECT_ATTEMPTS = 3;
const LI_RATE_LIMIT_BASE_MS = 5 * 60 * 1000; // LinkedIn's limits are measured in hours
const LI_RATE_LIMIT_MAX_MS = 60 * 60 * 1000;
// Bounded in-state dedupe guard. The authoritative dedupe happens at assembly time over
// every shard, so this only has to catch the common overlap-on-resume case cheaply.
const LI_RECENT_IDS_CAP = 1000;

// ---------------------------------------------------------------------- state helpers

function defaultLinkedinState() {
  return {
    status: "idle", // idle | running | waiting_delay | paused | stopped | done
    phase: "", // "" | loading | scrolling | downloading
    pauseReason: "",
    searches: [], // [{ url, label }]
    searchIndex: 0,
    tabId: null,
    scrollDelaySec: 3,
    searchDelaySec: 10,
    maxPosts: 300,
    pendingInject: false,
    injectToken: 0,
    current: defaultCurrentSearch(null),
    completed: [], // [{ label, postCount, complete, reason }]
    retryCount: 0,
    backoffUntilTs: 0,
    totals: { searches: 0, searchesDone: 0, postsFetched: 0 },
    lastEvent: "",
    log: [],
    updatedAt: 0,
  };
}

function defaultCurrentSearch(search) {
  return {
    url: (search && search.url) || "",
    label: (search && search.label) || "",
    recentPostIds: [],
    shardKeys: [],
    shardSeq: 0,
    roundsDone: 0,
    postsCount: 0,
    source: "",
    reachedLimit: false,
    originRetried: false,
    startedAt: 0,
  };
}

async function getLinkedinState() {
  const stored = await chrome.storage.local.get(LI_STATE_KEY);
  return stored[LI_STATE_KEY] || defaultLinkedinState();
}

async function setLinkedinState(patch) {
  const current = await getLinkedinState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.lastEvent) {
    next.log = [...(current.log || []), patch.lastEvent].slice(-50);
  }
  await chrome.storage.local.set({ [LI_STATE_KEY]: next });
  return next;
}

// Every handler runs through this queue. Reads and writes of the run state are
// read-modify-write, and page reports can interleave with a Stop from the panel — without
// serialising them, one update silently overwrites the other.
let linkedinStateChain = Promise.resolve();

function queueLinkedinTask(task) {
  const run = linkedinStateChain.then(task, task);
  linkedinStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function linkedinSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------- search utilities

// Accepts a LinkedIn search-results URL or a hashtag feed URL — the two places LinkedIn
// renders a scrollable list of posts. Everything else (a profile, a single post, a job
// search) is rejected, because nothing here knows how to page through it.
//
// `/search/results/all/` is rewritten to the content vertical: the caller asked for posts,
// and the "all" tab only ever shows a handful of them above the people results.
function normalizeSearchUrl(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
  } catch (e) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "linkedin.com" && host !== "linkedin.cn") return null;

  const path = url.pathname.replace(/\/+$/, "");
  const isSearch = /^\/search\/results\/[a-z]+$/i.test(path);
  const isHashtag = /^\/feed\/hashtag(\/[^/]*)?$/i.test(path);
  if (!isSearch && !isHashtag) return null;

  if (isSearch) {
    const vertical = path.split("/")[3].toLowerCase();
    // People/company/job verticals do not list posts at all.
    if (vertical !== "content" && vertical !== "all") return null;
    url.pathname = "/search/results/content/";
  }

  return { url: url.href, label: searchLabelFor(url) };
}

// A short human name for the run, used in the log, the panel and the filename.
function searchLabelFor(url) {
  const keywords = url.searchParams.get("keywords");
  if (keywords) return keywords.trim().slice(0, 80);
  const hashtag = url.searchParams.get("keywords") || url.pathname.split("/")[3];
  if (hashtag) return "#" + decodeURIComponent(hashtag).slice(0, 80);
  return "linkedin-search";
}

// Strips anything that could escape the download directory or create a hidden file.
function safeSearchFilename(label) {
  const base = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "")
    .slice(0, 60);
  return "linkedin-" + (base || "search") + ".json";
}

// ------------------------------------------------------------------------ post shards

// Posts are written to append-only shards instead of one growing array on the run state.
// Rewriting the whole array on every scroll would be quadratic in write volume.
async function appendLinkedinShard(label, seq, posts) {
  const key = LI_SHARD_PREFIX + safeSearchFilename(label).replace(/\.json$/, "") + ":" + seq;
  await chrome.storage.local.set({ [key]: posts });
  return key;
}

async function readLinkedinShards(shardKeys) {
  if (!shardKeys || !shardKeys.length) return [];
  const stored = await chrome.storage.local.get(shardKeys);
  const ordered = [...shardKeys].sort((a, b) => {
    const seqA = Number(a.slice(a.lastIndexOf(":") + 1));
    const seqB = Number(b.slice(b.lastIndexOf(":") + 1));
    return seqA - seqB;
  });

  const seen = new Set();
  const posts = [];
  for (const key of ordered) {
    const shard = stored[key];
    if (!Array.isArray(shard)) continue;
    for (const post of shard) {
      if (!post || post.id == null || seen.has(post.id)) continue;
      seen.add(post.id);
      posts.push(post);
    }
  }
  return posts;
}

async function dropLinkedinShards(shardKeys) {
  if (!shardKeys || !shardKeys.length) return;
  try {
    await chrome.storage.local.remove(shardKeys);
  } catch (e) {
    // Leftover shards only waste space; never let cleanup fail a completed search.
  }
}

async function dropAllLinkedinShards() {
  let keys = [];
  if (typeof chrome.storage.local.getKeys === "function") {
    const all = await chrome.storage.local.getKeys();
    keys = all.filter((key) => key.startsWith(LI_SHARD_PREFIX));
  } else {
    const state = await getLinkedinState();
    keys = (state.current && state.current.shardKeys) || [];
  }
  if (keys.length) await chrome.storage.local.remove(keys);
}

// ----------------------------------------------------------------------- JSON assembly

// The exported shape of one post. The scraper collects more than this (ids, counts, media,
// permalinks) and the shards keep all of it — an id in particular is what dedupes a post
// across scrolls and resumes — but the file itself is deliberately narrow, because this is
// what the export is actually for. Widening it again means adding a line here, nothing else.
function slimPost(post) {
  const author = (post && post.author) || {};
  return {
    author: {
      name: author.name != null ? author.name : null,
      profile_url: author.profile_url != null ? author.profile_url : null,
      type: author.type != null ? author.type : null,
      discription: author.headline != null ? author.headline : null,
    },
    posted_text: post.posted_text != null ? post.posted_text : null,
    text: post.text != null ? post.text : "",
  };
}

// Same envelope the other two exporters write, with `posts` and a `search` block in place
// of a profile.
async function buildSearchJson(state, options) {
  const current = state.current;
  const posts = (await readLinkedinShards(current.shardKeys)).map(slimPost);
  const complete = !!(options && options.complete);

  const payload = {
    search_label: current.label,
    search_url: current.url,
    fetched_at: new Date().toISOString(),
    source: current.source || "dom",
    complete,
    incomplete_reason: complete ? null : (options && options.reason) || "incomplete",
    max_posts: state.maxPosts || null,
    scroll_rounds: current.roundsDone,
    posts_collected: posts.length,
    posts,
  };

  return JSON.stringify(payload, null, 2);
}

// Writes one search's file. Never throws into a caller mid-transition — a download failure
// becomes a pause the user can act on, with the shards left intact so Resume can retry
// without re-scrolling.
async function saveSearchFile(state, options) {
  try {
    const json = await buildSearchJson(state, options);
    // Shared with the Instagram exporter — see the header note.
    await downloadJson(safeSearchFilename(state.current.label), json);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ run-state controls

function linkedinStatusIsActive(status) {
  return status === "running" || status === "waiting_delay" || status === "paused";
}

async function enterLinkedinPause(reason, detail) {
  await chrome.alarms.clear(LI_ALARM);
  chrome.action.setBadgeText({ text: "⏸" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });

  const patch = { status: "paused", pauseReason: reason, pendingInject: false, lastEvent: detail };

  if (reason === "rate_limit") {
    const prior = await getLinkedinState();
    const retryCount = (prior.retryCount || 0) + 1;
    const waitMs = Math.min(
      LI_RATE_LIMIT_BASE_MS * Math.pow(2, retryCount - 1),
      LI_RATE_LIMIT_MAX_MS
    );
    patch.retryCount = retryCount;
    patch.backoffUntilTs = Date.now() + waitMs;
    patch.lastEvent = detail + " (" + Math.round(waitMs / 60000) + " min baad Resume kar sakte ho)";
  }

  await setLinkedinState(patch);

  chrome.notifications.create(LI_NOTIF_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "LinkedIn Exporter — Paused",
    message: patch.lastEvent,
    priority: 2,
    requireInteraction: true,
  });
}

async function finishLinkedinRun(state) {
  await chrome.alarms.clear(LI_ALARM);
  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#188038" });
  await setLinkedinState({
    status: "done",
    phase: "",
    pendingInject: false,
    lastEvent:
      "Sab searches ho gayi — " +
      state.totals.searchesDone +
      "/" +
      state.searches.length +
      " file(s) download",
  });
}

// Records the outcome of the search we just left and moves to the next one, or finishes.
async function advanceLinkedinSearch(state, outcome) {
  const completed = [
    ...state.completed,
    {
      label: state.current.label,
      postCount: state.current.postsCount,
      complete: !!outcome.complete,
      reason: outcome.reason || null,
    },
  ];

  const searchIndex = state.searchIndex + 1;
  const totals = {
    ...state.totals,
    searchesDone: state.totals.searchesDone + (outcome.complete ? 1 : 0),
  };

  if (searchIndex >= state.searches.length) {
    const next = await setLinkedinState({
      completed,
      totals,
      searchIndex,
      phase: "",
      current: defaultCurrentSearch(null),
    });
    await finishLinkedinRun(next);
    return;
  }

  const nextSearch = state.searches[searchIndex];
  await setLinkedinState({
    completed,
    totals,
    searchIndex,
    status: "waiting_delay",
    phase: "",
    pauseReason: "",
    pendingInject: false,
    current: defaultCurrentSearch(nextSearch),
    lastEvent: "Agli search: " + nextSearch.label,
  });
  scheduleLinkedinAlarm(state.searchDelaySec);
}

function scheduleLinkedinAlarm(baseSeconds) {
  const jitter = baseSeconds * (Math.random() * 0.4 - 0.2); // +/-20%, same as the others
  const delaySeconds = Math.max(1, baseSeconds + jitter);
  chrome.alarms.create(LI_ALARM, { delayInMinutes: delaySeconds / 60 });
}

// ------------------------------------------------------------------------- tab driving

async function openLinkedinTab(state, search) {
  const token = (state.injectToken || 0) + 1;

  let tabId = state.tabId;
  if (tabId != null) {
    try {
      await chrome.tabs.update(tabId, { url: search.url, active: true });
    } catch (e) {
      tabId = null; // tab is gone; fall through and make a new one
    }
  }
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: search.url, active: true });
    tabId = tab.id;
  }

  await setLinkedinState({ tabId, injectToken: token, pendingInject: true, status: "running" });
  return tabId;
}

async function injectLinkedinFetcher(tabId, state) {
  const current = state.current;
  const job = {
    searchKey: current.url,
    label: current.label,
    seenPostIds: current.recentPostIds || [],
    roundsDone: current.roundsDone || 0,
    postsCount: current.postsCount || 0,
    scrollDelayMs: Math.max(2, state.scrollDelaySec) * 1000,
    maxPosts: Number(state.maxPosts) || 0,
    runToken: state.injectToken,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= LI_INJECT_ATTEMPTS; attempt++) {
    try {
      // executeScript cannot pass arguments to a `files` injection, so the job is seeded
      // into the isolated world first — both injections share that world's `window`.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (seed) => {
          window.__LI_JOB__ = seed;
          window.__LI_STOP__ = false;
        },
        args: [job],
      });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-li-fetch.js"] });
      return true;
    } catch (e) {
      lastError = e;
      if (attempt < LI_INJECT_ATTEMPTS) await linkedinSleep(1500 * attempt);
    }
  }

  await enterLinkedinPause(
    "injection_failed",
    'Scraper "' +
      current.label +
      '" pe chal nahi paaya ' +
      LI_INJECT_ATTEMPTS +
      " koshish ke baad (" +
      (lastError && lastError.message ? lastError.message : "unknown") +
      "). Tab check karke Resume dabao."
  );
  return false;
}

// Best-effort: tells a live content-script loop to stop before its next scroll.
async function signalLinkedinStop(tabId) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.__LI_STOP__ = true;
      },
    });
  } catch (e) {
    // Tab closed or navigated away — the loop is already gone.
  }
}

// --------------------------------------------------------------------- panel commands

async function startLinkedinRun(msg) {
  const searches = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of Array.isArray(msg.searches) ? msg.searches : []) {
    if (typeof raw !== "string" || !raw.trim()) continue; // blank lines are not "skipped"
    const search = normalizeSearchUrl(raw);
    if (!search) {
      skipped += 1;
      continue;
    }
    if (seen.has(search.url)) continue;
    seen.add(search.url);
    searches.push(search);
  }

  if (!searches.length) {
    await setLinkedinState({
      status: "idle",
      lastEvent: "Koi sahi LinkedIn search URL nahi mila — kuch bhi start nahi kiya",
    });
    return;
  }

  await chrome.alarms.clear(LI_ALARM);
  chrome.notifications.clear(LI_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await dropAllLinkedinShards();

  const scrollDelaySec = Math.max(2, Number(msg.scrollDelaySec) || 3);
  const searchDelaySec = Math.max(5, Number(msg.searchDelaySec) || 10);
  const maxPosts = Math.max(0, Number(msg.maxPosts) || 0);

  const fresh = {
    ...defaultLinkedinState(),
    status: "running",
    phase: "loading",
    searches,
    scrollDelaySec,
    searchDelaySec,
    maxPosts,
    current: defaultCurrentSearch(searches[0]),
    totals: { searches: searches.length, searchesDone: 0, postsFetched: 0 },
    lastEvent:
      "Start: " +
      searches[0].label +
      (skipped ? " (" + skipped + " line skip ki — sirf search URL chalega)" : ""),
    updatedAt: Date.now(),
  };
  fresh.log = [fresh.lastEvent];
  await chrome.storage.local.set({ [LI_STATE_KEY]: fresh });

  let tabId;
  try {
    tabId = await openLinkedinTab(fresh, searches[0]);
  } catch (e) {
    await setLinkedinState({
      status: "stopped",
      phase: "",
      lastEvent: "Tab nahi khul paaya (" + (e && e.message ? e.message : "unknown") + ")",
    });
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId });
  } catch (e) {
    // Panel may already be open, or the user-gesture window expired — non-fatal.
  }
}

async function resumeLinkedinRun() {
  const state = await getLinkedinState();
  if (state.status !== "paused" && state.status !== "stopped") return;
  if (!state.searches.length || state.searchIndex >= state.searches.length) return;

  if (state.pauseReason === "rate_limit" && Date.now() < state.backoffUntilTs) {
    const secondsLeft = Math.ceil((state.backoffUntilTs - Date.now()) / 1000);
    await setLinkedinState({ lastEvent: "Abhi " + secondsLeft + "s aur ruko — cool-down chal raha hai" });
    return;
  }

  chrome.notifications.clear(LI_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });

  const search = state.searches[state.searchIndex];
  await setLinkedinState({
    pauseReason: "",
    phase: "loading",
    lastEvent:
      "Resume " +
      search.label +
      (state.current.postsCount ? " — " + state.current.postsCount + " posts se aage" : ""),
  });

  const refreshed = await getLinkedinState();
  await openLinkedinTab(refreshed, search);
}

async function stopLinkedinRun() {
  const state = await getLinkedinState();
  await chrome.alarms.clear(LI_ALARM);
  chrome.notifications.clear(LI_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalLinkedinStop(state.tabId);
  await setLinkedinState({
    status: "stopped",
    phase: "",
    pendingInject: false,
    lastEvent: "Run rok diya — jitna data aaya woh safe hai",
  });
}

async function resetLinkedinRun() {
  const state = await getLinkedinState();
  await chrome.alarms.clear(LI_ALARM);
  chrome.notifications.clear(LI_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalLinkedinStop(state.tabId);
  await dropAllLinkedinShards();
  await chrome.storage.local.set({ [LI_STATE_KEY]: defaultLinkedinState() });
}

// Lets the user grab whatever the current search has so far, mid-run.
async function downloadCurrentLinkedin() {
  const state = await getLinkedinState();
  if (!state.current.url || !state.current.postsCount) {
    await setLinkedinState({ lastEvent: "Abhi kuch download karne layak nahi hai" });
    return;
  }
  const result = await saveSearchFile(state, {
    complete: false,
    reason: "partial: " + (state.pauseReason || state.status),
  });
  await setLinkedinState({
    lastEvent: result.ok
      ? "Partial file download: " + safeSearchFilename(state.current.label)
      : "Download fail hua — " + result.error,
  });
}

// ------------------------------------------------------- content-script report handlers

async function handleLinkedinPage(msg) {
  const state = await getLinkedinState();
  if (!isLiveLinkedinReport(state, msg)) return { ok: false, abort: true };

  const posts = Array.isArray(msg.posts) ? msg.posts : [];
  const current = { ...state.current };

  if (posts.length) {
    const seq = current.shardSeq;
    let key;
    try {
      key = await appendLinkedinShard(current.label, seq, posts);
    } catch (e) {
      // Almost always the storage quota. Stop cleanly with the shards already banked.
      await enterLinkedinPause(
        "storage_full",
        "Storage bhar gaya (" +
          (e && e.message ? e.message : "quota") +
          ") — 'Download partial' se file nikaal ke Reset karo."
      );
      return { ok: false, abort: true };
    }
    current.shardKeys = [...current.shardKeys, key];
    current.shardSeq = seq + 1;
    current.postsCount += posts.length;
    current.recentPostIds = [...current.recentPostIds, ...posts.map((post) => post.id)].slice(
      -LI_RECENT_IDS_CAP
    );
  }

  current.roundsDone = (Number(msg.round) || 0) + 1;
  current.source = current.source || msg.source || "dom";

  await setLinkedinState({
    current,
    phase: "scrolling",
    // A batch that lands is proof the limit has cleared.
    retryCount: 0,
    backoffUntilTs: 0,
    totals: { ...state.totals, postsFetched: state.totals.postsFetched + posts.length },
    lastEvent:
      current.label +
      " scroll " +
      current.roundsDone +
      ": +" +
      posts.length +
      " posts (kul " +
      current.postsCount +
      ")",
  });
  return { ok: true };
}

async function handleLinkedinDone(msg) {
  const state = await getLinkedinState();
  if (!isLiveLinkedinReport(state, msg)) return { ok: false, abort: true };

  const reachedLimit = !!msg.reachedLimit;
  // Zero posts is never reported as a clean finish — either the search really has none or
  // LinkedIn changed its markup, and both deserve a visible flag.
  const foundNothing = !!msg.foundNothing || !state.current.postsCount;
  const current = { ...state.current, reachedLimit };

  const withFlag = await setLinkedinState({
    current,
    phase: "downloading",
    lastEvent:
      current.label +
      " complete — " +
      current.postsCount +
      " posts" +
      (reachedLimit ? " (limit tak pahunch gaye)" : "") +
      (foundNothing
        ? " (ek bhi post nahi mila" + (msg.page ? " — " + String(msg.page).slice(0, 200) : "") + ")"
        : ""),
  });

  const result = await saveSearchFile(withFlag, {
    complete: !foundNothing,
    reason: foundNothing
      ? "no posts found — search may be empty or LinkedIn changed its markup" +
        (msg.page ? " [page: " + String(msg.page).slice(0, 200) + "]" : "")
      : reachedLimit
        ? "max posts limit reached"
        : null,
  });

  if (!result.ok) {
    // Shards are intentionally left in place so Resume can retry the save without
    // re-scrolling the search.
    await enterLinkedinPause(
      "download_failed",
      current.label + " ka JSON save nahi hua (" + result.error + ") — Resume se dobara try karo."
    );
    return { ok: false, abort: true };
  }

  await dropLinkedinShards(current.shardKeys);
  await setLinkedinState({ lastEvent: "Download: " + safeSearchFilename(current.label) });

  const after = await getLinkedinState();
  await advanceLinkedinSearch(after, {
    complete: !foundNothing,
    reason: foundNothing ? "no posts found" : reachedLimit ? "limit reached" : null,
  });
  return { ok: true };
}

// Reasons that are about *this search* rather than our access — skip and carry on.
const LI_SKIP_REASONS = new Set(["no_results"]);

const LI_PAUSE_MESSAGES = {
  login_wall: "LinkedIn pe login nahi ho — us tab me login karo, phir Resume dabao.",
  challenge: "LinkedIn ne verification maanga — tab me clear karke Resume dabao.",
  rate_limit: "LinkedIn ka search limit lag gaya — thoda ruk ke Resume karo.",
  wrong_origin: "Tab linkedin.com pe nahi tha — Resume se dobara khol ke try karo.",
  no_results: "Is search me koi post nahi mila.",
};

async function handleLinkedinError(msg) {
  const state = await getLinkedinState();
  if (!isLiveLinkedinReport(state, msg)) return { ok: false, abort: true };

  const reason = msg.reason || "no_results";
  const label = state.current.label;

  if (LI_SKIP_REASONS.has(reason)) {
    await setLinkedinState({
      // The page-shape dump is the whole point of this message — do not clip it to a
      // teaser. It is the one line that tells us which selector to add next.
      lastEvent: label + " — koi post nahi mila, skip kar diya [" + String(msg.detail || "").slice(0, 600) + "]",
    });
    await dropLinkedinShards(state.current.shardKeys);
    const after = await getLinkedinState();
    await advanceLinkedinSearch(after, { complete: false, reason: "no posts found" });
    return { ok: true, abort: true };
  }

  // A landing on the wrong origin means the tab hadn't settled yet. One silent
  // re-navigation heals that; a second one is a real problem worth pausing on.
  if (reason === "wrong_origin" && !state.current.originRetried) {
    await setLinkedinState({
      current: { ...state.current, originRetried: true },
      lastEvent: "Tab galat page pe tha — dobara khol rahe hain " + label,
    });
    const refreshed = await getLinkedinState();
    await openLinkedinTab(refreshed, { url: state.current.url, label });
    return { ok: true, abort: true };
  }

  const base = LI_PAUSE_MESSAGES[reason] || "Ruk gaye — " + reason;
  const detail = msg.detail ? " [" + String(msg.detail).slice(0, 600) + "]" : "";
  await enterLinkedinPause(reason, label + ": " + base + detail);
  return { ok: false, abort: true };
}

// Guards against a stale content-script loop reporting into a run that has moved on —
// after a Stop, a Reset, or once the worker has advanced to the next search.
function isLiveLinkedinReport(state, msg) {
  if (state.status !== "running") return false;
  if (!state.current.url) return false;
  return msg.search === state.current.url;
}

// ----------------------------------------------------------------------- event wiring

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // Panel commands: same convention as the other runners — always answer with full state.
  if (msg.type.startsWith("LINKEDIN_")) {
    queueLinkedinTask(async () => {
      switch (msg.type) {
        case "LINKEDIN_START":
          await startLinkedinRun(msg);
          break;
        case "LINKEDIN_RESUME":
          await resumeLinkedinRun();
          break;
        case "LINKEDIN_STOP":
          await stopLinkedinRun();
          break;
        case "LINKEDIN_RESET":
          await resetLinkedinRun();
          break;
        case "LINKEDIN_DOWNLOAD_CURRENT":
          await downloadCurrentLinkedin();
          break;
        default: // LINKEDIN_GET_STATE and anything unknown just read the state back
          break;
      }
    })
      .catch(() => undefined)
      .then(async () => {
        sendResponse(await getLinkedinState());
      });
    return true;
  }

  // Content-script reports.
  if (msg.type.startsWith("LI_")) {
    queueLinkedinTask(async () => {
      switch (msg.type) {
        case "LI_PAGE":
          return handleLinkedinPage(msg);
        case "LI_DONE":
          return handleLinkedinDone(msg);
        case "LI_ERROR":
          return handleLinkedinError(msg);
        case "LI_NOTE": {
          const state = await getLinkedinState();
          if (!isLiveLinkedinReport(state, msg)) return { ok: false, abort: true };
          await setLinkedinState({ lastEvent: msg.detail || "" });
          return { ok: true };
        }
        default:
          return { ok: true };
      }
    })
      .then(
        (result) => sendResponse(result || { ok: true }),
        (e) =>
          // An orchestrator bug must not leave the content script hanging on an ack.
          sendResponse({ ok: false, abort: true, error: e && e.message ? e.message : String(e) })
      );
    return true;
  }

  return false; // not ours — let the other runners answer it
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  queueLinkedinTask(async () => {
    const state = await getLinkedinState();
    if (state.status !== "running" || tabId !== state.tabId || !state.pendingInject) return;

    const url = tab && tab.url ? tab.url : "";
    if (!/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(url)) {
      // Chrome fires `complete` for about:blank on a fresh tab before the real navigation.
      if (!/^https?:\/\//i.test(url)) return;
      // A committed load on another origin means LinkedIn bounced us somewhere the
      // scraper can never run. Without this the run would sit in "running" forever.
      await enterLinkedinPause(
        "wrong_origin",
        state.current.label + ": " + LI_PAUSE_MESSAGES.wrong_origin + " [" + url.slice(0, 120) + "]"
      );
      return;
    }

    await setLinkedinState({ pendingInject: false });
    const refreshed = await getLinkedinState();
    await injectLinkedinFetcher(tabId, refreshed);
  }).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LI_ALARM) return;
  queueLinkedinTask(async () => {
    const state = await getLinkedinState();
    if (state.status !== "waiting_delay") return;
    const search = state.searches[state.searchIndex];
    if (!search) return;
    await setLinkedinState({ phase: "loading", lastEvent: search.label + " khol rahe hain" });
    const refreshed = await getLinkedinState();
    try {
      await openLinkedinTab(refreshed, search);
    } catch (e) {
      await setLinkedinState({
        status: "stopped",
        lastEvent: "Tab nahi khul paaya (" + (e && e.message ? e.message : "unknown") + ") — data safe hai",
      });
    }
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueLinkedinTask(async () => {
    const state = await getLinkedinState();
    if (state.tabId !== tabId || !linkedinStatusIsActive(state.status)) return;
    await chrome.alarms.clear(LI_ALARM);
    chrome.action.setBadgeText({ text: "" });
    await setLinkedinState({
      status: "stopped",
      phase: "",
      pendingInject: false,
      tabId: null,
      lastEvent: "Tab band ho gaya — jitna data aaya woh safe hai, Resume se aage badha sakte ho",
    });
  }).catch(() => undefined);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== LI_NOTIF_ID) return;
  queueLinkedinTask(async () => {
    const state = await getLinkedinState();
    if (state.tabId == null) return;
    try {
      await chrome.tabs.update(state.tabId, { active: true });
      const tab = await chrome.tabs.get(state.tabId);
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      // Tab already gone; nothing to focus.
    }
    chrome.notifications.clear(LI_NOTIF_ID);
  }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  queueLinkedinTask(async () => {
    const state = await getLinkedinState();
    if (state.status !== "running" && state.status !== "waiting_delay") return;
    await setLinkedinState({
      status: "stopped",
      phase: "",
      pendingInject: false,
      tabId: null,
      lastEvent: "Browser restart hua — Resume dabao, wahin se aage chalega",
    });
  }).catch(() => undefined);
});
