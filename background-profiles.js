// Insta Handle Finder — Instagram profile/posts exporter (orchestrator).
//
// Loaded into the same service worker as background.js, but deliberately isolated: its
// own storage key, its own tab, its own alarm and its own message namespace, so the two
// job runners cannot corrupt each other's state.
//
// Same stance as the Google side: nothing is evaded. It drives the user's own logged-in
// instagram.com tab, and any wall it meets (rate limit, login, checkpoint) becomes a
// resumable pause with a notification — never a silent failure and never a retry storm.
//
// Division of labour: this file owns *which account* and *what to keep*; the injected
// content-ig-fetch.js owns *how to page through one account*, because a paginated crawl
// outlives an MV3 worker but not the tab it runs in.

const PROFILE_STATE_KEY = "profileRunState";
const PROFILE_SHARD_PREFIX = "igPosts:";
const PROFILE_ALARM = "profileNextAccount";
const PROFILE_NOTIF_ID = "profile-pause";
const OFFSCREEN_PATH = "offscreen.html";

const PROFILE_INJECT_ATTEMPTS = 3;
const PROFILE_RATE_LIMIT_BASE_MS = 60 * 1000;
const PROFILE_RATE_LIMIT_MAX_MS = 15 * 60 * 1000;
// Bounded in-state dedupe guard. The authoritative dedupe happens at assembly time over
// every shard, so this only has to catch the common overlap-on-resume case cheaply.
const PROFILE_RECENT_IDS_CAP = 500;

const PROFILE_IGNORED_HANDLES = new Set([
  "p", "reel", "reels", "stories", "explore", "tv", "direct",
  "accounts", "about", "developer", "legal", "terms", "privacy", "help",
]);
const PROFILE_HANDLE_RE = /^[a-z0-9._]{1,30}$/;

// ---------------------------------------------------------------------- state helpers

function defaultProfileState() {
  return {
    status: "idle", // idle | running | waiting_delay | paused | stopped | done
    phase: "", // "" | resolving | paginating | downloading
    pauseReason: "",
    accounts: [],
    accountIndex: 0,
    tabId: null,
    pageDelaySec: 3,
    accountDelaySec: 8,
    pendingInject: false,
    injectToken: 0,
    current: defaultCurrentAccount(""),
    completed: [], // [{ handle, postCount, complete, reason, source }]
    retryCount: 0,
    backoffUntilTs: 0,
    totals: { accounts: 0, accountsDone: 0, postsFetched: 0 },
    lastEvent: "",
    log: [],
    updatedAt: 0,
  };
}

function defaultCurrentAccount(handle) {
  return {
    handle: handle || "",
    userId: null,
    profile: null,
    cursor: null,
    moreAvailable: true,
    recentPostIds: [],
    shardKeys: [],
    shardSeq: 0,
    pagesFetched: 0,
    postsCount: 0,
    source: "",
    capped: false,
    originRetried: false,
    startedAt: 0,
  };
}

async function getProfileState() {
  const stored = await chrome.storage.local.get(PROFILE_STATE_KEY);
  return stored[PROFILE_STATE_KEY] || defaultProfileState();
}

async function setProfileState(patch) {
  const current = await getProfileState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.lastEvent) {
    next.log = [...(current.log || []), patch.lastEvent].slice(-50);
  }
  await chrome.storage.local.set({ [PROFILE_STATE_KEY]: next });
  return next;
}

// Every handler runs through this queue. Reads and writes of the run state are
// read-modify-write, and page reports can interleave with a Stop from the panel — without
// serialising them, one update silently overwrites the other.
let profileStateChain = Promise.resolve();

function queueProfileTask(task) {
  const run = profileStateChain.then(task, task);
  profileStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function profileSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------- handle utilities

// Accepts a profile URL, an @handle or a bare handle; rejects post/reel/explore URLs and
// anything with more than one path segment. Mirrors instagramProfile() in
// content-scraper.js so both features agree on what counts as a profile.
function normalizeProfileHandle(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("@")) value = value.slice(1);

  if (/^https?:\/\//i.test(value) || value.toLowerCase().includes("instagram.com")) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
    } catch (e) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com" && host !== "instagr.am") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null; // /p/, /reel/, /foo/tagged/ etc.
    try {
      value = decodeURIComponent(parts[0]);
    } catch (e) {
      value = parts[0];
    }
  }

  value = value.toLowerCase();
  if (PROFILE_IGNORED_HANDLES.has(value) || !PROFILE_HANDLE_RE.test(value)) return null;
  return value;
}

function profileUrlFor(handle) {
  return "https://www.instagram.com/" + encodeURIComponent(handle) + "/";
}

// Strips anything that could escape the download directory or create a hidden file.
function safeHandleFilename(handle) {
  const base = String(handle || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 60);
  return (base || "profile") + ".json";
}

// ------------------------------------------------------------------------ post shards

// Posts are written to append-only shards instead of one growing array on the run state.
// Rewriting a 16k-post array on every page would be quadratic in write volume and would
// blow the storage quota long before the crawl finished.
async function appendPostShard(handle, seq, posts) {
  const key = PROFILE_SHARD_PREFIX + handle + ":" + seq;
  await chrome.storage.local.set({ [key]: posts });
  return key;
}

async function readPostShards(shardKeys) {
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

async function dropPostShards(shardKeys) {
  if (!shardKeys || !shardKeys.length) return;
  try {
    await chrome.storage.local.remove(shardKeys);
  } catch (e) {
    // Leftover shards only waste space; never let cleanup fail a completed account.
  }
}

// Sweeps stale shards. Prefers getKeys() so a half-finished 16k-post crawl is not pulled
// into memory just to learn its key names; falls back to the keys the run state tracks.
async function dropAllPostShards() {
  let keys = [];
  if (typeof chrome.storage.local.getKeys === "function") {
    const all = await chrome.storage.local.getKeys();
    keys = all.filter((key) => key.startsWith(PROFILE_SHARD_PREFIX));
  } else {
    const state = await getProfileState();
    keys = (state.current && state.current.shardKeys) || [];
  }
  if (keys.length) await chrome.storage.local.remove(keys);
}

// --------------------------------------------------------------------------- downloads

let offscreenReady = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (offscreenReady) {
    await offscreenReady;
    return;
  }
  offscreenReady = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"],
      justification: "Turn the collected profile JSON into a downloadable blob URL.",
    })
    .catch((e) => {
      // Two creates can race; the loser's error is benign as long as a document exists.
      if (!String(e && e.message).includes("Only a single offscreen")) throw e;
    })
    .finally(() => {
      offscreenReady = null;
    });
  await offscreenReady;
}

// Blob URLs must outlive the download, so they are revoked from chrome.downloads.onChanged.
const pendingDownloadUrls = new Map();

async function downloadJson(filename, json) {
  await ensureOffscreenDocument();

  const minted = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_MAKE_URL",
    json,
  });
  if (!minted || !minted.ok || !minted.url) {
    throw new Error((minted && minted.error) || "offscreen document did not return a URL");
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: minted.url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    pendingDownloadUrls.set(downloadId, minted.url);
    return downloadId;
  } catch (e) {
    await revokeOffscreenUrl(minted.url);
    throw e;
  }
}

async function revokeOffscreenUrl(url) {
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_REVOKE_URL", url });
  } catch (e) {
    // Offscreen document already torn down — the URL died with it.
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state) return;
  if (delta.state.current !== "complete" && delta.state.current !== "interrupted") return;
  const url = pendingDownloadUrls.get(delta.id);
  if (!url) return;
  pendingDownloadUrls.delete(delta.id);
  revokeOffscreenUrl(url);
});

// ----------------------------------------------------------------------- JSON assembly

async function buildAccountJson(state, options) {
  const current = state.current;
  const posts = await readPostShards(current.shardKeys);
  const complete = !!(options && options.complete);

  const payload = {
    handle: current.handle,
    profile_url: profileUrlFor(current.handle),
    fetched_at: new Date().toISOString(),
    source: current.source || "unknown",
    complete,
    incomplete_reason: complete ? null : (options && options.reason) || "incomplete",
    profile: current.profile,
    posts_count_reported: current.profile ? current.profile.posts_count : null,
    posts_collected: posts.length,
    posts,
  };

  return JSON.stringify(payload, null, 2);
}

// Writes one account's file. Never throws into a caller mid-transition — a download
// failure becomes a pause the user can act on, with the shards left intact so Resume can
// try again without re-crawling.
async function saveAccountFile(state, options) {
  const handle = state.current.handle;
  try {
    const json = await buildAccountJson(state, options);
    await downloadJson(safeHandleFilename(handle), json);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ run-state controls

function profileStatusIsActive(status) {
  return status === "running" || status === "waiting_delay" || status === "paused";
}

async function enterProfilePause(reason, detail) {
  await chrome.alarms.clear(PROFILE_ALARM);
  chrome.action.setBadgeText({ text: "⏸" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });

  const patch = { status: "paused", pauseReason: reason, pendingInject: false, lastEvent: detail };

  if (reason === "rate_limit") {
    const prior = await getProfileState();
    const retryCount = (prior.retryCount || 0) + 1;
    const waitMs = Math.min(
      PROFILE_RATE_LIMIT_BASE_MS * Math.pow(2, retryCount - 1),
      PROFILE_RATE_LIMIT_MAX_MS
    );
    patch.retryCount = retryCount;
    patch.backoffUntilTs = Date.now() + waitMs;
    patch.lastEvent = detail + " (" + Math.round(waitMs / 60000) + " min baad Resume kar sakte ho)";
  }

  await setProfileState(patch);

  chrome.notifications.create(PROFILE_NOTIF_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Instagram Exporter — Paused",
    message: patch.lastEvent,
    priority: 2,
    requireInteraction: true,
  });
}

async function finishProfileRun(state) {
  await chrome.alarms.clear(PROFILE_ALARM);
  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#188038" });
  const done = state.totals.accountsDone;
  await setProfileState({
    status: "done",
    phase: "",
    pendingInject: false,
    lastEvent: "Sab accounts ho gaye — " + done + "/" + state.accounts.length + " file(s) download",
  });
}

// Records the outcome of the account we just left and moves to the next one, or finishes.
async function advanceProfileAccount(state, outcome) {
  const completed = [
    ...state.completed,
    {
      handle: state.current.handle,
      postCount: state.current.postsCount,
      complete: !!outcome.complete,
      reason: outcome.reason || null,
      source: state.current.source || null,
    },
  ];

  const accountIndex = state.accountIndex + 1;
  const totals = {
    ...state.totals,
    accountsDone: state.totals.accountsDone + (outcome.complete ? 1 : 0),
  };

  if (accountIndex >= state.accounts.length) {
    const next = await setProfileState({
      completed,
      totals,
      accountIndex,
      phase: "",
      current: defaultCurrentAccount(""),
    });
    await finishProfileRun(next);
    return;
  }

  const nextHandle = state.accounts[accountIndex];
  await setProfileState({
    completed,
    totals,
    accountIndex,
    status: "waiting_delay",
    phase: "",
    pauseReason: "",
    pendingInject: false,
    current: defaultCurrentAccount(nextHandle),
    lastEvent: "Agla account: @" + nextHandle,
  });
  scheduleProfileAlarm(state.accountDelaySec);
}

function scheduleProfileAlarm(baseSeconds) {
  const jitter = baseSeconds * (Math.random() * 0.4 - 0.2); // +/-20%, same as the Google side
  const delaySeconds = Math.max(1, baseSeconds + jitter);
  chrome.alarms.create(PROFILE_ALARM, { delayInMinutes: delaySeconds / 60 });
}

// ------------------------------------------------------------------------- tab driving

// Navigates the driven tab to an account and arms the injection that fires once the page
// finishes loading. Re-creates the tab if the user closed it.
async function openProfileTab(state, handle) {
  const url = profileUrlFor(handle);
  const token = (state.injectToken || 0) + 1;

  let tabId = state.tabId;
  if (tabId != null) {
    try {
      await chrome.tabs.update(tabId, { url, active: true });
    } catch (e) {
      tabId = null; // tab is gone; fall through and make a new one
    }
  }
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;
  }

  await setProfileState({ tabId, injectToken: token, pendingInject: true, status: "running" });
  return tabId;
}

async function injectProfileFetcher(tabId, state) {
  const current = state.current;
  const job = {
    handle: current.handle,
    userId: current.userId,
    cursor: current.cursor,
    seenPostIds: current.recentPostIds || [],
    pagesFetched: current.pagesFetched || 0,
    pageDelayMs: Math.max(2, state.pageDelaySec) * 1000,
    runToken: state.injectToken,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= PROFILE_INJECT_ATTEMPTS; attempt++) {
    try {
      // executeScript cannot pass arguments to a `files` injection, so the job is seeded
      // into the isolated world first — both injections share that world's `window`.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (seed) => {
          window.__IG_JOB__ = seed;
          window.__IG_STOP__ = false;
        },
        args: [job],
      });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-ig-fetch.js"] });
      return true;
    } catch (e) {
      lastError = e;
      if (attempt < PROFILE_INJECT_ATTEMPTS) await profileSleep(1500 * attempt);
    }
  }

  await enterProfilePause(
    "injection_failed",
    'Scraper "@' +
      current.handle +
      '" pe chal nahi paaya ' +
      PROFILE_INJECT_ATTEMPTS +
      " koshish ke baad (" +
      (lastError && lastError.message ? lastError.message : "unknown") +
      "). Tab check karke Resume dabao."
  );
  return false;
}

// Best-effort: tells a live content-script loop to stop before its next request.
async function signalContentStop(tabId) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.__IG_STOP__ = true;
      },
    });
  } catch (e) {
    // Tab closed or navigated away — the loop is already gone.
  }
}

// --------------------------------------------------------------------- panel commands

async function startProfileRun(msg) {
  const accounts = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of Array.isArray(msg.accounts) ? msg.accounts : []) {
    if (typeof raw !== "string" || !raw.trim()) continue; // blank lines are not "skipped"
    const handle = normalizeProfileHandle(raw);
    if (!handle) {
      skipped += 1;
      continue;
    }
    if (seen.has(handle)) continue;
    seen.add(handle);
    accounts.push(handle);
  }

  if (!accounts.length) {
    await setProfileState({
      status: "idle",
      lastEvent: "Koi sahi profile URL/handle nahi mila — kuch bhi start nahi kiya",
    });
    return;
  }

  await chrome.alarms.clear(PROFILE_ALARM);
  chrome.notifications.clear(PROFILE_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await dropAllPostShards();

  const pageDelaySec = Math.max(2, Number(msg.pageDelaySec) || 3);
  const accountDelaySec = Math.max(3, Number(msg.accountDelaySec) || 8);

  const fresh = {
    ...defaultProfileState(),
    status: "running",
    phase: "resolving",
    accounts,
    pageDelaySec,
    accountDelaySec,
    current: defaultCurrentAccount(accounts[0]),
    totals: { accounts: accounts.length, accountsDone: 0, postsFetched: 0 },
    lastEvent:
      "Start: @" + accounts[0] + (skipped ? " (" + skipped + " line skip ki — sirf profile URL chalega)" : ""),
    updatedAt: Date.now(),
  };
  fresh.log = [fresh.lastEvent];
  await chrome.storage.local.set({ [PROFILE_STATE_KEY]: fresh });

  let tabId;
  try {
    tabId = await openProfileTab(fresh, accounts[0]);
  } catch (e) {
    await setProfileState({
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

async function resumeProfileRun() {
  const state = await getProfileState();
  if (state.status !== "paused" && state.status !== "stopped") return;
  if (!state.accounts.length || state.accountIndex >= state.accounts.length) return;

  if (state.pauseReason === "rate_limit" && Date.now() < state.backoffUntilTs) {
    const secondsLeft = Math.ceil((state.backoffUntilTs - Date.now()) / 1000);
    await setProfileState({ lastEvent: "Abhi " + secondsLeft + "s aur ruko — rate limit cool-down" });
    return;
  }

  chrome.notifications.clear(PROFILE_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });

  const handle = state.accounts[state.accountIndex];
  await setProfileState({
    pauseReason: "",
    phase: state.current.userId ? "paginating" : "resolving",
    lastEvent:
      "Resume @" + handle + (state.current.postsCount ? " — " + state.current.postsCount + " posts se aage" : ""),
  });

  const refreshed = await getProfileState();
  await openProfileTab(refreshed, handle);
}

async function stopProfileRun() {
  const state = await getProfileState();
  await chrome.alarms.clear(PROFILE_ALARM);
  chrome.notifications.clear(PROFILE_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalContentStop(state.tabId);
  await setProfileState({
    status: "stopped",
    phase: "",
    pendingInject: false,
    lastEvent: "Run rok diya — jitna data aaya woh safe hai",
  });
}

async function resetProfileRun() {
  const state = await getProfileState();
  await chrome.alarms.clear(PROFILE_ALARM);
  chrome.notifications.clear(PROFILE_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalContentStop(state.tabId);
  await dropAllPostShards();
  await chrome.storage.local.set({ [PROFILE_STATE_KEY]: defaultProfileState() });
}

// Lets the user grab whatever the current account has so far, mid-run.
async function downloadCurrentProfile() {
  const state = await getProfileState();
  if (!state.current.handle || !state.current.profile) {
    await setProfileState({ lastEvent: "Abhi kuch download karne layak nahi hai" });
    return;
  }
  const result = await saveAccountFile(state, {
    complete: false,
    reason: "partial: " + (state.pauseReason || state.status),
  });
  await setProfileState({
    lastEvent: result.ok
      ? "Partial file download: " + safeHandleFilename(state.current.handle)
      : "Download fail hua — " + result.error,
  });
}

// ------------------------------------------------------- content-script report handlers

async function handleMeta(msg) {
  const state = await getProfileState();
  if (!isLiveReport(state, msg)) return { ok: false, abort: true };

  const current = { ...state.current, userId: msg.userId, profile: msg.profile, startedAt: Date.now() };

  if (!msg.readable) {
    // Private and not followed: the profile is real data worth keeping, the posts simply
    // are not reachable. Save what we have and move on rather than pausing the whole run.
    const withProfile = await setProfileState({
      current,
      phase: "downloading",
      lastEvent: "@" + current.handle + " private hai — sirf profile save kar rahe hain",
    });
    const result = await saveAccountFile(withProfile, { complete: false, reason: "private" });
    await dropPostShards(current.shardKeys);
    const after = await getProfileState();
    await advanceProfileAccount(after, {
      complete: false,
      reason: result.ok ? "private" : "private (download fail: " + result.error + ")",
    });
    return { ok: true };
  }

  await setProfileState({
    current,
    phase: "paginating",
    lastEvent: "@" + current.handle + " mila — " + (msg.profile.posts_count || 0) + " posts reported",
  });
  return { ok: true };
}

async function handlePage(msg) {
  const state = await getProfileState();
  if (!isLiveReport(state, msg)) return { ok: false, abort: true };

  const posts = Array.isArray(msg.posts) ? msg.posts : [];
  const current = { ...state.current };

  if (posts.length) {
    const seq = current.shardSeq;
    let key;
    try {
      key = await appendPostShard(current.handle, seq, posts);
    } catch (e) {
      // Almost always the storage quota. Stop cleanly with the shards already banked.
      await enterProfilePause(
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
      -PROFILE_RECENT_IDS_CAP
    );
  }

  current.cursor = msg.nextCursor || null;
  current.moreAvailable = !!msg.moreAvailable;
  current.pagesFetched = (Number(msg.pageIndex) || 0) + 1;
  current.source = current.source ? mergeSource(current.source, msg.source) : msg.source || "";
  if (msg.userId && !current.userId) current.userId = String(msg.userId);

  await setProfileState({
    current,
    phase: "paginating",
    // A page that lands is proof the rate limit has cleared.
    retryCount: 0,
    backoffUntilTs: 0,
    totals: { ...state.totals, postsFetched: state.totals.postsFetched + posts.length },
    lastEvent:
      "@" + current.handle + " p" + current.pagesFetched + ": +" + posts.length + " posts (kul " + current.postsCount + ")",
  });
  return { ok: true };
}

// Records every source that contributed, so a file that fell back mid-crawl says so.
function mergeSource(existing, incoming) {
  if (!incoming) return existing;
  const parts = existing.split("+");
  if (parts.includes(incoming)) return existing;
  return existing + "+" + incoming;
}

async function handleDone(msg) {
  const state = await getProfileState();
  if (!isLiveReport(state, msg)) return { ok: false, abort: true };

  const capped = !!msg.capped;
  const current = { ...state.current, capped };
  const withFlag = await setProfileState({
    current,
    phase: "downloading",
    lastEvent:
      "@" +
      current.handle +
      " complete — " +
      current.postsCount +
      " posts" +
      (capped ? " (page cap lag gaya, poora nahi hai)" : ""),
  });

  const result = await saveAccountFile(withFlag, {
    complete: !capped,
    reason: capped ? "hard page cap reached" : null,
  });

  if (!result.ok) {
    // Shards are intentionally left in place so Resume can retry the save without
    // re-crawling the account.
    await enterProfilePause(
      "download_failed",
      "@" + current.handle + " ka JSON save nahi hua (" + result.error + ") — Resume se dobara try karo."
    );
    return { ok: false, abort: true };
  }

  await dropPostShards(current.shardKeys);
  await setProfileState({ lastEvent: "Download: " + safeHandleFilename(current.handle) });

  const after = await getProfileState();
  await advanceProfileAccount(after, { complete: !capped, reason: capped ? "capped" : null });
  return { ok: true };
}

// Reasons that are about *this account's data* rather than our access — skip and carry on.
const PROFILE_SKIP_REASONS = new Set(["not_found"]);

const PROFILE_PAUSE_MESSAGES = {
  login_wall: "Instagram pe login nahi ho — us tab me login karo, phir Resume dabao.",
  forbidden: "Instagram ne request block ki (403). Thoda ruk ke Resume karo.",
  rate_limit: "Rate limit lag gaya — kuch minute ruko, phir Resume.",
  challenge: "Instagram ne verification maanga — tab me clear karke Resume dabao.",
  network: "Network gir gaya — internet check karke Resume dabao.",
  endpoint_shape: "Instagram ne apni API badal di lagti hai — fallback bhi kaam nahi kiya.",
  wrong_origin: "Tab instagram.com pe nahi tha — Resume se dobara khol ke try karo.",
};

async function handleError(msg) {
  const state = await getProfileState();
  if (!isLiveReport(state, msg)) return { ok: false, abort: true };

  const reason = msg.reason || "endpoint_shape";
  const handle = state.current.handle;

  if (PROFILE_SKIP_REASONS.has(reason)) {
    await setProfileState({ lastEvent: "@" + handle + " nahi mila — skip kar diya" });
    await dropPostShards(state.current.shardKeys);
    const after = await getProfileState();
    await advanceProfileAccount(after, { complete: false, reason: "not_found" });
    return { ok: true, abort: true };
  }

  // A fetch that ran on the wrong origin means the tab hadn't settled on the profile yet.
  // One silent re-navigation heals that; a second one is a real problem worth pausing on.
  if (reason === "wrong_origin" && !state.current.originRetried) {
    await setProfileState({
      current: { ...state.current, originRetried: true },
      lastEvent: "Tab galat page pe tha — dobara khol rahe hain @" + handle,
    });
    const refreshed = await getProfileState();
    await openProfileTab(refreshed, handle);
    return { ok: true, abort: true };
  }

  const base = PROFILE_PAUSE_MESSAGES[reason] || "Ruk gaye — " + reason;
  const detail = msg.detail ? " [" + String(msg.detail).slice(0, 120) + "]" : "";
  const httpPart = msg.httpStatus ? " (HTTP " + msg.httpStatus + ")" : "";
  await enterProfilePause(reason, "@" + handle + ": " + base + httpPart + detail);
  return { ok: false, abort: true };
}

// Guards against a stale content-script loop reporting into a run that has moved on —
// after a Stop, a Reset, or once the worker has advanced to the next account.
function isLiveReport(state, msg) {
  if (state.status !== "running") return false;
  if (!state.current.handle) return false;
  return msg.handle === state.current.handle;
}

// ----------------------------------------------------------------------- event wiring

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // Panel commands: same convention as the Google side — always answer with full state.
  if (msg.type.startsWith("PROFILE_")) {
    queueProfileTask(async () => {
      switch (msg.type) {
        case "PROFILE_START":
          await startProfileRun(msg);
          break;
        case "PROFILE_RESUME":
          await resumeProfileRun();
          break;
        case "PROFILE_STOP":
          await stopProfileRun();
          break;
        case "PROFILE_RESET":
          await resetProfileRun();
          break;
        case "PROFILE_DOWNLOAD_CURRENT":
          await downloadCurrentProfile();
          break;
        default: // PROFILE_GET_STATE and anything unknown just read the state back
          break;
      }
    })
      .catch(() => undefined)
      .then(async () => {
        sendResponse(await getProfileState());
      });
    return true;
  }

  // Content-script reports.
  if (msg.type.startsWith("IG_")) {
    queueProfileTask(async () => {
      switch (msg.type) {
        case "IG_META":
          return handleMeta(msg);
        case "IG_PAGE":
          return handlePage(msg);
        case "IG_DONE":
          return handleDone(msg);
        case "IG_ERROR":
          return handleError(msg);
        case "IG_NOTE":
          await setProfileState({ lastEvent: msg.detail || "" });
          return { ok: true };
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

  return false; // not ours — let background.js answer it
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  queueProfileTask(async () => {
    const state = await getProfileState();
    if (state.status !== "running" || tabId !== state.tabId || !state.pendingInject) return;

    const url = tab && tab.url ? tab.url : "";
    if (!/^https:\/\/(www\.)?instagram\.com\//i.test(url)) {
      // Chrome fires `complete` for about:blank on a fresh tab before the real navigation.
      // Waiting for the instagram.com load is correct; a genuine wrong-origin landing is
      // caught by the content script and reported as wrong_origin.
      return;
    }

    await setProfileState({ pendingInject: false });
    const refreshed = await getProfileState();
    await injectProfileFetcher(tabId, refreshed);
  }).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PROFILE_ALARM) return;
  queueProfileTask(async () => {
    const state = await getProfileState();
    if (state.status !== "waiting_delay") return;
    const handle = state.accounts[state.accountIndex];
    if (!handle) return;
    await setProfileState({ phase: "resolving", lastEvent: "@" + handle + " khol rahe hain" });
    const refreshed = await getProfileState();
    try {
      await openProfileTab(refreshed, handle);
    } catch (e) {
      await setProfileState({
        status: "stopped",
        lastEvent: "Tab nahi khul paaya (" + (e && e.message ? e.message : "unknown") + ") — data safe hai",
      });
    }
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueProfileTask(async () => {
    const state = await getProfileState();
    if (state.tabId !== tabId || !profileStatusIsActive(state.status)) return;
    await chrome.alarms.clear(PROFILE_ALARM);
    chrome.action.setBadgeText({ text: "" });
    await setProfileState({
      status: "stopped",
      phase: "",
      pendingInject: false,
      tabId: null,
      lastEvent: "Tab band ho gaya — jitna data aaya woh safe hai, Resume se aage badha sakte ho",
    });
  }).catch(() => undefined);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== PROFILE_NOTIF_ID) return;
  queueProfileTask(async () => {
    const state = await getProfileState();
    if (state.tabId == null) return;
    try {
      await chrome.tabs.update(state.tabId, { active: true });
      const tab = await chrome.tabs.get(state.tabId);
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      // Tab already gone; nothing to focus.
    }
    chrome.notifications.clear(PROFILE_NOTIF_ID);
  }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  queueProfileTask(async () => {
    const state = await getProfileState();
    if (state.status !== "running" && state.status !== "waiting_delay") return;
    await setProfileState({
      status: "stopped",
      phase: "",
      pendingInject: false,
      tabId: null,
      lastEvent: "Browser restart hua — Resume dabao, wahin se aage chalega",
    });
  }).catch(() => undefined);
});
