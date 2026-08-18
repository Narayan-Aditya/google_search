// Insta Handle Finder — content script, injected on demand into the driven tab.
// Ported from script.py: block detection, /url?q= unwrap, and profile-handle validation.
// Its completion value (last expression) is returned to the background worker.

(function () {
  const IGNORED_PATHS = new Set([
    "p", "reel", "reels", "stories", "explore", "tv", "direct",
    "accounts", "about", "developer", "legal", "terms", "privacy", "help",
  ]);
  const HANDLE_RE = /^[a-z0-9._]+$/;

  function detectBlock() {
    const href = location.href.toLowerCase();
    if (href.includes("/sorry/") || location.pathname.toLowerCase().startsWith("/sorry")) {
      return "sorry_url";
    }
    if (document.querySelector("#captcha-form, iframe[src*='recaptcha'], .g-recaptcha")) {
      return "recaptcha_dom";
    }
    const text = (document.body ? document.body.innerText : "").toLowerCase();
    const markers = ["our systems have detected unusual traffic", "automated queries", "not a robot"];
    if (markers.some((marker) => text.includes(marker))) {
      return "marker_text";
    }
    return null;
  }

  function extractDestination(href) {
    try {
      const url = new URL(href, "https://www.google.com");
      if (url.pathname === "/url") {
        return url.searchParams.get("q") || url.searchParams.get("url") || href;
      }
      return url.href;
    } catch {
      return href;
    }
  }

  function instagramProfile(destination) {
    let url;
    try {
      url = new URL(destination);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com") return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;

    let handle;
    try {
      handle = decodeURIComponent(parts[0]).toLowerCase();
    } catch {
      handle = parts[0].toLowerCase();
    }
    if (IGNORED_PATHS.has(handle) || !HANDLE_RE.test(handle)) return null;

    return { handle, profile_url: `https://www.instagram.com/${handle}/` };
  }

  const blockReason = detectBlock();
  if (blockReason) {
    return { blocked: true, blockReason, candidates: [], pageUrl: location.href };
  }

  const root = document.querySelector("#search, #rso, #main") || document.body;
  const anchors = root ? Array.from(root.querySelectorAll("a[href]")) : [];

  const seen = new Set();
  const candidates = [];
  for (const anchor of anchors) {
    const destination = extractDestination(anchor.getAttribute("href") || "");
    const profile = instagramProfile(destination);
    if (!profile || seen.has(profile.handle)) continue;
    seen.add(profile.handle);
    candidates.push(profile);
  }

  return { blocked: false, blockReason: null, candidates, pageUrl: location.href };
})();
