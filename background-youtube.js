// Insta Handle Finder — YouTube channel/videos exporter (orchestrator).
//
// Third job runner in the same service worker, and deliberately isolated the same way the
// Instagram one is: its own storage key, its own tab, its own alarm and its own message
// namespace, so no two runners can corrupt each other's state.
//
// It DOES share one thing with background-profiles.js on purpose — downloadJson() and the
// offscreen document behind it. Two offscreen managers in one worker would fight over the
// single document Chrome allows, so the Instagram file owns it and this one calls into it.
// (background.js imports that file first.)
//
// Division of labour: this file owns *which channel* and *what to keep*; the injected
// content-yt-fetch.js owns *how to page through one channel*, because a paginated crawl
// outlives an MV3 worker but not the tab it runs in.

const YT_STATE_KEY = "youtubeRunState";
const YT_SHARD_PREFIX = "ytVideos:";
const YT_ALARM = "youtubeNextChannel";
const YT_NOTIF_ID = "youtube-pause";

const YT_INJECT_ATTEMPTS = 3;
const YT_RATE_LIMIT_BASE_MS = 60 * 1000;
const YT_RATE_LIMIT_MAX_MS = 15 * 60 * 1000;
// Bounded in-state dedupe guard. The authoritative dedupe happens at assembly time over
// every shard, so this only has to catch the common overlap-on-resume case cheaply.
const YT_RECENT_IDS_CAP = 500;

const YT_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YT_HANDLE_RE = /^[A-Za-z0-9._-]{3,30}$/;
const YT_LEGACY_NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
// Path prefixes that are pages, not channels — a watch link is never a channel URL.
const YT_NON_CHANNEL_ROOTS = new Set([
  "watch", "shorts", "playlist", "results", "feed", "hashtag", "embed", "live",
  "clip", "post", "premium", "gaming", "music", "account", "reporthistory", "s", "t",
]);
// Tab suffixes that may trail a channel URL and say nothing about which channel it is.
const YT_TAB_SEGMENTS = new Set([
  "videos", "shorts", "streams", "live", "playlists", "community", "posts", "about",
  "featured", "podcasts", "releases", "store", "channels", "search", "membership",
]);

// ---------------------------------------------------------------------- state helpers

function defaultYoutubeState() {
  return {
    status: "idle", // idle | running | waiting_delay | paused | stopped | done
    phase: "", // "" | resolving | paginating | downloading
    pauseReason: "",
    channels: [],
    channelIndex: 0,
    tabId: null,
    pageDelaySec: 3,
    channelDelaySec: 8,
    videoDelayMs: 700,
    fetchDetails: true,
    pendingInject: false,
    injectToken: 0,
    current: defaultCurrentChannel(""),
    completed: [], // [{ channelKey, videoCount, complete, reason, source }]
    retryCount: 0,
    backoffUntilTs: 0,
    totals: { channels: 0, channelsDone: 0, videosFetched: 0 },
    lastEvent: "",
    log: [],
    updatedAt: 0,
  };
}

function defaultCurrentChannel(channelKey) {
  return {
    channelKey: channelKey || "",
    channelId: null,
    profile: null,
    cursor: null, // continuation token for the tab we are inside
    tabIndex: 0, // 0 videos, 1 live — mirrors CHANNEL_TABS in the content script
    tabLabel: "",
    moreAvailable: true,
    recentVideoIds: [],
    shardKeys: [],
    shardSeq: 0,
    pagesFetched: 0,
    videosCount: 0,
    source: "",
    capped: false,
    originRetried: false,
    startedAt: 0,
  };
}

async function getYoutubeState() {
  const stored = await chrome.storage.local.get(YT_STATE_KEY);
  return stored[YT_STATE_KEY] || defaultYoutubeState();
}

async function setYoutubeState(patch) {
  const current = await getYoutubeState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.lastEvent) {
    next.log = [...(current.log || []), patch.lastEvent].slice(-50);
  }
  await chrome.storage.local.set({ [YT_STATE_KEY]: next });
  return next;
}

// Every handler runs through this queue. Reads and writes of the run state are
// read-modify-write, and page reports can interleave with a Stop from the panel — without
// serialising them, one update silently overwrites the other.
let youtubeStateChain = Promise.resolve();

function queueYoutubeTask(task) {
  const run = youtubeStateChain.then(task, task);
  youtubeStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function youtubeSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ channel utilities

// Accepts a channel URL (/@handle, /channel/UC..., /c/Name, /user/Name, with or without a
// trailing tab), an @handle, a bare handle or a raw UC id. Rejects watch/shorts/playlist
// links and anything that does not name a channel. Mirrors normalizeChannel() in
// popup-youtube.js.
//
// Returns a canonical key: "@handle" | "UC..." | "c/Name" | "user/Name".
function normalizeChannelKey(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value) || /youtube\.com/i.test(value) || /^youtu\.be\b/i.test(value)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
    } catch (e) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host !== "youtube.com") return null; // youtu.be is only ever a video link

    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch (e) {
          return part;
        }
      });
    if (!parts.length) return null;

    const first = parts[0];
    if (YT_NON_CHANNEL_ROOTS.has(first.toLowerCase())) return null;
    if (first.startsWith("@")) return validHandleKey(first.slice(1));
    if (first === "channel") return YT_CHANNEL_ID_RE.test(parts[1] || "") ? parts[1] : null;
    if (first === "c" || first === "user") {
      return YT_LEGACY_NAME_RE.test(parts[1] || "") ? first + "/" + parts[1] : null;
    }
    // Bare /Name legacy channel URL — but only when nothing else follows that would make
    // it a different kind of page.
    if (parts.length > 1 && !YT_TAB_SEGMENTS.has(String(parts[1]).toLowerCase())) return null;
    return validHandleKey(first);
  }

  if (value.startsWith("@")) return validHandleKey(value.slice(1).split(/[/?#]/)[0]);
  if (YT_CHANNEL_ID_RE.test(value)) return value;
  return validHandleKey(value.split(/[/?#\s]/)[0]);
}

function validHandleKey(handle) {
  const value = String(handle || "").trim();
  if (!value || !YT_HANDLE_RE.test(value)) return null;
  if (YT_TAB_SEGMENTS.has(value.toLowerCase())) return null;
  return "@" + value;
}

function channelUrlFor(channelKey) {
  if (channelKey.startsWith("@")) {
    return "https://www.youtube.com/@" + encodeURIComponent(channelKey.slice(1));
  }
  if (YT_CHANNEL_ID_RE.test(channelKey)) {
    return "https://www.youtube.com/channel/" + channelKey;
  }
  const [root, name] = channelKey.split("/");
  return "https://www.youtube.com/" + root + "/" + encodeURIComponent(name || "");
}

// The tab we actually drive. /videos is the most predictable channel page, and the
// profile metadata (including the About panel) rides along with any channel tab.
function channelPageUrlFor(channelKey) {
  return channelUrlFor(channelKey) + "/videos";
}

// Strips anything that could escape the download directory or create a hidden file.
function safeChannelFilename(channelKey) {
  const base = String(channelKey || "")
    .replace(/^@/, "")
    .replace(/\//g, "_")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 60);
  return (base || "channel") + ".json";
}

// ----------------------------------------------------------------------- video shards

// Videos are written to append-only shards instead of one growing array on the run state.
// Rewriting a 15k-video array on every page would be quadratic in write volume and would
// blow the storage quota long before the crawl finished.
async function appendVideoShard(channelKey, seq, videos) {
  const key = YT_SHARD_PREFIX + safeChannelFilename(channelKey).replace(/\.json$/, "") + ":" + seq;
  await chrome.storage.local.set({ [key]: videos });
  return key;
}

async function readVideoShards(shardKeys) {
  if (!shardKeys || !shardKeys.length) return [];
  const stored = await chrome.storage.local.get(shardKeys);
  const ordered = [...shardKeys].sort((a, b) => {
    const seqA = Number(a.slice(a.lastIndexOf(":") + 1));
    const seqB = Number(b.slice(b.lastIndexOf(":") + 1));
    return seqA - seqB;
  });

  const seen = new Set();
  const videos = [];
  for (const key of ordered) {
    const shard = stored[key];
    if (!Array.isArray(shard)) continue;
    for (const video of shard) {
      if (!video || video.id == null || seen.has(video.id)) continue;
      seen.add(video.id);
      videos.push(video);
    }
  }
  return videos;
}

async function dropVideoShards(shardKeys) {
  if (!shardKeys || !shardKeys.length) return;
  try {
    await chrome.storage.local.remove(shardKeys);
  } catch (e) {
    // Leftover shards only waste space; never let cleanup fail a completed channel.
  }
}

// Sweeps stale shards. Prefers getKeys() so a half-finished crawl is not pulled into
// memory just to learn its key names; falls back to the keys the run state tracks.
async function dropAllVideoShards() {
  let keys = [];
  if (typeof chrome.storage.local.getKeys === "function") {
    const all = await chrome.storage.local.getKeys();
    keys = all.filter((key) => key.startsWith(YT_SHARD_PREFIX));
  } else {
    const state = await getYoutubeState();
    keys = (state.current && state.current.shardKeys) || [];
  }
  if (keys.length) await chrome.storage.local.remove(keys);
}

// ----------------------------------------------------------------------- JSON assembly

// Same envelope as the Instagram exporter writes, with `videos` where that one has
// `posts`, so both files can be read by the same consumer with one field swap.
async function buildChannelJson(state, options) {
  const current = state.current;
  const videos = await readVideoShards(current.shardKeys);
  const complete = !!(options && options.complete);

  const payload = {
    handle: current.channelKey,
    profile_url: channelUrlFor(current.channelKey),
    fetched_at: new Date().toISOString(),
    source: current.source || "unknown",
    complete,
    incomplete_reason: complete ? null : (options && options.reason) || "incomplete",
    details_enabled: !!state.fetchDetails,
    profile: current.profile,
    videos_count_reported: current.profile ? current.profile.video_count : null,
    videos_collected: videos.length,
    videos,
  };

  return JSON.stringify(payload, null, 2);
}

// Writes one channel's file. Never throws into a caller mid-transition — a download
// failure becomes a pause the user can act on, with the shards left intact so Resume can
// try again without re-crawling.
async function saveChannelFile(state, options) {
  const channelKey = state.current.channelKey;
  try {
    const json = await buildChannelJson(state, options);
    // Shared with the Instagram exporter — see the header note.
    await downloadJson(safeChannelFilename(channelKey), json);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ run-state controls

function youtubeStatusIsActive(status) {
  return status === "running" || status === "waiting_delay" || status === "paused";
}

async function enterYoutubePause(reason, detail) {
  await chrome.alarms.clear(YT_ALARM);
  chrome.action.setBadgeText({ text: "⏸" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });

  const patch = { status: "paused", pauseReason: reason, pendingInject: false, lastEvent: detail };

  if (reason === "rate_limit" || reason === "bot_check") {
    const prior = await getYoutubeState();
    const retryCount = (prior.retryCount || 0) + 1;
    const waitMs = Math.min(
      YT_RATE_LIMIT_BASE_MS * Math.pow(2, retryCount - 1),
      YT_RATE_LIMIT_MAX_MS
    );
    patch.retryCount = retryCount;
    patch.backoffUntilTs = Date.now() + waitMs;
    patch.lastEvent = detail + " (" + Math.round(waitMs / 60000) + " min baad Resume kar sakte ho)";
  }

  await setYoutubeState(patch);

  chrome.notifications.create(YT_NOTIF_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "YouTube Exporter — Paused",
    message: patch.lastEvent,
    priority: 2,
    requireInteraction: true,
  });
}

async function finishYoutubeRun(state) {
  await chrome.alarms.clear(YT_ALARM);
  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#188038" });
  const done = state.totals.channelsDone;
  await setYoutubeState({
    status: "done",
    phase: "",
    pendingInject: false,
    lastEvent: "Sab channels ho gaye — " + done + "/" + state.channels.length + " file(s) download",
  });
}

// Records the outcome of the channel we just left and moves to the next one, or finishes.
async function advanceYoutubeChannel(state, outcome) {
  const completed = [
    ...state.completed,
    {
      channelKey: state.current.channelKey,
      videoCount: state.current.videosCount,
      complete: !!outcome.complete,
      reason: outcome.reason || null,
      source: state.current.source || null,
    },
  ];

  const channelIndex = state.channelIndex + 1;
  const totals = {
    ...state.totals,
    channelsDone: state.totals.channelsDone + (outcome.complete ? 1 : 0),
  };

  if (channelIndex >= state.channels.length) {
    const next = await setYoutubeState({
      completed,
      totals,
      channelIndex,
      phase: "",
      current: defaultCurrentChannel(""),
    });
    await finishYoutubeRun(next);
    return;
  }

  const nextChannel = state.channels[channelIndex];
  await setYoutubeState({
    completed,
    totals,
    channelIndex,
    status: "waiting_delay",
    phase: "",
    pauseReason: "",
    pendingInject: false,
    current: defaultCurrentChannel(nextChannel),
    lastEvent: "Agla channel: " + nextChannel,
  });
  scheduleYoutubeAlarm(state.channelDelaySec);
}

function scheduleYoutubeAlarm(baseSeconds) {
  const jitter = baseSeconds * (Math.random() * 0.4 - 0.2); // +/-20%, same as the other runners
  const delaySeconds = Math.max(1, baseSeconds + jitter);
  chrome.alarms.create(YT_ALARM, { delayInMinutes: delaySeconds / 60 });
}

// ------------------------------------------------------------------------- tab driving

// Navigates the driven tab to a channel and arms the injection that fires once the page
// finishes loading. Re-creates the tab if the user closed it.
async function openYoutubeTab(state, channelKey) {
  const url = channelPageUrlFor(channelKey);
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

  await setYoutubeState({ tabId, injectToken: token, pendingInject: true, status: "running" });
  return tabId;
}

async function injectYoutubeFetcher(tabId, state) {
  const current = state.current;
  const job = {
    channelKey: current.channelKey,
    channelId: current.channelId,
    cursor: current.cursor,
    tabIndex: current.tabIndex || 0,
    seenVideoIds: current.recentVideoIds || [],
    pagesFetched: current.pagesFetched || 0,
    pageDelayMs: Math.max(2, state.pageDelaySec) * 1000,
    videoDelayMs: Math.max(200, Number(state.videoDelayMs) || 700),
    fetchDetails: state.fetchDetails !== false,
    runToken: state.injectToken,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= YT_INJECT_ATTEMPTS; attempt++) {
    try {
      // executeScript cannot pass arguments to a `files` injection, so the job is seeded
      // into the isolated world first — both injections share that world's `window`.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (seed) => {
          window.__YT_JOB__ = seed;
          window.__YT_STOP__ = false;
        },
        args: [job],
      });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-yt-fetch.js"] });
      return true;
    } catch (e) {
      lastError = e;
      if (attempt < YT_INJECT_ATTEMPTS) await youtubeSleep(1500 * attempt);
    }
  }

  await enterYoutubePause(
    "injection_failed",
    'Scraper "' +
      current.channelKey +
      '" pe chal nahi paaya ' +
      YT_INJECT_ATTEMPTS +
      " koshish ke baad (" +
      (lastError && lastError.message ? lastError.message : "unknown") +
      "). Tab check karke Resume dabao."
  );
  return false;
}

// Best-effort: tells a live content-script loop to stop before its next request.
async function signalYoutubeStop(tabId) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.__YT_STOP__ = true;
      },
    });
  } catch (e) {
    // Tab closed or navigated away — the loop is already gone.
  }
}

// --------------------------------------------------------------------- panel commands

async function startYoutubeRun(msg) {
  const channels = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of Array.isArray(msg.channels) ? msg.channels : []) {
    if (typeof raw !== "string" || !raw.trim()) continue; // blank lines are not "skipped"
    const channelKey = normalizeChannelKey(raw);
    if (!channelKey) {
      skipped += 1;
      continue;
    }
    const dedupeKey = channelKey.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    channels.push(channelKey);
  }

  if (!channels.length) {
    await setYoutubeState({
      status: "idle",
      lastEvent: "Koi sahi channel URL/handle nahi mila — kuch bhi start nahi kiya",
    });
    return;
  }

  await chrome.alarms.clear(YT_ALARM);
  chrome.notifications.clear(YT_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await dropAllVideoShards();

  const pageDelaySec = Math.max(2, Number(msg.pageDelaySec) || 3);
  const channelDelaySec = Math.max(3, Number(msg.channelDelaySec) || 8);
  const videoDelayMs = Math.max(200, Number(msg.videoDelayMs) || 700);
  const fetchDetails = msg.fetchDetails !== false;

  const fresh = {
    ...defaultYoutubeState(),
    status: "running",
    phase: "resolving",
    channels,
    pageDelaySec,
    channelDelaySec,
    videoDelayMs,
    fetchDetails,
    current: defaultCurrentChannel(channels[0]),
    totals: { channels: channels.length, channelsDone: 0, videosFetched: 0 },
    lastEvent:
      "Start: " +
      channels[0] +
      (skipped ? " (" + skipped + " line skip ki — sirf channel URL chalega)" : ""),
    updatedAt: Date.now(),
  };
  fresh.log = [fresh.lastEvent];
  await chrome.storage.local.set({ [YT_STATE_KEY]: fresh });

  let tabId;
  try {
    tabId = await openYoutubeTab(fresh, channels[0]);
  } catch (e) {
    await setYoutubeState({
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

async function resumeYoutubeRun() {
  const state = await getYoutubeState();
  if (state.status !== "paused" && state.status !== "stopped") return;
  if (!state.channels.length || state.channelIndex >= state.channels.length) return;

  if (
    (state.pauseReason === "rate_limit" || state.pauseReason === "bot_check") &&
    Date.now() < state.backoffUntilTs
  ) {
    const secondsLeft = Math.ceil((state.backoffUntilTs - Date.now()) / 1000);
    await setYoutubeState({ lastEvent: "Abhi " + secondsLeft + "s aur ruko — cool-down chal raha hai" });
    return;
  }

  chrome.notifications.clear(YT_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });

  const channelKey = state.channels[state.channelIndex];
  await setYoutubeState({
    pauseReason: "",
    phase: state.current.channelId ? "paginating" : "resolving",
    lastEvent:
      "Resume " +
      channelKey +
      (state.current.videosCount ? " — " + state.current.videosCount + " videos se aage" : ""),
  });

  const refreshed = await getYoutubeState();
  await openYoutubeTab(refreshed, channelKey);
}

async function stopYoutubeRun() {
  const state = await getYoutubeState();
  await chrome.alarms.clear(YT_ALARM);
  chrome.notifications.clear(YT_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalYoutubeStop(state.tabId);
  await setYoutubeState({
    status: "stopped",
    phase: "",
    pendingInject: false,
    lastEvent: "Run rok diya — jitna data aaya woh safe hai",
  });
}

async function resetYoutubeRun() {
  const state = await getYoutubeState();
  await chrome.alarms.clear(YT_ALARM);
  chrome.notifications.clear(YT_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalYoutubeStop(state.tabId);
  await dropAllVideoShards();
  await chrome.storage.local.set({ [YT_STATE_KEY]: defaultYoutubeState() });
}

// Lets the user grab whatever the current channel has so far, mid-run.
async function downloadCurrentYoutube() {
  const state = await getYoutubeState();
  if (!state.current.channelKey || !state.current.profile) {
    await setYoutubeState({ lastEvent: "Abhi kuch download karne layak nahi hai" });
    return;
  }
  const result = await saveChannelFile(state, {
    complete: false,
    reason: "partial: " + (state.pauseReason || state.status),
  });
  await setYoutubeState({
    lastEvent: result.ok
      ? "Partial file download: " + safeChannelFilename(state.current.channelKey)
      : "Download fail hua — " + result.error,
  });
}

// ------------------------------------------------------- content-script report handlers

async function handleYoutubeMeta(msg) {
  const state = await getYoutubeState();
  if (!isLiveYoutubeReport(state, msg)) return { ok: false, abort: true };

  const current = {
    ...state.current,
    channelId: msg.channelId,
    profile: msg.profile,
    startedAt: Date.now(),
  };

  await setYoutubeState({
    current,
    phase: "paginating",
    lastEvent:
      current.channelKey +
      " mila — " +
      ((msg.profile && msg.profile.video_count) || 0) +
      " videos reported",
  });
  return { ok: true };
}

// The content script announces each channel tab it starts, so a Resume knows whether it
// still owes Shorts and Live rather than restarting from Videos.
async function handleYoutubeTab(msg) {
  const state = await getYoutubeState();
  if (!isLiveYoutubeReport(state, msg)) return { ok: false, abort: true };

  const tabIndex = Number(msg.tabIndex) || 0;
  const current = { ...state.current, tabIndex, tabLabel: msg.label || "" };
  // Only a *new* tab clears the cursor; re-announcing the tab we resumed into must not
  // throw away the continuation we are about to use.
  if (tabIndex !== state.current.tabIndex) current.cursor = null;

  await setYoutubeState({
    current,
    phase: "paginating",
    lastEvent: current.channelKey + " — " + (msg.label || "tab " + tabIndex) + " shuru",
  });
  return { ok: true };
}

async function handleYoutubePage(msg) {
  const state = await getYoutubeState();
  if (!isLiveYoutubeReport(state, msg)) return { ok: false, abort: true };

  const videos = Array.isArray(msg.videos) ? msg.videos : [];
  const current = { ...state.current };

  if (videos.length) {
    const seq = current.shardSeq;
    let key;
    try {
      key = await appendVideoShard(current.channelKey, seq, videos);
    } catch (e) {
      // Almost always the storage quota. Stop cleanly with the shards already banked.
      await enterYoutubePause(
        "storage_full",
        "Storage bhar gaya (" +
          (e && e.message ? e.message : "quota") +
          ") — 'Download partial' se file nikaal ke Reset karo."
      );
      return { ok: false, abort: true };
    }
    current.shardKeys = [...current.shardKeys, key];
    current.shardSeq = seq + 1;
    current.videosCount += videos.length;
    current.recentVideoIds = [...current.recentVideoIds, ...videos.map((video) => video.id)].slice(
      -YT_RECENT_IDS_CAP
    );
  }

  current.cursor = msg.nextCursor || null;
  current.moreAvailable = !!msg.moreAvailable;
  current.tabIndex = Number(msg.tabIndex) || 0;
  current.pagesFetched = (Number(msg.pageIndex) || 0) + 1;
  current.source = current.source ? mergeYoutubeSource(current.source, msg.source) : msg.source || "";
  if (msg.channelId && !current.channelId) current.channelId = String(msg.channelId);

  await setYoutubeState({
    current,
    phase: "paginating",
    // A page that lands is proof the rate limit has cleared.
    retryCount: 0,
    backoffUntilTs: 0,
    totals: { ...state.totals, videosFetched: state.totals.videosFetched + videos.length },
    lastEvent:
      current.channelKey +
      " " +
      (current.tabLabel || "") +
      " p" +
      current.pagesFetched +
      ": +" +
      videos.length +
      " videos (kul " +
      current.videosCount +
      ")",
  });
  return { ok: true };
}

// Records every source that contributed, so a file that fell back mid-crawl says so.
function mergeYoutubeSource(existing, incoming) {
  if (!incoming) return existing;
  const parts = existing.split("+");
  if (parts.includes(incoming)) return existing;
  return existing + "+" + incoming;
}

async function handleYoutubeDone(msg) {
  const state = await getYoutubeState();
  if (!isLiveYoutubeReport(state, msg)) return { ok: false, abort: true };

  const capped = !!msg.capped;
  const current = { ...state.current, capped };
  const withFlag = await setYoutubeState({
    current,
    phase: "downloading",
    lastEvent:
      current.channelKey +
      " complete — " +
      current.videosCount +
      " videos" +
      (capped ? " (page cap lag gaya, poora nahi hai)" : ""),
  });

  const result = await saveChannelFile(withFlag, {
    complete: !capped,
    reason: capped ? "hard page cap reached" : null,
  });

  if (!result.ok) {
    // Shards are intentionally left in place so Resume can retry the save without
    // re-crawling the channel.
    await enterYoutubePause(
      "download_failed",
      current.channelKey + " ka JSON save nahi hua (" + result.error + ") — Resume se dobara try karo."
    );
    return { ok: false, abort: true };
  }

  await dropVideoShards(current.shardKeys);
  await setYoutubeState({ lastEvent: "Download: " + safeChannelFilename(current.channelKey) });

  const after = await getYoutubeState();
  await advanceYoutubeChannel(after, { complete: !capped, reason: capped ? "capped" : null });
  return { ok: true };
}

// Reasons that are about *this channel's data* rather than our access — skip and carry on.
const YT_SKIP_REASONS = new Set(["not_found"]);

const YT_PAUSE_MESSAGES = {
  login_wall: "Google/YouTube pe login nahi ho — us tab me login karo, phir Resume dabao.",
  forbidden: "YouTube ne request block ki (403). Thoda ruk ke Resume karo.",
  rate_limit: "Rate limit lag gaya — kuch minute ruko, phir Resume.",
  bot_check: "YouTube ne 'sign in to confirm' maanga — tab me clear karke Resume dabao.",
  consent_wall: "YouTube consent page aa gaya — tab me accept karke Resume dabao.",
  network: "Network gir gaya — internet check karke Resume dabao.",
  endpoint_shape: "YouTube ne apna layout badal diya lagta hai — fallback bhi kaam nahi kiya.",
  wrong_origin: "Tab youtube.com pe nahi tha — Resume se dobara khol ke try karo.",
};

async function handleYoutubeError(msg) {
  const state = await getYoutubeState();
  if (!isLiveYoutubeReport(state, msg)) return { ok: false, abort: true };

  const reason = msg.reason || "endpoint_shape";
  const channelKey = state.current.channelKey;

  if (YT_SKIP_REASONS.has(reason)) {
    await setYoutubeState({ lastEvent: channelKey + " nahi mila — skip kar diya" });
    await dropVideoShards(state.current.shardKeys);
    const after = await getYoutubeState();
    await advanceYoutubeChannel(after, { complete: false, reason: "not_found" });
    return { ok: true, abort: true };
  }

  // A fetch that ran on the wrong origin means the tab hadn't settled on the channel yet.
  // One silent re-navigation heals that; a second one is a real problem worth pausing on.
  if (reason === "wrong_origin" && !state.current.originRetried) {
    await setYoutubeState({
      current: { ...state.current, originRetried: true },
      lastEvent: "Tab galat page pe tha — dobara khol rahe hain " + channelKey,
    });
    const refreshed = await getYoutubeState();
    await openYoutubeTab(refreshed, channelKey);
    return { ok: true, abort: true };
  }

  const base = YT_PAUSE_MESSAGES[reason] || "Ruk gaye — " + reason;
  const detail = msg.detail ? " [" + String(msg.detail).slice(0, 120) + "]" : "";
  const httpPart = msg.httpStatus ? " (HTTP " + msg.httpStatus + ")" : "";
  await enterYoutubePause(reason, channelKey + ": " + base + httpPart + detail);
  return { ok: false, abort: true };
}

// Guards against a stale content-script loop reporting into a run that has moved on —
// after a Stop, a Reset, or once the worker has advanced to the next channel.
function isLiveYoutubeReport(state, msg) {
  if (state.status !== "running") return false;
  if (!state.current.channelKey) return false;
  return msg.channel === state.current.channelKey;
}

// ----------------------------------------------------------------------- event wiring

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // Panel commands: same convention as the other runners — always answer with full state.
  if (msg.type.startsWith("YOUTUBE_")) {
    queueYoutubeTask(async () => {
      switch (msg.type) {
        case "YOUTUBE_START":
          await startYoutubeRun(msg);
          break;
        case "YOUTUBE_RESUME":
          await resumeYoutubeRun();
          break;
        case "YOUTUBE_STOP":
          await stopYoutubeRun();
          break;
        case "YOUTUBE_RESET":
          await resetYoutubeRun();
          break;
        case "YOUTUBE_DOWNLOAD_CURRENT":
          await downloadCurrentYoutube();
          break;
        default: // YOUTUBE_GET_STATE and anything unknown just read the state back
          break;
      }
    })
      .catch(() => undefined)
      .then(async () => {
        sendResponse(await getYoutubeState());
      });
    return true;
  }

  // Content-script reports.
  if (msg.type.startsWith("YT_")) {
    queueYoutubeTask(async () => {
      switch (msg.type) {
        case "YT_META":
          return handleYoutubeMeta(msg);
        case "YT_TAB":
          return handleYoutubeTab(msg);
        case "YT_PAGE":
          return handleYoutubePage(msg);
        case "YT_DONE":
          return handleYoutubeDone(msg);
        case "YT_ERROR":
          return handleYoutubeError(msg);
        case "YT_NOTE": {
          // Guarded like every other report: a note from a loop that has already been
          // stopped would otherwise overwrite "Run rok diya" in the pause banner.
          const state = await getYoutubeState();
          if (!isLiveYoutubeReport(state, msg)) return { ok: false, abort: true };
          await setYoutubeState({ lastEvent: msg.detail || "" });
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
  queueYoutubeTask(async () => {
    const state = await getYoutubeState();
    if (state.status !== "running" || tabId !== state.tabId || !state.pendingInject) return;

    const url = tab && tab.url ? tab.url : "";
    if (!/^https:\/\/(www\.|m\.)?youtube\.com\//i.test(url)) {
      // Chrome fires `complete` for about:blank on a fresh tab before the real navigation,
      // so a non-http URL just means the real load has not happened yet.
      if (!/^https?:\/\//i.test(url)) return;

      // A committed load on another origin is YouTube redirecting us away — the EU consent
      // page, or a Google sign-in interstitial. Nothing will ever be injected there, so
      // without this the run would sit in "running" forever with no pause and no
      // notification, and the content script's own consent check could never fire.
      const consent = /(^|\.)consent\./i.test(url) || /\/consent/i.test(url);
      await enterYoutubePause(
        consent ? "consent_wall" : "wrong_origin",
        state.current.channelKey +
          ": " +
          (consent ? YT_PAUSE_MESSAGES.consent_wall : YT_PAUSE_MESSAGES.wrong_origin) +
          " [" +
          url.slice(0, 120) +
          "]"
      );
      return;
    }

    await setYoutubeState({ pendingInject: false });
    const refreshed = await getYoutubeState();
    await injectYoutubeFetcher(tabId, refreshed);
  }).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== YT_ALARM) return;
  queueYoutubeTask(async () => {
    const state = await getYoutubeState();
    if (state.status !== "waiting_delay") return;
    const channelKey = state.channels[state.channelIndex];
    if (!channelKey) return;
    await setYoutubeState({ phase: "resolving", lastEvent: channelKey + " khol rahe hain" });
    const refreshed = await getYoutubeState();
    try {
      await openYoutubeTab(refreshed, channelKey);
    } catch (e) {
      await setYoutubeState({
        status: "stopped",
        lastEvent: "Tab nahi khul paaya (" + (e && e.message ? e.message : "unknown") + ") — data safe hai",
      });
    }
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueYoutubeTask(async () => {
    const state = await getYoutubeState();
    if (state.tabId !== tabId || !youtubeStatusIsActive(state.status)) return;
    await chrome.alarms.clear(YT_ALARM);
    chrome.action.setBadgeText({ text: "" });
    await setYoutubeState({
      status: "stopped",
      phase: "",
      pendingInject: false,
      tabId: null,
      lastEvent: "Tab band ho gaya — jitna data aaya woh safe hai, Resume se aage badha sakte ho",
    });
  }).catch(() => undefined);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== YT_NOTIF_ID) return;
  queueYoutubeTask(async () => {
    const state = await getYoutubeState();
    if (state.tabId == null) return;
    try {
      await chrome.tabs.update(state.tabId, { active: true });
      const tab = await chrome.tabs.get(state.tabId);
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      // Tab already gone; nothing to focus.
    }
    chrome.notifications.clear(YT_NOTIF_ID);
  }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  queueYoutubeTask(async () => {
    const state = await getYoutubeState();
    if (state.status !== "running" && state.status !== "waiting_delay") return;
    await setYoutubeState({
      status: "stopped",
      phase: "",
      pendingInject: false,
      tabId: null,
      lastEvent: "Browser restart hua — Resume dabao, wahin se aage chalega",
    });
  }).catch(() => undefined);
});
