// Insta Handle Finder — YouTube channel/videos fetcher, injected into the driven
// youtube.com tab.
//
// Mirrors content-ig-fetch.js on purpose. The pagination loop lives HERE and not in the
// service worker because an MV3 worker is killed after ~30s idle, while a channel crawl
// runs for minutes. Each page is reported to the worker, which persists the continuation
// token — so a crash, a closed tab or a sleeping worker never costs more than the request
// in flight.
//
// Deliberately does NOT: spoof headers or user-agent, use a proxy, bypass a consent or
// login wall, or silently retry through a rate limit. It calls YouTube's own InnerTube
// endpoints from the user's own logged-in tab, the same way the page does, and surfaces
// every wall to the UI as a resumable pause.

(function () {
  const INNERTUBE_BASE = "/youtubei/v1/";
  // Only used if the page never exposed its own ytcfg — these private endpoints are
  // undocumented and drift, so this and the tab params below are the one-line updates to
  // make when the API shape changes.
  const FALLBACK_CLIENT_VERSION = "2.20240101.00.00";

  // Base64 `params` for the channel tabs, decoded (they travel inside a JSON body, so the
  // %3D padding seen in URLs must not be sent).
  //
  // Shorts are deliberately not crawled. The Shorts tab is its own feed with its own
  // renderer, and nothing here wants it — see VIDEO_KEYS below, which also refuses a short
  // that turns up inside another tab's response.
  const CHANNEL_TABS = [
    { kind: "video", label: "Videos", params: "EgZ2aWRlb3PyBgQKAjoA" },
    { kind: "live", label: "Live", params: "EgdzdHJlYW1z8gYECgJ6AA==" },
  ];

  const HARD_PAGE_CAP = 500; // runaway guard, ~15k videos
  const NETWORK_ATTEMPTS = 3;
  const STOP_CHECK_MS = 500;
  // Bounds the deep object walks below. A browse response is a few MB of nested renderers;
  // without a cap a pathological shape could spin the page.
  const WALK_CAP = 400000;

  // The renderers a long-form video arrives in. `shortsLockupViewModel` and
  // `reelItemRenderer` — the two shapes a Short comes in — are intentionally absent, so a
  // Shorts shelf embedded in another tab is walked straight past instead of collected.
  const VIDEO_KEYS = new Set(["videoRenderer", "gridVideoRenderer", "playlistVideoRenderer"]);

  const job = window.__YT_JOB__;
  if (!job || !job.channelKey) return; // seeded by the worker right before injection

  // Re-injection guard: the worker re-injects on resume and the old loop may still be
  // parked in a sleep. Each loop captures its token and exits the moment a newer one takes
  // over, so two loops can never report into the same channel.
  const runToken = job.runToken;
  window.__YT_RUN_TOKEN__ = runToken;
  window.__YT_STOP__ = false;

  let CONFIG = null;

  function isCurrent() {
    return window.__YT_RUN_TOKEN__ === runToken && !window.__YT_STOP__;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Sleeps in slices so a Stop lands within half a second instead of after the full delay.
  async function pacedSleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!isCurrent()) return false;
      await sleep(Math.min(STOP_CHECK_MS, until - Date.now()));
    }
    return isCurrent();
  }

  function jitter(baseMs) {
    return Math.max(0, baseMs + baseMs * (Math.random() * 0.4 - 0.2)); // +/-20%
  }

  async function report(type, payload) {
    try {
      const ack = await chrome.runtime.sendMessage(
        Object.assign({ type, channel: job.channelKey }, payload)
      );
      // The worker answers { abort:true } when this run is no longer the live one
      // (stopped, reset, or superseded) — stop pulling data nobody will store.
      if (ack && ack.abort) window.__YT_STOP__ = true;
      return ack;
    } catch (e) {
      // Worker gone / extension reloaded mid-run. Nothing can receive results any more.
      window.__YT_STOP__ = true;
      return null;
    }
  }

  function fail(reason, detail, httpStatus) {
    return report("YT_ERROR", {
      reason,
      detail: detail || "",
      httpStatus: httpStatus == null ? null : httpStatus,
    });
  }

  // -------------------------------------------------------------- object walk helpers

  // YouTube renames its renderer tree wholesale every few months, so every field below is
  // located by key rather than by a fixed path. A missing field becomes null; it never
  // throws and never fails a crawl.
  function deepFind(root, key) {
    if (!root || typeof root !== "object") return null;
    const queue = [root];
    let head = 0;
    let budget = WALK_CAP;
    while (head < queue.length && budget-- > 0) {
      const node = queue[head++];
      if (Array.isArray(node)) {
        for (const item of node) if (item && typeof item === "object") queue.push(item);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(node, key) && node[key] != null) return node[key];
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return null;
  }

  // Breadth-first so shallower (more relevant) matches win. Matched nodes are not
  // descended into, which is what stops one video from being counted twice.
  function deepCollect(root, keySet) {
    const out = [];
    if (!root || typeof root !== "object") return out;
    const queue = [root];
    let head = 0;
    let budget = WALK_CAP;
    while (head < queue.length && budget-- > 0) {
      const node = queue[head++];
      if (Array.isArray(node)) {
        for (const item of node) if (item && typeof item === "object") queue.push(item);
        continue;
      }
      let matched = false;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (keySet.has(key) && value && typeof value === "object") {
          out.push({ key, value });
          matched = true;
        }
      }
      if (matched) continue;
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return out;
  }

  // Every text field YouTube ships is one of these shapes.
  function runsText(node) {
    if (node == null) return "";
    if (typeof node === "string") return node;
    if (typeof node !== "object") return String(node);
    if (typeof node.simpleText === "string") return node.simpleText;
    if (typeof node.content === "string") return node.content;
    if (Array.isArray(node.runs)) {
      return node.runs.map((run) => (run && typeof run.text === "string" ? run.text : "")).join("");
    }
    if (node.accessibility) return String(deepFind(node, "label") || "");
    return "";
  }

  const COUNT_SUFFIX = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

  // Bare digits, or digits in groups of three under any separator ("1,234,567",
  // "1.234.567", "1 234 567"). Deliberately strict: a wrong number in the export is worse
  // than a null, and a localized "1,2 Mio. Aufrufe" would otherwise read as 12.
  const GROUPED_NUMBER_RE = /^\d+$|^\d{1,3}([,.\s  ]\d{3})+$/;

  // "1,234,567 views" -> 1234567, "1.2M subscribers" -> 1200000, "No views" -> 0.
  // Abbreviated inputs are rounded by YouTube itself; callers record which kind they got.
  // Anything this cannot read confidently comes back null — the caller keeps the raw text
  // in its matching *_text field, so nothing is lost and nothing is invented.
  function parseCount(raw) {
    const text = runsText(raw);
    if (!text || !text.trim()) return null;
    if (/^\s*no\b/i.test(text)) return 0;
    // The word boundary stops "1,2 Mio." parsing as "2M"; the leading guard stops the same
    // string's decimal tail being read as a whole number in "1,2 k".
    const abbrev = text.match(/(?:^|[^\d.,])(\d+(?:\.\d+)?)\s*([KMBT])\b/i);
    if (abbrev) {
      const multiplier = COUNT_SUFFIX[abbrev[2].toLowerCase()];
      const value = Math.round(parseFloat(abbrev[1]) * multiplier);
      return isFinite(value) ? value : null;
    }
    const digits = text.match(/\d[\d,.\s  ]*\d|\d/);
    if (!digits || !GROUPED_NUMBER_RE.test(digits[0])) return null;
    const value = parseInt(digits[0].replace(/\D/g, ""), 10);
    return isFinite(value) ? value : null;
  }

  function isAbbreviated(text) {
    return /\d\s*[KMBT]\b/i.test(String(text || ""));
  }

  // "12:34" -> 754, "1:02:03" -> 3723.
  function parseDuration(text) {
    const value = String(text || "").trim();
    if (!/^\d+(:\d{1,2}){1,2}$/.test(value)) return null;
    return value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  }

  // YouTube gives a publish *date*, never a time. Date.parse reads that as local midnight,
  // which would emit the previous day for anyone east of UTC — so the calendar date is
  // re-anchored to UTC midnight and stays the date YouTube actually showed.
  function isoFromDateText(text) {
    const cleaned = String(text || "")
      .replace(/^(premiered|streamed live on|started streaming on|streamed on|live on)\s+/i, "")
      .trim();
    if (!cleaned) return null;
    const ts = Date.parse(cleaned);
    if (!isFinite(ts)) return null;
    const local = new Date(ts);
    return new Date(
      Date.UTC(local.getFullYear(), local.getMonth(), local.getDate())
    ).toISOString();
  }

  function absoluteUrl(url) {
    if (typeof url !== "string" || !url) return null;
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return "https://www.youtube.com" + url;
    return url;
  }

  // Channel links are wrapped in youtube.com/redirect?q=... — keep the real destination.
  function unwrapRedirect(url) {
    const value = absoluteUrl(url);
    if (!value || value.indexOf("youtube.com/redirect") === -1) return value;
    try {
      const target = new URL(value).searchParams.get("q");
      return target ? decodeURIComponent(target) : value;
    } catch (e) {
      return value;
    }
  }

  function thumbList(node) {
    if (!node || typeof node !== "object") return [];
    // Old renderers hand over { thumbnails: [...] }; the newer view models bury the same
    // list one or two wrappers down as { sources: [...] }.
    let list = node.thumbnails || node.sources;
    if (!Array.isArray(list)) list = deepFind(node, "thumbnails") || deepFind(node, "sources");
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      if (!item || !item.url) continue;
      out.push({
        url: absoluteUrl(item.url),
        width: Number(item.width) || null,
        height: Number(item.height) || null,
      });
    }
    return out;
  }

  function bestThumbUrl(list) {
    let best = null;
    for (const item of list) {
      if (!best || (item.width || 0) > (best.width || 0)) best = item;
    }
    return best ? best.url : null;
  }

  function watchUrl(videoId) {
    return "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
  }

  // ------------------------------------------------------------- page context reading

  function scriptTexts() {
    const out = [];
    const nodes = document.querySelectorAll("script");
    for (const node of nodes) {
      const text = node.textContent;
      if (text && text.length > 40) out.push(text);
    }
    return out;
  }

  // Brace-matched slice, so a JSON blob can be lifted out of a script assignment without a
  // regex trying (and failing) to balance braces that appear inside string literals.
  function sliceJsonObject(text, from) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(from, i + 1);
      }
    }
    return null;
  }

  // Between the marker and its object there may only be an assignment — optionally through
  // a bracket/quote tail, as in window["ytInitialData"] = {...}. Anything else means this
  // occurrence is a mention, not the definition: `if (window.ytInitialData) {}` would
  // otherwise parse as a perfectly valid, perfectly empty object.
  const ASSIGNMENT_GAP_RE = /^[\s"'\]]*=\s*$/;

  function jsonAfterMarker(text, marker) {
    let index = text.indexOf(marker);
    while (index !== -1) {
      const after = index + marker.length;
      const brace = text.indexOf("{", after);
      if (brace !== -1) {
        const gap = text.slice(after, brace);
        if (gap === "" || ASSIGNMENT_GAP_RE.test(gap)) {
          const slice = sliceJsonObject(text, brace);
          if (slice) {
            try {
              const parsed = JSON.parse(slice);
              // An empty object is never the blob we came for, and accepting one would
              // stop the search before the real definition further down the file.
              if (parsed && Object.keys(parsed).length) return parsed;
            } catch (e) {
              // Not JSON after all — keep looking.
            }
          }
        }
      }
      index = text.indexOf(marker, after);
    }
    return null;
  }

  function readInitialData() {
    for (const text of scriptTexts()) {
      if (text.indexOf("ytInitialData") === -1) continue;
      const data = jsonAfterMarker(text, "ytInitialData");
      if (data && typeof data === "object") return data;
    }
    return null;
  }

  // Reuses the page's own InnerTube client identity. The hand-built fallback keeps the
  // crawl alive if ytcfg moves, at the cost of a slightly staler client version.
  function readPageConfig() {
    let context = null;
    let apiKey = "";
    let clientVersion = "";
    let clientName = "1";

    for (const text of scriptTexts()) {
      if (!context && text.indexOf("INNERTUBE_CONTEXT") !== -1) {
        context = jsonAfterMarker(text, '"INNERTUBE_CONTEXT":');
      }
      if (!apiKey) {
        const match = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
        if (match) apiKey = match[1];
      }
      if (!clientVersion) {
        const match = text.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
        if (match) clientVersion = match[1];
      }
      const nameMatch = text.match(/"INNERTUBE_CONTEXT_CLIENT_NAME":\s*(\d+)/);
      if (nameMatch) clientName = nameMatch[1];
    }

    if (!clientVersion && context && context.client && context.client.clientVersion) {
      clientVersion = context.client.clientVersion;
    }
    if (!clientVersion) clientVersion = FALLBACK_CLIENT_VERSION;
    if (!context || !context.client) {
      context = { client: { clientName: "WEB", clientVersion, hl: "en", gl: "US" } };
    }
    // Ask for English text on our own requests. Every count YouTube ships is a *string*
    // ("1,234,567 views"), and the separator rules differ per locale — a German
    // "1,2 Mio. Aufrufe" is unparseable without guessing. `gl` is left alone, so region
    // availability is unchanged; only the language of the labels is pinned.
    context.client.hl = "en";
    return { context, apiKey, clientVersion, clientName };
  }

  // ---------------------------------------------------------------- request plumbing

  function onYouTube() {
    const host = location.hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host.endsWith(".youtube.com");
  }

  function looksLikeConsentWall() {
    const host = location.hostname.toLowerCase();
    return host.startsWith("consent.") || /^\/consent/.test(location.pathname);
  }

  function looksLikeLoginWall() {
    return location.hostname.toLowerCase().indexOf("accounts.google.com") !== -1;
  }

  // Classifies a response body once, so a 200-with-error and a 403-consent are told apart
  // without re-reading the stream.
  function classify(status, text) {
    const lowered = (text || "").toLowerCase();
    if (lowered.indexOf("sign in to confirm") !== -1 || lowered.indexOf("not a bot") !== -1) {
      return "bot_check";
    }
    if (lowered.indexOf("consent.youtube.com") !== -1) return "consent_wall";
    if (status === 401) return "login_wall";
    if (status === 403) return lowered.indexOf("consent") !== -1 ? "consent_wall" : "forbidden";
    if (status === 429) return "rate_limit";
    if (status === 404) return "not_found";
    if (status >= 500) return "network";
    if (lowered.indexOf("too many requests") !== -1 || lowered.indexOf("rate limit") !== -1) {
      return "rate_limit";
    }
    if (lowered.indexOf("login_required") !== -1) return "login_wall";
    return "endpoint_shape";
  }

  // Returns { ok:true, data } or { ok:false, reason, status, detail }. Retries only
  // genuinely transient failures (thrown fetch, 5xx) — an auth wall or a rate limit is
  // never hammered.
  async function postJson(endpoint, body) {
    const url =
      INNERTUBE_BASE +
      endpoint +
      "?prettyPrint=false" +
      (CONFIG.apiKey ? "&key=" + encodeURIComponent(CONFIG.apiKey) : "");
    const payload = JSON.stringify(Object.assign({ context: CONFIG.context }, body));
    let lastDetail = "";

    for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt++) {
      if (!isCurrent()) return { ok: false, reason: "stopped", status: null, detail: "" };

      if (!onYouTube()) {
        return { ok: false, reason: "wrong_origin", status: null, detail: location.href };
      }
      if (looksLikeConsentWall()) {
        return { ok: false, reason: "consent_wall", status: null, detail: location.href };
      }
      if (looksLikeLoginWall()) {
        return { ok: false, reason: "login_wall", status: null, detail: location.href };
      }

      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-youtube-client-name": CONFIG.clientName,
            "x-youtube-client-version": CONFIG.clientVersion,
          },
          body: payload,
        });
      } catch (e) {
        lastDetail = e && e.message ? e.message : String(e);
        if (attempt < NETWORK_ATTEMPTS) {
          if (!(await pacedSleep(1000 * Math.pow(2, attempt)))) {
            return { ok: false, reason: "stopped", status: null, detail: "" };
          }
          continue;
        }
        return { ok: false, reason: "network", status: null, detail: lastDetail };
      }

      let text = "";
      try {
        text = await res.text();
      } catch (e) {
        text = "";
      }

      if (!res.ok) {
        const reason = classify(res.status, text);
        if (reason === "network" && attempt < NETWORK_ATTEMPTS) {
          if (!(await pacedSleep(1000 * Math.pow(2, attempt)))) {
            return { ok: false, reason: "stopped", status: null, detail: "" };
          }
          continue;
        }
        return { ok: false, reason, status: res.status, detail: text.slice(0, 200) };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // A 200 that isn't JSON is almost always an HTML consent/login interstitial.
        return {
          ok: false,
          reason: classify(200, text),
          status: 200,
          detail: "response was not JSON",
        };
      }

      return { ok: true, data };
    }
    return { ok: false, reason: "network", status: null, detail: lastDetail };
  }

  // ------------------------------------------------------------------ field mapping

  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

  function splitKeywords(raw) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return [];
    const matches = text.match(/"[^"]*"|\S+/g) || [];
    const out = [];
    for (const item of matches) {
      const cleaned = item.replace(/^"|"$/g, "").trim();
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
    return out;
  }

  function mapChannelLinks(about) {
    const list = about && Array.isArray(about.links) ? about.links : [];
    const out = [];
    for (const item of list) {
      const view = item && item.channelExternalLinkViewModel;
      if (!view) continue;
      out.push({
        title: runsText(view.title) || null,
        display: runsText(view.link) || null,
        url: unwrapRedirect(deepFind(view.link || {}, "url")),
      });
    }
    return out;
  }

  function detectVerified(data) {
    const header = data.header || {};
    const badges = deepCollect(header, new Set(["metadataBadgeRenderer", "badgeViewModel"]));
    for (const badge of badges) {
      const value = badge.value;
      const text =
        String(value.style || value.iconName || "") +
        " " +
        runsText(value.tooltip || value.accessibilityText);
      if (/verified|official artist|check_circle/i.test(text)) return true;
    }
    // The newer page header hides the tick inside a text attachment run, where it has no
    // stable key of its own — a bounded string scan is the only signal left.
    try {
      const raw = JSON.stringify(header);
      return raw.length < 400000 && /BADGE_STYLE_TYPE_VERIFIED|CHECK_CIRCLE_(THICK|FILLED)/i.test(raw);
    } catch (e) {
      return false;
    }
  }

  // A channel that does not exist still renders a page — the only signal is an alert.
  function channelAlert(data) {
    const alerts = deepCollect(data, new Set(["alertRenderer", "alertWithButtonRenderer"]));
    for (const alert of alerts) {
      const text = runsText(alert.value.text);
      if (/does not exist|isn't available|isn.t available|not available/i.test(text)) return text;
    }
    return null;
  }

  function mapChannelProfile(data) {
    const meta = (data.metadata && data.metadata.channelMetadataRenderer) || {};
    const micro = (data.microformat && data.microformat.microformatDataRenderer) || {};
    const header = data.header || {};
    const about = deepFind(data, "aboutChannelViewModel") || {};

    let channelId = meta.externalId || about.channelId || null;
    if (!CHANNEL_ID_RE.test(String(channelId || ""))) {
      const browseId = deepFind(header, "browseId");
      channelId = CHANNEL_ID_RE.test(String(browseId || "")) ? browseId : channelId;
    }

    const subscriberText =
      runsText(about.subscriberCountText) || runsText(deepFind(header, "subscriberCountText"));
    const videoCountText =
      runsText(about.videoCountText) || runsText(deepFind(header, "videosCountText"));
    const viewCountText = runsText(about.viewCountText);

    const canonical =
      about.canonicalChannelUrl || meta.vanityChannelUrl || meta.channelUrl || micro.urlCanonical;
    let handle = runsText(deepFind(header, "channelHandleText")) || "";
    if (!handle && typeof canonical === "string") {
      const match = canonical.match(/\/(@[^/?#]+)/);
      if (match) handle = match[1];
    }

    const avatars = thumbList(meta.avatar || deepFind(header, "avatar"));
    const banners = thumbList(deepFind(header, "banner"));

    return {
      channel_id: channelId || null,
      handle: handle || null,
      title: meta.title || runsText(deepFind(header, "title")) || null,
      description: about.description || meta.description || micro.description || "",
      canonical_url: absoluteUrl(canonical) || null,
      subscriber_count: parseCount(subscriberText),
      subscriber_count_text: subscriberText || null,
      subscriber_count_exact: subscriberText ? !isAbbreviated(subscriberText) : null,
      video_count: parseCount(videoCountText),
      video_count_text: videoCountText || null,
      view_count: parseCount(viewCountText),
      view_count_text: viewCountText || null,
      joined_date: runsText(about.joinedDateText) || null,
      country: runsText(about.country) || null,
      keywords: splitKeywords(meta.keywords),
      is_verified: detectVerified(data),
      is_family_safe: typeof meta.isFamilySafe === "boolean" ? meta.isFamilySafe : null,
      avatar_url: bestThumbUrl(avatars),
      avatars,
      banner_url: bestThumbUrl(banners),
      links: mapChannelLinks(about),
    };
  }

  // ---- video listing ----

  // The listing renderers carry the cheap fields (title, thumbnail, rounded view count).
  // like/comment/description are filled in later by the details pass, so a video that was
  // never enriched is visibly `details_source: null` rather than silently zeroed.
  function emptyVideo(id, kind) {
    return {
      id,
      url: watchUrl(id),
      kind,
      title: "",
      description: null,
      thumbnail_url: null,
      thumbnails: [],
      view_count: null,
      view_count_text: null,
      view_count_exact: null,
      like_count: null,
      comment_count: null,
      published_text: null,
      published_date_text: null,
      published_at: null,
      duration_text: null,
      duration_seconds: null,
      is_live_now: false,
      live_viewers: null,
      details_source: null,
      details_error: null,
    };
  }

  function mapStandardVideo(node, kind) {
    const id = node.videoId;
    if (!id) return null;
    const video = emptyVideo(String(id), kind);
    const viewText = runsText(node.viewCountText) || runsText(node.shortViewCountText);
    const durationText = runsText(node.lengthText) || runsText(deepFind(node, "lengthText"));

    video.title = runsText(node.title);
    video.thumbnails = thumbList(node.thumbnail);
    video.thumbnail_url = bestThumbUrl(video.thumbnails);
    video.view_count = parseCount(viewText);
    video.view_count_text = viewText || null;
    video.view_count_exact = viewText ? !isAbbreviated(viewText) : null;
    video.published_text = runsText(node.publishedTimeText) || null;
    video.duration_text = durationText || null;
    video.duration_seconds = parseDuration(durationText);
    const snippet = runsText(node.descriptionSnippet);
    if (snippet) video.description = snippet;
    return video;
  }

  function mapVideoNode(entry, kind) {
    if (!entry || !entry.value) return null;
    return mapStandardVideo(entry.value, kind);
  }

  function findContinuation(data) {
    const items = deepCollect(data, new Set(["continuationItemRenderer"]));
    for (const item of items) {
      const token = deepFind(item.value, "token");
      if (typeof token === "string" && token) return token;
    }
    const command = deepFind(data, "continuationCommand");
    return command && typeof command.token === "string" && command.token ? command.token : null;
  }

  // ---- per-video details ----

  function extractLikeCount(data) {
    const viewModel = deepFind(data, "likeButtonViewModel");
    if (viewModel) {
      // "like this video along with 1,234,567 other people" — the exact number, where the
      // visible button only shows a rounded "1.2M".
      const exact = parseCount(deepFind(viewModel, "accessibilityText"));
      if (exact != null) return exact;
      const rounded = parseCount(runsText(deepFind(viewModel, "title")));
      if (rounded != null) return rounded;
    }
    const toggles = deepCollect(data, new Set(["toggleButtonRenderer"]));
    for (const toggle of toggles) {
      const node = toggle.value;
      const icon = node.defaultIcon && node.defaultIcon.iconType;
      if (icon !== "LIKE") continue;
      const label =
        node.defaultText &&
        node.defaultText.accessibility &&
        node.defaultText.accessibility.accessibilityData &&
        node.defaultText.accessibility.accessibilityData.label;
      const exact = parseCount(label);
      if (exact != null) return exact;
      const rounded = parseCount(runsText(node.defaultText));
      if (rounded != null) return rounded;
    }
    return null;
  }

  function extractCommentCount(data) {
    const panels = Array.isArray(data.engagementPanels) ? data.engagementPanels : [];
    for (const panel of panels) {
      const section = panel && panel.engagementPanelSectionListRenderer;
      if (!section) continue;
      if (String(section.targetId || "").indexOf("comments-section") === -1) continue;
      const count = parseCount(runsText(deepFind(section.header || {}, "contextualInfo")));
      if (count != null) return count;
    }
    const entry = deepFind(data, "commentsEntryPointHeaderRenderer");
    if (entry) {
      const count = parseCount(runsText(entry.commentCount));
      if (count != null) return count;
    }
    return parseCount(runsText(deepFind(data, "commentCount")));
  }

  function extractDescription(data) {
    const attributed = deepFind(data, "attributedDescription");
    if (attributed && typeof attributed.content === "string") return attributed.content;
    const body = deepFind(data, "attributedDescriptionBodyText");
    if (body && typeof body.content === "string") return body.content;
    const secondary = deepFind(data, "videoSecondaryInfoRenderer");
    if (secondary) {
      const text = runsText(secondary.description);
      if (text) return text;
    }
    return null;
  }

  // Fills in what the channel grid cannot carry: exact views, likes, comments and the
  // full description. Anything it cannot find stays null rather than becoming a zero.
  function applyDetails(video, data) {
    const viewRenderer = deepFind(data, "videoViewCountRenderer");
    const viewText = viewRenderer ? runsText(viewRenderer.viewCount) : "";
    if (viewText) {
      const count = parseCount(viewText);
      // A stream that is live right now reports "12,345 watching now" in the very same
      // field. That is a concurrent-viewer count, not a view count, and writing it into
      // view_count would quietly understate the video by orders of magnitude.
      if (/watching|waiting/i.test(viewText)) {
        video.is_live_now = true;
        video.live_viewers = count;
        video.view_count_text = viewText;
      } else if (count != null) {
        video.view_count = count;
        video.view_count_text = viewText;
        video.view_count_exact = !isAbbreviated(viewText);
      }
    }

    const likes = extractLikeCount(data);
    if (likes != null) video.like_count = likes;

    const comments = extractCommentCount(data);
    if (comments != null) video.comment_count = comments;

    const description = extractDescription(data);
    if (description != null) video.description = description;

    const primary = deepFind(data, "videoPrimaryInfoRenderer");
    if (primary) {
      const title = runsText(primary.title);
      if (title) video.title = title;
      const dateText = runsText(primary.dateText);
      if (dateText) {
        video.published_date_text = dateText;
        video.published_at = isoFromDateText(dateText);
      }
      const relative = runsText(primary.relativeDateText);
      if (relative && !video.published_text) video.published_text = relative;
    }

    video.details_source = "next";
    video.details_error = null;
  }

  // Second opinion when `next` changes shape: /player carries the same core fields.
  function applyPlayerDetails(video, data) {
    const details = data && data.videoDetails;
    if (!details) return false;
    if (typeof details.shortDescription === "string" && video.description == null) {
      video.description = details.shortDescription;
    }
    if (details.viewCount != null) {
      const count = parseCount(String(details.viewCount));
      if (count != null) {
        video.view_count = count;
        video.view_count_text = String(details.viewCount);
        video.view_count_exact = true;
      }
    }
    if (details.title && !video.title) video.title = details.title;
    if (details.lengthSeconds && video.duration_seconds == null) {
      video.duration_seconds = Number(details.lengthSeconds) || null;
    }
    if (!video.thumbnail_url) {
      const thumbs = thumbList(details.thumbnail);
      if (thumbs.length) {
        video.thumbnails = thumbs;
        video.thumbnail_url = bestThumbUrl(thumbs);
      }
    }
    const publishDate = data.microformat && deepFind(data.microformat, "publishDate");
    if (publishDate) {
      video.published_date_text = String(publishDate);
      video.published_at = isoFromDateText(String(publishDate));
    }
    video.details_source = video.details_source ? video.details_source + "+player" : "player";
    return true;
  }

  // Walks one page of videos. A single unreachable video (private, removed, age-gated) is
  // recorded on that video and skipped; an access wall ends the pass.
  //
  // It reports the wall back to the caller instead of calling fail() itself, because the
  // worker stops accepting data the moment it pauses — the page has to be banked first or
  // the videos we just spent a request each on are thrown away.
  // Returns { status: "ok" | "stopped" | "failed", error }.
  async function enrichVideos(videos) {
    let playerFallbackTried = false;

    for (let i = 0; i < videos.length; i++) {
      if (!isCurrent()) return { status: "stopped" };
      const video = videos[i];

      const res = await postJson("next", { videoId: video.id });
      if (res.ok) {
        applyDetails(video, res.data);
      } else if (res.reason === "stopped") {
        return { status: "stopped" };
      } else if (res.reason === "not_found" || res.reason === "endpoint_shape") {
        video.details_error = res.reason;
      } else {
        return {
          status: "failed",
          error: {
            reason: res.reason,
            detail: "video " + video.id + ": " + res.detail,
            httpStatus: res.status,
          },
        };
      }

      // If `next` gave nothing usable, try /player once for this page before deciding the
      // details pass is simply not available today.
      const gotNothing =
        video.details_source == null || (video.like_count == null && video.description == null);
      if (gotNothing && !playerFallbackTried) {
        playerFallbackTried = true;
        const player = await postJson("player", { videoId: video.id });
        if (player.ok) applyPlayerDetails(video, player.data);
        else if (player.reason === "stopped") return { status: "stopped" };
      }

      if (i < videos.length - 1) {
        if (!(await pacedSleep(jitter(job.videoDelayMs)))) return { status: "stopped" };
      }
    }
    return { status: "ok" };
  }

  // ----------------------------------------------------------------- pagination step

  // Returns { status, pageIndex }. status: done | empty | capped | stopped | failed.
  async function paginateTab(channelId, tabIndex, startContinuation, seen, startPageIndex) {
    const tab = CHANNEL_TABS[tabIndex];
    let continuation = startContinuation || null;
    let pageIndex = startPageIndex || 0;
    let banked = 0;
    let restartedFromTop = false;

    while (isCurrent()) {
      const body = continuation
        ? { continuation }
        : { browseId: channelId, params: tab.params };

      const res = await postJson("browse", body);
      if (!res.ok) {
        if (res.reason === "stopped") return { status: "stopped", pageIndex };
        const shapeless = res.reason === "not_found" || res.reason === "endpoint_shape";
        if (banked === 0 && shapeless) {
          // A resumed cursor can simply have expired while the run was paused. Rather than
          // pausing again on every Resume with the same dead token, walk this tab from the
          // top once — shard assembly dedupes by id, so nothing doubles up.
          if (continuation && !restartedFromTop) {
            restartedFromTop = true;
            continuation = null;
            await report("YT_NOTE", {
              detail: tab.label + ": saved cursor purana ho gaya — tab shuru se chala rahe hain",
            });
            if (!(await pacedSleep(jitter(job.pageDelayMs)))) {
              return { status: "stopped", pageIndex };
            }
            continue;
          }
          // A tab the channel does not have reads the same way on its first request. That
          // is not a failure — the channel simply has no past live streams.
          if (!continuation) return { status: "empty", pageIndex };
        }
        await fail(res.reason, tab.label + ": " + res.detail, res.status);
        return { status: "failed", pageIndex };
      }

      const nodes = deepCollect(res.data, VIDEO_KEYS);
      const nextToken = findContinuation(res.data);

      const fresh = [];
      for (const entry of nodes) {
        const video = mapVideoNode(entry, tab.kind);
        if (!video || !video.id || seen.has(video.id)) continue;
        seen.add(video.id);
        fresh.push(video);
      }

      if (!nodes.length && banked === 0 && !continuation) return { status: "empty", pageIndex };

      let details = { status: "ok" };
      if (fresh.length && job.fetchDetails) {
        await report("YT_NOTE", {
          detail:
            tab.label + " p" + (pageIndex + 1) + ": " + fresh.length + " video ki details nikaal rahe hain",
        });
        details = await enrichVideos(fresh);
        if (details.status === "stopped") return { status: "stopped", pageIndex };
      }

      if (fresh.length) {
        const ack = await report("YT_PAGE", {
          channelId,
          videos: fresh,
          nextCursor: nextToken,
          moreAvailable: !!nextToken,
          pageIndex,
          tabIndex,
          source: continuation ? "browse_continuation" : "browse",
        });
        if (!ack || ack.ok === false) return { status: "stopped", pageIndex };
        banked += 1;
      }

      // Banked first, then reported — so a Resume picks up from the next continuation
      // instead of re-crawling videos we already paid a request each for.
      if (details.status === "failed") {
        await fail(details.error.reason, details.error.detail, details.error.httpStatus);
        return { status: "failed", pageIndex: pageIndex + 1 };
      }

      pageIndex += 1;
      continuation = nextToken;

      if (!continuation) return { status: "done", pageIndex };
      if (pageIndex >= HARD_PAGE_CAP) return { status: "capped", pageIndex };
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return { status: "stopped", pageIndex };
    }
    return { status: "stopped", pageIndex };
  }

  // ------------------------------------------------------------------------ main run

  (async function run() {
    if (!onYouTube()) {
      await fail("wrong_origin", "Tab youtube.com pe nahi hai (" + location.href + ")");
      return;
    }
    if (looksLikeConsentWall()) {
      await fail("consent_wall", "YouTube consent page dikh raha hai");
      return;
    }
    if (looksLikeLoginWall()) {
      await fail("login_wall", "Google login page dikh raha hai");
      return;
    }

    CONFIG = readPageConfig();

    let channelId = job.channelId || null;
    let tabIndex = Number(job.tabIndex) || 0;
    let continuation = job.cursor || null;
    let pageIndex = Number(job.pagesFetched) || 0;
    // One set across all three tabs: a past livestream shows up under both Live and Videos.
    const seen = new Set(job.seenVideoIds || []);

    // Fresh channel: read the profile off the landing page. Resuming mid-channel: the
    // worker already has it, so go straight back to the saved continuation.
    if (!channelId) {
      const data = readInitialData();
      if (!data) {
        await fail("endpoint_shape", "Page me ytInitialData nahi mila");
        return;
      }
      const alert = channelAlert(data);
      if (alert) {
        await fail("not_found", alert, 200);
        return;
      }
      const pageProfile = mapChannelProfile(data);
      if (!pageProfile.channel_id) {
        await fail("endpoint_shape", "Channel id nahi mila — layout badal gaya lagta hai", 200);
        return;
      }
      channelId = pageProfile.channel_id;

      // The page itself is rendered in the viewer's own language, so its counts cannot be
      // parsed reliably. One browse call with our English context returns the same channel
      // metadata in a form the number parser can trust. If it fails we keep the page's
      // version — a localized profile still beats no profile, and the counts it cannot
      // read stay null next to their raw *_text.
      let profile = pageProfile;
      const english = await postJson("browse", { browseId: channelId });
      if (english.ok) {
        const fromApi = mapChannelProfile(english.data);
        if (fromApi.channel_id) profile = fromApi;
      } else if (english.reason === "stopped") {
        return;
      }

      const ack = await report("YT_META", { channelId, profile, readable: true });
      if (!ack || ack.ok === false) return;
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return;
    }

    let capped = false;
    for (; tabIndex < CHANNEL_TABS.length; tabIndex++) {
      if (!isCurrent()) return;

      const ack = await report("YT_TAB", { tabIndex, label: CHANNEL_TABS[tabIndex].label });
      if (!ack || ack.ok === false) return;

      const result = await paginateTab(channelId, tabIndex, continuation, seen, pageIndex);
      pageIndex = result.pageIndex;
      continuation = null; // only the resumed tab starts mid-way

      if (result.status === "stopped" || result.status === "failed") return;
      if (result.status === "capped") {
        capped = true;
        break;
      }
    }

    await report("YT_DONE", { capped });
  })();
})();
