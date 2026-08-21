// Side panel logic for the Instagram profile exporter, plus the mode switcher.
//
// Wrapped in an IIFE on purpose: popup.js runs in the same page and owns a pile of
// top-level names (render, sendMessage, statusLine, ...). Keeping everything private here
// means the two features can never clobber each other's globals.

(function () {
  const accountsEl = document.getElementById("igAccounts");
  const pageDelayEl = document.getElementById("igPageDelay");
  const accountDelayEl = document.getElementById("igAccountDelay");
  const delayWarningEl = document.getElementById("igDelayWarning");
  const startBtn = document.getElementById("igStartBtn");
  const stopBtn = document.getElementById("igStopBtn");
  const resumeBtn = document.getElementById("igResumeBtn");
  const pauseBanner = document.getElementById("igPauseBanner");
  const pauseDetailEl = document.getElementById("igPauseDetail");
  const statusLineEl = document.getElementById("igStatusLine");
  const totalsLineEl = document.getElementById("igTotalsLine");
  const completedEl = document.getElementById("igCompleted");
  const logEl = document.getElementById("igLog");
  const downloadBtn = document.getElementById("igDownloadBtn");
  const resetBtn = document.getElementById("igResetBtn");

  const modeGoogleBtn = document.getElementById("modeGoogleBtn");
  const modeProfilesBtn = document.getElementById("modeProfilesBtn");
  const googleDot = document.getElementById("googleModeDot");
  const profileDot = document.getElementById("profileModeDot");

  let accountsEdited = false;
  let settingsEdited = false;
  let countdownTimer = null;
  let lastState = null;

  // --------------------------------------------------------------------- input parsing

  const IGNORED_HANDLES = new Set([
    "p", "reel", "reels", "stories", "explore", "tv", "direct",
    "accounts", "about", "developer", "legal", "terms", "privacy", "help",
  ]);
  const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

  // Mirrors normalizeProfileHandle() in background-profiles.js. Duplicated rather than
  // shared because there is no bundler here — the panel needs it for instant feedback,
  // and the worker re-validates anyway, so a drift can never produce a bad run.
  function normalizeHandle(raw) {
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
      if (parts.length !== 1) return null;
      try {
        value = decodeURIComponent(parts[0]);
      } catch (e) {
        value = parts[0];
      }
    }

    value = value.toLowerCase();
    if (IGNORED_HANDLES.has(value) || !HANDLE_RE.test(value)) return null;
    return value;
  }

  // Returns { accounts, skipped } so the user is told what got dropped instead of
  // silently starting a shorter run than they asked for.
  function parseAccounts(text) {
    const seen = new Set();
    const accounts = [];
    let skipped = 0;
    for (const raw of text.split(/[\n,]+/)) {
      if (!raw.trim()) continue;
      const handle = normalizeHandle(raw);
      if (!handle) {
        skipped += 1;
        continue;
      }
      if (seen.has(handle)) continue;
      seen.add(handle);
      accounts.push(handle);
    }
    return { accounts, skipped };
  }

  // ------------------------------------------------------------------------- rendering

  const STATUS_LABELS = {
    idle: "Idle",
    stopped: "Stopped",
    done: "Done",
    paused: "Paused — dhyan chahiye",
  };

  const PHASE_LABELS = {
    resolving: "profile nikaal rahe hain",
    paginating: "posts nikaal rahe hain",
    downloading: "file save ho rahi hai",
  };

  function statusText(state) {
    const total = state.accounts ? state.accounts.length : 0;
    const position = Math.min(state.accountIndex + 1, total || 1);
    const handle = state.current && state.current.handle ? "@" + state.current.handle : "-";

    if (state.status === "running") {
      const phase = PHASE_LABELS[state.phase] || "chal raha hai";
      const pages =
        state.phase === "paginating" && state.current.pagesFetched
          ? ", page " + state.current.pagesFetched
          : "";
      return "Account " + position + "/" + total + " " + handle + " — " + phase + pages;
    }
    if (state.status === "waiting_delay") {
      const nextHandle = state.accounts[state.accountIndex];
      return "Ruke hue — agla: @" + (nextHandle || "-");
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
        li.textContent = "✓ @" + entry.handle + " (" + entry.postCount + " posts)";
      } else if (entry.reason === "not_found") {
        li.className = "bad";
        li.textContent = "✗ @" + entry.handle + " (nahi mila)";
      } else {
        li.className = "warn";
        li.textContent =
          "⚠ @" + entry.handle + " (" + (entry.reason || "adhoora") + ", " + entry.postCount + " posts)";
      }
      completedEl.appendChild(li);
    }
  }

  function secondsLeft(state) {
    if (state.pauseReason !== "rate_limit" || !state.backoffUntilTs) return 0;
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
    // "Stopped" is resumable too — the cursor survived, so offer Resume rather than
    // making the user re-crawl from the top.
    const resumable = paused || (state.status === "stopped" && !!state.current.handle);

    startBtn.disabled = running;
    stopBtn.classList.toggle("hidden", !running);
    pauseBanner.classList.toggle("hidden", !resumable);
    if (resumable) {
      pauseDetailEl.textContent = state.lastEvent || "";
      renderResume(state);
    }

    statusLineEl.textContent = statusText(state);
    totalsLineEl.textContent =
      "Accounts: " +
      (state.totals ? state.totals.accountsDone : 0) +
      "/" +
      (state.accounts ? state.accounts.length : 0) +
      " · posts: " +
      (state.totals ? state.totals.postsFetched : 0);

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

    // Same guard popup.js uses: never overwrite what the user is mid-way through typing.
    if (!accountsEdited && state.accounts && state.accounts.length) {
      accountsEl.value = state.accounts.join("\n");
    }
    if (!settingsEdited) {
      if (state.pageDelaySec) pageDelayEl.value = state.pageDelaySec;
      if (state.accountDelaySec) accountDelayEl.value = state.accountDelaySec;
    }

    renderModeDot(profileDot, state.status);
  }

  // ---------------------------------------------------------------------- mode switcher

  function applyMode(mode) {
    const profiles = mode === "profiles";
    document.body.classList.toggle("mode-profiles", profiles);
    document.body.classList.toggle("mode-google", !profiles);
    modeProfilesBtn.classList.toggle("active", profiles);
    modeGoogleBtn.classList.toggle("active", !profiles);
  }

  function setMode(mode) {
    applyMode(mode);
    chrome.storage.local.set({ uiMode: mode });
  }

  // Keeps a hidden section's run visible in the tab strip, so switching modes never
  // buries something that is still working or waiting on the user.
  function renderModeDot(dot, status) {
    const active = status === "running" || status === "waiting_delay" || status === "paused";
    dot.classList.toggle("hidden", !active);
    dot.classList.toggle("paused", status === "paused");
  }

  modeGoogleBtn.addEventListener("click", () => setMode("google"));
  modeProfilesBtn.addEventListener("click", () => setMode("profiles"));

  // --------------------------------------------------------------------------- actions

  function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  accountsEl.addEventListener("input", () => {
    accountsEdited = true;
  });

  pageDelayEl.addEventListener("input", () => {
    settingsEdited = true;
    delayWarningEl.classList.toggle("hidden", Number(pageDelayEl.value) >= 3);
  });

  accountDelayEl.addEventListener("input", () => {
    settingsEdited = true;
  });

  startBtn.addEventListener("click", async () => {
    const { accounts, skipped } = parseAccounts(accountsEl.value);
    if (!accounts.length) {
      alert("Kam se kam ek sahi Instagram profile URL ya handle daalo.");
      return;
    }
    if (skipped) {
      const proceed = confirm(
        skipped +
          " line samajh nahi aayi (post/reel link ya galat format) — woh skip ho jayengi.\n\n" +
          accounts.length +
          " account(s) ke saath start karein?"
      );
      if (!proceed) return;
    }

    const pageDelaySec = Math.max(2, Number(pageDelayEl.value) || 3);
    const accountDelaySec = Math.max(3, Number(accountDelayEl.value) || 8);
    accountsEdited = false;
    settingsEdited = false;

    render(await send({ type: "PROFILE_START", accounts, pageDelaySec, accountDelaySec }));
  });

  stopBtn.addEventListener("click", async () => {
    render(await send({ type: "PROFILE_STOP" }));
  });

  resumeBtn.addEventListener("click", async () => {
    render(await send({ type: "PROFILE_RESUME" }));
  });

  downloadBtn.addEventListener("click", async () => {
    render(await send({ type: "PROFILE_DOWNLOAD_CURRENT" }));
  });

  resetBtn.addEventListener("click", async () => {
    const proceed = confirm(
      "Instagram run ka saara collected data clear ho jayega (jo file download ho chuki hai woh safe hai). Reset karein?"
    );
    if (!proceed) return;
    const state = await send({ type: "PROFILE_RESET" });
    accountsEdited = false;
    settingsEdited = false;
    accountsEl.value = "";
    pageDelayEl.value = 3;
    accountDelayEl.value = 8;
    delayWarningEl.classList.add("hidden");
    render(state);
  });

  // ---------------------------------------------------------------------------- wiring

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.profileRunState) render(changes.profileRunState.newValue);
    // The Google feature's state drives its dot; popup.js owns everything else about it.
    if (changes.runState && changes.runState.newValue) {
      renderModeDot(googleDot, changes.runState.newValue.status);
    }
  });

  (async function init() {
    const stored = await chrome.storage.local.get(["uiMode", "runState"]);
    applyMode(stored.uiMode === "profiles" ? "profiles" : "google");
    if (stored.runState) renderModeDot(googleDot, stored.runState.status);
    render(await send({ type: "PROFILE_GET_STATE" }));
  })();
})();
