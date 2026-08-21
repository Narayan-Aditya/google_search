// Side panel logic for the YouTube channel exporter.
//
// Wrapped in an IIFE for the same reason popup-profiles.js is: popup.js and
// popup-profiles.js run in this same page and own a pile of top-level names, so keeping
// everything private here means the three features can never clobber each other.
//
// The mode switcher itself lives in popup-profiles.js — this file only renders its own
// section.

(function () {
  const channelsEl = document.getElementById("ytChannels");
  const pageDelayEl = document.getElementById("ytPageDelay");
  const channelDelayEl = document.getElementById("ytChannelDelay");
  const videoDelayEl = document.getElementById("ytVideoDelay");
  const detailsEl = document.getElementById("ytFullDetails");
  const delayWarningEl = document.getElementById("ytDelayWarning");
  const startBtn = document.getElementById("ytStartBtn");
  const stopBtn = document.getElementById("ytStopBtn");
  const resumeBtn = document.getElementById("ytResumeBtn");
  const pauseBanner = document.getElementById("ytPauseBanner");
  const pauseDetailEl = document.getElementById("ytPauseDetail");
  const statusLineEl = document.getElementById("ytStatusLine");
  const totalsLineEl = document.getElementById("ytTotalsLine");
  const completedEl = document.getElementById("ytCompleted");
  const logEl = document.getElementById("ytLog");
  const downloadBtn = document.getElementById("ytDownloadBtn");
  const resetBtn = document.getElementById("ytResetBtn");

  let channelsEdited = false;
  let settingsEdited = false;
  let countdownTimer = null;
  let lastState = null;

  // --------------------------------------------------------------------- input parsing

  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
  const HANDLE_RE = /^[A-Za-z0-9._-]{3,30}$/;
  const LEGACY_NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
  const NON_CHANNEL_ROOTS = new Set([
    "watch", "shorts", "playlist", "results", "feed", "hashtag", "embed", "live",
    "clip", "post", "premium", "gaming", "music", "account", "reporthistory", "s", "t",
  ]);
  const TAB_SEGMENTS = new Set([
    "videos", "shorts", "streams", "live", "playlists", "community", "posts", "about",
    "featured", "podcasts", "releases", "store", "channels", "search", "membership",
  ]);

  // Mirrors normalizeChannelKey() in background-youtube.js. Duplicated rather than shared
  // because there is no bundler here — the panel needs it for instant feedback, and the
  // worker re-validates anyway, so a drift can never produce a bad run.
  function normalizeChannel(raw) {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (!value) return null;

    if (/^https?:\/\//i.test(value) || /youtube\.com/i.test(value) || /^youtu\.be\b/i.test(value)) {
      let url;
      try {
        url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
      } catch (e) {
        return null;
      }
      const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
      if (host !== "youtube.com") return null;

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
      if (NON_CHANNEL_ROOTS.has(first.toLowerCase())) return null;
      if (first.startsWith("@")) return validHandle(first.slice(1));
      if (first === "channel") return CHANNEL_ID_RE.test(parts[1] || "") ? parts[1] : null;
      if (first === "c" || first === "user") {
        return LEGACY_NAME_RE.test(parts[1] || "") ? first + "/" + parts[1] : null;
      }
      if (parts.length > 1 && !TAB_SEGMENTS.has(String(parts[1]).toLowerCase())) return null;
      return validHandle(first);
    }

    if (value.startsWith("@")) return validHandle(value.slice(1).split(/[/?#]/)[0]);
    if (CHANNEL_ID_RE.test(value)) return value;
    return validHandle(value.split(/[/?#\s]/)[0]);
  }

  function validHandle(handle) {
    const value = String(handle || "").trim();
    if (!value || !HANDLE_RE.test(value)) return null;
    if (TAB_SEGMENTS.has(value.toLowerCase())) return null;
    return "@" + value;
  }

  // Returns { channels, skipped } so the user is told what got dropped instead of silently
  // starting a shorter run than they asked for.
  function parseChannels(text) {
    const seen = new Set();
    const channels = [];
    let skipped = 0;
    for (const raw of text.split(/[\n,]+/)) {
      if (!raw.trim()) continue;
      const channelKey = normalizeChannel(raw);
      if (!channelKey) {
        skipped += 1;
        continue;
      }
      const dedupeKey = channelKey.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      channels.push(channelKey);
    }
    return { channels, skipped };
  }

  // ------------------------------------------------------------------------- rendering

  const STATUS_LABELS = {
    idle: "Idle",
    stopped: "Stopped",
    done: "Done",
    paused: "Paused — dhyan chahiye",
  };

  const PHASE_LABELS = {
    resolving: "channel nikaal rahe hain",
    paginating: "videos nikaal rahe hain",
    downloading: "file save ho rahi hai",
  };

  function statusText(state) {
    const total = state.channels ? state.channels.length : 0;
    const position = Math.min(state.channelIndex + 1, total || 1);
    const channelKey = state.current && state.current.channelKey ? state.current.channelKey : "-";

    if (state.status === "running") {
      const phase = PHASE_LABELS[state.phase] || "chal raha hai";
      const tab =
        state.phase === "paginating" && state.current.tabLabel ? " " + state.current.tabLabel : "";
      const pages =
        state.phase === "paginating" && state.current.pagesFetched
          ? ", page " + state.current.pagesFetched
          : "";
      return "Channel " + position + "/" + total + " " + channelKey + " — " + phase + tab + pages;
    }
    if (state.status === "waiting_delay") {
      const next = state.channels[state.channelIndex];
      return "Ruke hue — agla: " + (next || "-");
    }
    return STATUS_LABELS[state.status] || state.status;
  }

  function renderCompleted(state) {
    const entries = state.completed || [];
    completedEl.classList.toggle("hidden", !entries.length);
    completedEl.innerHTML = "";
    for (const entry of entries) {
      const li = document.createElement("li");
      if (entry.complete) {
        li.className = "ok";
        li.textContent = "✓ " + entry.channelKey + " (" + entry.videoCount + " videos)";
      } else if (entry.reason === "not_found") {
        li.className = "bad";
        li.textContent = "✗ " + entry.channelKey + " (nahi mila)";
      } else {
        li.className = "warn";
        li.textContent =
          "⚠ " +
          entry.channelKey +
          " (" +
          (entry.reason || "adhoora") +
          ", " +
          entry.videoCount +
          " videos)";
      }
      completedEl.appendChild(li);
    }
  }

  function secondsLeft(state) {
    const cooling = state.pauseReason === "rate_limit" || state.pauseReason === "bot_check";
    if (!cooling || !state.backoffUntilTs) return 0;
    return Math.max(0, Math.ceil((state.backoffUntilTs - Date.now()) / 1000));
  }

  function renderResume(state) {
    const wait = secondsLeft(state);
    resumeBtn.disabled = wait > 0;
    resumeBtn.textContent = wait > 0 ? "Resume (" + wait + "s)" : "Resume";

    // Only tick while a cool-down is actually counting down.
    if (wait > 0 && !countdownTimer) {
      countdownTimer = setInterval(() => {
        if (lastState) renderResume(lastState);
      }, 1000);
    } else if (wait <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function render(state) {
    if (!state) return;
    lastState = state;

    const running = state.status === "running" || state.status === "waiting_delay";
    const paused = state.status === "paused";
    // "Stopped" is resumable too — the continuation survived, so offer Resume rather than
    // making the user re-crawl from the top.
    const resumable = paused || (state.status === "stopped" && !!state.current.channelKey);

    startBtn.disabled = running;
    stopBtn.classList.toggle("hidden", !running);
    pauseBanner.classList.toggle("hidden", !resumable);
    if (resumable) {
      pauseDetailEl.textContent = state.lastEvent || "";
      renderResume(state);
    }

    statusLineEl.textContent = statusText(state);
    totalsLineEl.textContent =
      "Channels: " +
      (state.totals ? state.totals.channelsDone : 0) +
      "/" +
      (state.channels ? state.channels.length : 0) +
      " · videos: " +
      (state.totals ? state.totals.videosFetched : 0);

    renderCompleted(state);

    logEl.innerHTML = "";
    (state.log || [])
      .slice(-20)
      .reverse()
      .forEach((entry) => {
        const li = document.createElement("li");
        li.textContent = entry;
        logEl.appendChild(li);
      });

    downloadBtn.disabled = !(state.current && state.current.profile);

    // Same guard the other two panels use: never overwrite what the user is mid-way
    // through typing.
    if (!channelsEdited && state.channels && state.channels.length) {
      channelsEl.value = state.channels.join("\n");
    }
    if (!settingsEdited) {
      if (state.pageDelaySec) pageDelayEl.value = state.pageDelaySec;
      if (state.channelDelaySec) channelDelayEl.value = state.channelDelaySec;
      if (state.videoDelayMs) videoDelayEl.value = state.videoDelayMs;
      detailsEl.checked = state.fetchDetails !== false;
    }
  }

  // --------------------------------------------------------------------------- actions

  function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  channelsEl.addEventListener("input", () => {
    channelsEdited = true;
  });

  pageDelayEl.addEventListener("input", () => {
    settingsEdited = true;
    delayWarningEl.classList.toggle("hidden", Number(pageDelayEl.value) >= 3);
  });

  channelDelayEl.addEventListener("input", () => {
    settingsEdited = true;
  });

  videoDelayEl.addEventListener("input", () => {
    settingsEdited = true;
  });

  detailsEl.addEventListener("change", () => {
    settingsEdited = true;
  });

  startBtn.addEventListener("click", async () => {
    const { channels, skipped } = parseChannels(channelsEl.value);
    if (!channels.length) {
      alert("Kam se kam ek sahi YouTube channel URL ya @handle daalo.");
      return;
    }

    // Start wipes the stored pages of a paused/stopped run. Those videos cost a request
    // each to collect, so never throw them away without saying so — Resume and Download
    // partial both still work at this point.
    const banked = lastState && lastState.current ? lastState.current.videosCount : 0;
    if (banked && (lastState.status === "paused" || lastState.status === "stopped")) {
      const proceed = confirm(
        lastState.current.channelKey +
          " ka adhoora run pada hai — " +
          banked +
          " videos collect ho chuke hain jo Start karte hi delete ho jayenge.\n\n" +
          "Resume se wahin se aage badha sakte ho, ya 'Download partial' se file nikaal lo.\n\n" +
          "Phir bhi naya run start karein?"
      );
      if (!proceed) return;
    }
    if (skipped) {
      const proceed = confirm(
        skipped +
          " line samajh nahi aayi (video/playlist link ya galat format) — woh skip ho jayengi.\n\n" +
          channels.length +
          " channel(s) ke saath start karein?"
      );
      if (!proceed) return;
    }

    const pageDelaySec = Math.max(2, Number(pageDelayEl.value) || 3);
    const channelDelaySec = Math.max(3, Number(channelDelayEl.value) || 8);
    const videoDelayMs = Math.max(200, Number(videoDelayEl.value) || 700);
    const fetchDetails = !!detailsEl.checked;
    channelsEdited = false;
    settingsEdited = false;

    render(
      await send({
        type: "YOUTUBE_START",
        channels,
        pageDelaySec,
        channelDelaySec,
        videoDelayMs,
        fetchDetails,
      })
    );
  });

  stopBtn.addEventListener("click", async () => {
    render(await send({ type: "YOUTUBE_STOP" }));
  });

  resumeBtn.addEventListener("click", async () => {
    render(await send({ type: "YOUTUBE_RESUME" }));
  });

  downloadBtn.addEventListener("click", async () => {
    render(await send({ type: "YOUTUBE_DOWNLOAD_CURRENT" }));
  });

  resetBtn.addEventListener("click", async () => {
    const proceed = confirm(
      "YouTube run ka saara collected data clear ho jayega (jo file download ho chuki hai woh safe hai). Reset karein?"
    );
    if (!proceed) return;
    const state = await send({ type: "YOUTUBE_RESET" });
    channelsEdited = false;
    settingsEdited = false;
    channelsEl.value = "";
    pageDelayEl.value = 3;
    channelDelayEl.value = 8;
    videoDelayEl.value = 700;
    detailsEl.checked = true;
    delayWarningEl.classList.add("hidden");
    render(state);
  });

  // ---------------------------------------------------------------------------- wiring

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.youtubeRunState) render(changes.youtubeRunState.newValue);
  });

  (async function init() {
    render(await send({ type: "YOUTUBE_GET_STATE" }));
  })();
})();
