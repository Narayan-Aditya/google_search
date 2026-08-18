// Insta Handle Finder — background service worker (orchestrator / state machine)
//
// Deliberately does NOT: use proxies, spoof headers/user-agent, solve CAPTCHAs,
// auto-retry on a block, or run hidden/parallel tabs. On a CAPTCHA/block the run
// pauses and waits for the user to solve it manually, mirroring script.py's stance.

const ALARM_NAME = "nextPage";

// Makes the toolbar icon open the persistent side panel (popup/popup.html) instead
// of a dropdown popup — the side panel lives outside the tab's page DOM, so unlike
// an injected iframe it survives page navigation without reloading.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function defaultState() {
  return {
    status: "idle", // idle | running | waiting_delay | paused_captcha | stopped | done
    cities: [],
    maxPages: 3,
    delaySec: 10,
    cityIndex: 0,
    pageIndex: 0,
    tabId: null,
    results: {}, // { city: [{handle, profile_url}] }
    seenHandles: [], // global lowercase dedupe
    totals: { handles: 0, pagesFetched: 0 },
    lastEvent: "",
    lastScrapedStep: null,
    log: [],
    updatedAt: 0,
  };
}

async function getState() {
  const { runState } = await chrome.storage.local.get("runState");
  return runState || defaultState();
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.lastEvent) {
    next.log = [...current.log, patch.lastEvent].slice(-50);
  }
  await chrome.storage.local.set({ runState: next });
  return next;
}

function searchUrl(city, pageIndex) {
  const params = new URLSearchParams({
    q: `site:instagram.com "${city}"`,
    start: String(pageIndex * 10),
    num: "10",
  });
  return `https://www.google.com/search?${params.toString()}`;
}

function scheduleAlarm(baseSeconds) {
  const jitter = baseSeconds * (Math.random() * 0.4 - 0.2); // +/-20%
  const delaySeconds = Math.max(1, baseSeconds + jitter);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: delaySeconds / 60 });
}

async function startRun(msg) {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.action.setBadgeText({ text: "" });

  const cities = msg.cities;
  const tab = await chrome.tabs.create({ url: searchUrl(cities[0], 0), active: true });
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // panel may already be open, or the user-gesture window expired — non-fatal
  }

  const state = {
    ...defaultState(),
    status: "running",
    cities,
    maxPages: msg.maxPages,
    delaySec: msg.delaySec,
    tabId: tab.id,
    lastEvent: `Starting "${cities[0]}"`,
    log: [`Starting "${cities[0]}"`],
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ runState: state });
}

async function resumeRun() {
  const state = await getState();
  if (state.status !== "paused_captcha") return;
  chrome.action.setBadgeText({ text: "" });
  chrome.notifications.clear("captcha-pause");
  const city = state.cities[state.cityIndex];
  const url = searchUrl(city, state.pageIndex);
  await setState({ status: "running", lastEvent: `Resuming "${city}" page ${state.pageIndex + 1}` });
  try {
    await chrome.tabs.update(state.tabId, { url, active: true });
  } catch (e) {
    await setState({ status: "stopped", lastEvent: "Tab no longer available — results preserved" });
  }
}

async function stopRun() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.action.setBadgeText({ text: "" });
  chrome.notifications.clear("captcha-pause");
  await setState({ status: "stopped", lastEvent: "Run stopped by user" });
}

async function resetRun() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.action.setBadgeText({ text: "" });
  chrome.notifications.clear("captcha-pause");
  await chrome.storage.local.set({ runState: defaultState() });
}

async function finishRun() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#188038" });
  await setState({ status: "done", lastEvent: "All cities complete" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// General "run needs attention" pause — used for CAPTCHA/block pages as well as
// transient scrape failures (e.g. executeScript flaking on a long run). Resume
// always re-navigates to the same (city, page) it paused on and retries.
async function enterPause(reason, detail) {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.action.setBadgeText({ text: "⏸" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  const prior = await getState();
  const city = prior.cities[prior.cityIndex] || "";
  const message =
    detail || `CAPTCHA/block detected (${reason}) on "${city}" p${prior.pageIndex + 1} — solve it in the tab, then click Resume`;
  await setState({ status: "paused_captcha", lastEvent: message });
  chrome.notifications.create("captcha-pause", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Insta Handle Finder — Paused",
    message,
    priority: 2,
    requireInteraction: true,
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== "captcha-pause") return;
  (async () => {
    const state = await getState();
    if (!state.tabId) return;
    try {
      await chrome.tabs.update(state.tabId, { active: true });
      const tab = await chrome.tabs.get(state.tabId);
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      // tab may already be gone; nothing to focus
    }
    chrome.notifications.clear("captcha-pause");
  })();
});

async function scheduleNextStep() {
  const state = await getState();
  let { cityIndex, pageIndex } = state;
  pageIndex += 1;
  let crossingCity = false;
  if (pageIndex >= state.maxPages) {
    cityIndex += 1;
    pageIndex = 0;
    crossingCity = true;
  }
  if (cityIndex >= state.cities.length) {
    await finishRun();
    return;
  }
  await setState({ cityIndex, pageIndex, status: "waiting_delay" });
  scheduleAlarm(state.delaySec * (crossingCity ? 1.5 : 1));
}

async function scrapeCurrentPage(tabId, stepKey) {
  const state = await getState();
  const cityKey = state.cities[state.cityIndex];
  const pageLabel = state.pageIndex + 1;

  let injectionResult;
  let lastError = null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const injections = await chrome.scripting.executeScript({ target: { tabId }, files: ["content-scraper.js"] });
      injectionResult = injections[0] && injections[0].result;
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
    }
  }

  if (lastError) {
    await enterPause(
      "injection_failed",
      `Couldn't run the scraper on "${cityKey}" p${pageLabel} after ${MAX_ATTEMPTS} tries (${lastError.message}). Check the tab, then click Resume to retry this page.`
    );
    return;
  }

  if (!injectionResult) {
    await enterPause(
      "empty_result",
      `No data back from "${cityKey}" p${pageLabel} — the page may not have finished loading. Click Resume to retry this page.`
    );
    return;
  }

  if (injectionResult.blocked) {
    await enterPause(injectionResult.blockReason || "detected");
    return;
  }

  const seen = new Set(state.seenHandles);
  const cityResults = state.results[cityKey] ? [...state.results[cityKey]] : [];

  let newCount = 0;
  for (const candidate of injectionResult.candidates) {
    if (seen.has(candidate.handle)) continue;
    seen.add(candidate.handle);
    cityResults.push({ handle: `@${candidate.handle}`, profile_url: candidate.profile_url });
    newCount += 1;
  }

  await setState({
    results: { ...state.results, [cityKey]: cityResults },
    seenHandles: Array.from(seen),
    totals: { handles: state.totals.handles + newCount, pagesFetched: state.totals.pagesFetched + 1 },
    lastScrapedStep: stepKey,
    lastEvent: `"${cityKey}" p${state.pageIndex + 1}: ${newCount} new handle(s)`,
  });

  await scheduleNextStep();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "START_RUN":
        await startRun(msg);
        break;
      case "RESUME_RUN":
        await resumeRun();
        break;
      case "STOP_RUN":
        await stopRun();
        break;
      case "RESET_RUN":
        await resetRun();
        break;
      default:
        break;
    }
    sendResponse(await getState());
  })();
  return true; // keep the message channel open for the async response
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  (async () => {
    const state = await getState();
    if (state.status !== "running" || tabId !== state.tabId) return;

    const stepKey = `${state.cityIndex}:${state.pageIndex}`;
    if (state.lastScrapedStep === stepKey) return; // already handled this step

    const url = (tab.url || "").toLowerCase();
    if (url.includes("/sorry/")) {
      await enterPause("sorry_url");
      return;
    }

    await scrapeCurrentPage(tabId, stepKey);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  (async () => {
    const state = await getState();
    if (state.status !== "waiting_delay") return;
    const city = state.cities[state.cityIndex];
    const url = searchUrl(city, state.pageIndex);
    await setState({ status: "running" });
    try {
      await chrome.tabs.update(state.tabId, { url, active: true });
    } catch (e) {
      await setState({ status: "stopped", lastEvent: "Tab no longer available — results preserved" });
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const state = await getState();
    if (state.tabId !== tabId) return;
    if (["running", "waiting_delay", "paused_captcha"].includes(state.status)) {
      await chrome.alarms.clear(ALARM_NAME);
      chrome.action.setBadgeText({ text: "" });
      await setState({ status: "stopped", lastEvent: "Tab closed by user — results preserved" });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    const state = await getState();
    if (state.status === "running" || state.status === "waiting_delay") {
      await setState({
        status: "stopped",
        lastEvent: "Browser restarted — press Start again or Download partial results",
      });
    }
  })();
});
