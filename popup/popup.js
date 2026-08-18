const citiesEl = document.getElementById("cities");
const maxPagesEl = document.getElementById("maxPages");
const delaySecEl = document.getElementById("delaySec");
const delayWarningEl = document.getElementById("delayWarning");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resumeBtn = document.getElementById("resumeBtn");
const captchaBanner = document.getElementById("captchaBanner");
const statusLine = document.getElementById("statusLine");
const totalsLine = document.getElementById("totalsLine");
const logEl = document.getElementById("log");
const downloadBtn = document.getElementById("downloadBtn");
const resetBtn = document.getElementById("resetBtn");

let citiesEdited = false;
let settingsEdited = false;

function parseCities(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/[,\n]+/)) {
    const city = raw.trim();
    if (!city) continue;
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(city);
  }
  return out;
}

// Lets a user paste/type a comma-separated list ("lucknow,kanpur,agra") and
// converts it in-place to one-city-per-line as they type or right after paste.
function normalizeCitiesText() {
  const normalized = citiesEl.value.replace(/,\s*/g, "\n");
  if (normalized !== citiesEl.value) {
    citiesEl.value = normalized;
    citiesEl.selectionStart = citiesEl.selectionEnd = citiesEl.value.length;
  }
}

const STATUS_LABELS = {
  idle: "Idle",
  stopped: "Stopped",
  done: "Done",
  paused_captcha: "Paused — CAPTCHA detected",
};

function statusText(state) {
  const cityCount = state.cities ? state.cities.length : 0;
  const cityLabel = state.cities && state.cities[state.cityIndex] ? state.cities[state.cityIndex] : "-";
  if (state.status === "running") {
    return `Running — city ${state.cityIndex + 1}/${cityCount} "${cityLabel}", page ${state.pageIndex + 1}/${state.maxPages}`;
  }
  if (state.status === "waiting_delay") {
    return `Waiting — next: "${cityLabel}", page ${state.pageIndex + 1}/${state.maxPages}`;
  }
  return STATUS_LABELS[state.status] || state.status;
}

function render(state) {
  if (!state) return;

  const running = state.status === "running" || state.status === "waiting_delay";
  const paused = state.status === "paused_captcha";

  startBtn.disabled = running || paused;
  stopBtn.classList.toggle("hidden", !(running || paused));
  captchaBanner.classList.toggle("hidden", !paused);

  statusLine.textContent = statusText(state);
  totalsLine.textContent = `Total handles: ${state.totals ? state.totals.handles : 0}`;

  logEl.innerHTML = "";
  (state.log || [])
    .slice(-20)
    .reverse()
    .forEach((entry) => {
      const li = document.createElement("li");
      li.textContent = entry;
      logEl.appendChild(li);
    });

  const hasResults = state.totals && state.totals.handles > 0;
  downloadBtn.disabled = !hasResults;

  // Only repopulate inputs from stored state if the user hasn't started typing —
  // avoids clobbering in-progress edits on every storage.onChanged tick.
  if (!citiesEdited && state.cities && state.cities.length) {
    citiesEl.value = state.cities.join("\n");
  }
  if (!settingsEdited) {
    if (state.maxPages) maxPagesEl.value = state.maxPages;
    if (state.delaySec) delaySecEl.value = state.delaySec;
  }
}

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function refresh() {
  const state = await sendMessage({ type: "GET_STATE" });
  render(state);
}

citiesEl.addEventListener("input", () => {
  citiesEdited = true;
  normalizeCitiesText();
});

delaySecEl.addEventListener("input", () => {
  settingsEdited = true;
  delayWarningEl.classList.toggle("hidden", Number(delaySecEl.value) >= 10);
});

maxPagesEl.addEventListener("input", () => {
  settingsEdited = true;
});

startBtn.addEventListener("click", async () => {
  const cities = parseCities(citiesEl.value);
  if (!cities.length) {
    alert("Kam se kam ek city daalo.");
    return;
  }
  const maxPages = Math.max(1, Math.min(50, Number(maxPagesEl.value) || 3));
  const delaySec = Math.max(5, Number(delaySecEl.value) || 10);
  citiesEdited = false;
  settingsEdited = false;
  const state = await sendMessage({ type: "START_RUN", cities, maxPages, delaySec });
  render(state);
});

stopBtn.addEventListener("click", async () => {
  const state = await sendMessage({ type: "STOP_RUN" });
  render(state);
});

resumeBtn.addEventListener("click", async () => {
  const state = await sendMessage({ type: "RESUME_RUN" });
  render(state);
});

downloadBtn.addEventListener("click", async () => {
  const { runState } = await chrome.storage.local.get("runState");
  if (!runState) return;

  const payload = {
    generated_at: new Date().toISOString(),
    query_template: 'site:instagram.com "<city>"',
    max_pages_per_city: runState.maxPages,
    delay_seconds: runState.delaySec,
    status: runState.status,
    total_handles: runState.totals ? runState.totals.handles : 0,
    cities: runState.results || {},
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `instagram_handles_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

resetBtn.addEventListener("click", async () => {
  const proceed = confirm("Purana result clear ho jayega (agar download nahi kiya to lost ho jayega). Reset karein?");
  if (!proceed) return;
  const state = await sendMessage({ type: "RESET_RUN" });
  citiesEdited = false;
  settingsEdited = false;
  citiesEl.value = "";
  maxPagesEl.value = 3;
  delaySecEl.value = 10;
  delayWarningEl.classList.add("hidden");
  render(state);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.runState) {
    render(changes.runState.newValue);
  }
});

refresh();
