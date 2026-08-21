// Offscreen document — exists for exactly one reason: an MV3 service worker has no
// URL.createObjectURL, so it cannot turn a JSON string into a downloadable URL.
//
// It deliberately does NOT call chrome.downloads itself: offscreen documents only get
// chrome.runtime, not the wider extension API surface. So it mints a blob: URL, hands
// it back to the service worker (same extension origin, so the URL is usable there),
// and revokes it once the worker says the download finished.

const liveUrls = new Set();

function makeObjectUrl(json) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);
  return url;
}

function revokeObjectUrl(url) {
  if (!liveUrls.has(url)) return false;
  URL.revokeObjectURL(url);
  liveUrls.delete(url);
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  try {
    switch (msg.type) {
      case "OFFSCREEN_MAKE_URL":
        if (typeof msg.json !== "string" || !msg.json) {
          sendResponse({ ok: false, error: "empty payload" });
          break;
        }
        sendResponse({ ok: true, url: makeObjectUrl(msg.json) });
        break;

      case "OFFSCREEN_REVOKE_URL":
        sendResponse({ ok: revokeObjectUrl(msg.url) });
        break;

      default:
        sendResponse({ ok: false, error: `unknown type ${msg.type}` });
        break;
    }
  } catch (e) {
    // Blob construction can throw on very large payloads (out of memory). Report it
    // rather than dying silently — the worker turns this into a visible pause.
    sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
  }

  return true; // responses above are synchronous, but keep the channel explicit
});
