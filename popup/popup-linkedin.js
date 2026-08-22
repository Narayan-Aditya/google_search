// Side panel logic for the LinkedIn search exporter.
//
// Wrapped in an IIFE for the same reason the other panels are: popup.js,
// popup-profiles.js and popup-youtube.js all run in this same page, so keeping everything
// private here means the four features can never clobber each other.
//
// The mode switcher itself lives in popup-profiles.js — this file only renders its own
// section.

(function () {
  const searchesEl = document.getElementById("liSearches");
  const scrollDelayEl = document.getElementById("liScrollDelay");
  const searchDelayEl = document.getElementById("liSearchDelay");
  const maxPostsEl = document.getElementById("liMaxPosts");
  const delayWarningEl = document.getElementById("liDelayWarning");
  const startBtn = document.getElementById("liStartBtn");
  const stopBtn = document.getElementById("liStopBtn");
  const resumeBtn = document.getElementById("liResumeBtn");
  const pauseBanner = document.getElementById("liPauseBanner");
  const pauseDetailEl = document.getElementById("liPauseDetail");
  const statusLineEl = document.getElementById("liStatusLine");
  const totalsLineEl = document.getElementById("liTotalsLine");
  const completedEl = document.getElementById("liCompleted");
  const logEl = document.getElementById("liLog");
  const downloadBtn = document.getElementById("liDownloadBtn");
  const resetBtn = document.getElementById("liResetBtn");

  let searchesEdited = false;
  let settingsEdited = false;
  let countdownTimer = null;
  let lastState = null;

  // --------------------------------------------------------------------- input parsing

  // Mirrors normalizeSearchUrl() in background-linkedin.js. Duplicated rather than shared
  // because there is no bundler here — the panel needs it for instant feedback, and the
  // worker re-validates anyway, so a drift can never produce a bad run.
  function normalizeSearch(raw) {
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
      if (vertical !== "content" && vertical !== "all") return null;
      url.pathname = "/search/results/content/";
    }

    return { url: url.href, label: labelFor(url) };
  }

  function labelFor(url) {
    const keywords = url.searchParams.get("keywords");
    if (keywords) return keywords.trim().slice(0, 80);
    const hashtag = url.pathname.split("/")[3];
    if (hashtag) return "#" + decodeURIComponent(hashtag).slice(0, 80);
    return "linkedin-search";
  }

  // Returns { searches, skipped } so the user is told what got dropped instead of silently
  // starting a shorter run than they asked for. Split on newlines only — a search URL can
  // legitimately contain commas inside its filter parameters.
  function parseSearches(text) {
    const seen = new Set();
    const searches = [];
    let skipped = 0;
    for (const raw of text.split(/\n+/)) {
      if (!raw.trim()) continue;
      const search = normalizeSearch(raw);
      if (!search) {
        skipped += 1;
        continue;
      }
      if (seen.has(search.url)) continue;
      seen.add(search.url);
      searches.push(search);
    }
    return { searches, skipped };
  }

  // ------------------------------------------------------------------------- rendering

  const STATUS_LABELS = {
    idle: "Idle",
    stopped: "Stopped",
    done: "Done",
    paused: "Paused — dhyan chahiye",
  };

  const PHASE_LABELS = {
    loading: "page khul raha hai",
    scrolling: "posts nikaal rahe hain",
    downloading: "file save ho rahi hai",
  };

  function statusText(state) {
    const total = state.searches ? state.searches.length : 0;
    const position = Math.min(state.searchIndex + 1, total || 1);
    const label = state.current && state.current.label ? state.current.label : "-";

    if (state.status === "running") {
      const phase = PHASE_LABELS[state.phase] || "chal raha hai";
      const rounds =
        state.phase === "scrolling" && state.current.roundsDone
          ? ", scroll " + state.current.roundsDone
          : "";
      return "Search " + position + "/" + total + " " + label + " — " + phase + rounds;
    }
    if (state.status === "waiting_delay") {
      const next = state.searches[state.searchIndex];
      return "Ruke hue — agli: " + (next ? next.label : "-");
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
        li.textContent = "✓ " + entry.label + " (" + entry.postCount + " posts)";
      } else if (entry.reason === "no posts found") {
        li.className = "bad";
        li.textContent = "✗ " + entry.label + " (koi post nahi)";
      } else {
        li.className = "warn";
        li.textContent =
          "⚠ " + entry.label + " (" + (entry.reason || "adhoora") + ", " + entry.postCount + " posts)";
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
    // "Stopped" is resumable too — the scroll position is lost but the posts are not, and
    // dedupe means a resumed pass only adds what it did not already have.
    const resumable = paused || (state.status === "stopped" && !!state.current.url);

    startBtn.disabled = running;
    stopBtn.classList.toggle("hidden", !running);
    pauseBanner.classList.toggle("hidden", !resumable);
    if (resumable) {
      pauseDetailEl.textContent = state.lastEvent || "";
      renderResume(state);
    }

    statusLineEl.textContent = statusText(state);
    totalsLineEl.textContent =
      "Searches: " +
      (state.totals ? state.totals.searchesDone : 0) +
      "/" +
      (state.searches ? state.searches.length : 0) +
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

    downloadBtn.disabled = !(state.current && state.current.postsCount);

    // Same guard the other panels use: never overwrite what the user is mid-way through
    // typing.
    if (!searchesEdited && state.searches && state.searches.length) {
      searchesEl.value = state.searches.map((search) => search.url).join("\n");
    }
    if (!settingsEdited) {
      if (state.scrollDelaySec) scrollDelayEl.value = state.scrollDelaySec;
      if (state.searchDelaySec) searchDelayEl.value = state.searchDelaySec;
      if (state.maxPosts != null) maxPostsEl.value = state.maxPosts;
    }
  }

  // --------------------------------------------------------------------------- actions

  function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  searchesEl.addEventListener("input", () => {
    searchesEdited = true;
  });

  scrollDelayEl.addEventListener("input", () => {
    settingsEdited = true;
    delayWarningEl.classList.toggle("hidden", Number(scrollDelayEl.value) >= 3);
  });

  searchDelayEl.addEventListener("input", () => {
    settingsEdited = true;
  });

  maxPostsEl.addEventListener("input", () => {
    settingsEdited = true;
  });

  startBtn.addEventListener("click", async () => {
    const { searches, skipped } = parseSearches(searchesEl.value);
    if (!searches.length) {
      alert(
        "Kam se kam ek LinkedIn search URL daalo.\n\nJaise:\nhttps://www.linkedin.com/search/results/content/?keywords=ai%20startup"
      );
      return;
    }
    if (skipped) {
      const proceed = confirm(
        skipped +
          " line samajh nahi aayi (sirf /search/results/content/ ya /feed/hashtag/ chalega) — woh skip ho jayengi.\n\n" +
          searches.length +
          " search ke saath start karein?"
      );
      if (!proceed) return;
    }

    // Start wipes the stored posts of a paused/stopped run — never without saying so.
    const banked = lastState && lastState.current ? lastState.current.postsCount : 0;
    if (banked && (lastState.status === "paused" || lastState.status === "stopped")) {
      const proceed = confirm(
        lastState.current.label +
          " ka adhoora run pada hai — " +
          banked +
          " posts collect ho chuke hain jo Start karte hi delete ho jayenge.\n\n" +
          "Resume se wahin se aage badha sakte ho, ya 'Download partial' se file nikaal lo.\n\n" +
          "Phir bhi naya run start karein?"
      );
      if (!proceed) return;
    }

    const scrollDelaySec = Math.max(2, Number(scrollDelayEl.value) || 3);
    const searchDelaySec = Math.max(5, Number(searchDelayEl.value) || 10);
    const maxPosts = Math.max(0, Number(maxPostsEl.value) || 0);
    searchesEdited = false;
    settingsEdited = false;

    render(
      await send({
        type: "LINKEDIN_START",
        searches: searches.map((search) => search.url),
        scrollDelaySec,
        searchDelaySec,
        maxPosts,
      })
    );
  });

  stopBtn.addEventListener("click", async () => {
    render(await send({ type: "LINKEDIN_STOP" }));
  });

  resumeBtn.addEventListener("click", async () => {
    render(await send({ type: "LINKEDIN_RESUME" }));
  });

  downloadBtn.addEventListener("click", async () => {
    render(await send({ type: "LINKEDIN_DOWNLOAD_CURRENT" }));
  });

  resetBtn.addEventListener("click", async () => {
    const proceed = confirm(
      "LinkedIn run ka saara collected data clear ho jayega (jo file download ho chuki hai woh safe hai). Reset karein?"
    );
    if (!proceed) return;
    const state = await send({ type: "LINKEDIN_RESET" });
    searchesEdited = false;
    settingsEdited = false;
    searchesEl.value = "";
    scrollDelayEl.value = 3;
    searchDelayEl.value = 10;
    maxPostsEl.value = 300;
    delayWarningEl.classList.add("hidden");
    render(state);
  });

  // ---------------------------------------------------------------------------- wiring

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.linkedinRunState) render(changes.linkedinRunState.newValue);
  });

  (async function init() {
    render(await send({ type: "LINKEDIN_GET_STATE" }));
  })();
})();
