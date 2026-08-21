// Insta Handle Finder — Instagram profile/posts fetcher, injected into the driven
// instagram.com tab.
//
// Why the pagination loop lives HERE and not in the service worker: an MV3 worker is
// killed after ~30s idle, so a multi-minute paginated crawl cannot own its own timers.
// The page context can. This script drives the whole account, reporting each page back
// to the worker, which persists the cursor — so a crash, a closed tab or a sleeping
// worker never costs more than the page in flight.
//
// Deliberately does NOT: spoof headers or user-agent, use a proxy, bypass a checkpoint,
// or silently retry through a rate limit. It uses the user's own logged-in session as-is
// and surfaces every block to the UI as a resumable pause.

(function () {
  // Instagram's public web app id. Kept here as a named constant because these private
  // endpoints are undocumented and rotate — this and the paths below are the one-line
  // updates to make when the API shape drifts.
  const FALLBACK_APP_ID = "936619743392459";
  const PROFILE_PATH = "/api/v1/users/web_profile_info/?username=";
  const FEED_PATH = "/api/v1/feed/user/";
  const GRAPHQL_PATH = "/graphql/query/";
  // Long-lived query hashes for edge_owner_to_timeline_media, tried in order.
  const GRAPHQL_HASHES = [
    "e769aa130647d2354c40ea6a439bfc08",
    "472f257a40c653c64c666ce877d59d2b",
    "003056d32c2554def87228bc3fd9668a",
  ];

  const PAGE_SIZE = 33;
  const GRAPHQL_PAGE_SIZE = 50;
  const HARD_PAGE_CAP = 500; // runaway guard, ~16k posts
  const NETWORK_ATTEMPTS = 3;
  const STOP_CHECK_MS = 500;

  const job = window.__IG_JOB__;
  if (!job || !job.handle) return; // seeded by the worker right before injection

  // Re-injection guard: the worker re-injects on resume, and the old loop may still be
  // parked in a sleep. Each loop captures its token and exits the moment a newer one
  // takes over, so two loops can never report into the same account.
  const runToken = job.runToken;
  window.__IG_RUN_TOKEN__ = runToken;
  window.__IG_STOP__ = false;

  function isCurrent() {
    return window.__IG_RUN_TOKEN__ === runToken && !window.__IG_STOP__;
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
        Object.assign({ type, handle: job.handle }, payload)
      );
      // The worker answers { abort:true } when this run is no longer the live one
      // (stopped, reset, or superseded) — stop pulling data nobody will store.
      if (ack && ack.abort) window.__IG_STOP__ = true;
      return ack;
    } catch (e) {
      // Worker gone / extension reloaded mid-run. Nothing can receive results any more.
      window.__IG_STOP__ = true;
      return null;
    }
  }

  function fail(reason, detail, httpStatus) {
    return report("IG_ERROR", {
      reason,
      detail: detail || "",
      httpStatus: httpStatus == null ? null : httpStatus,
    });
  }

  // ---------------------------------------------------------------- request plumbing

  function readCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  }

  // Prefers the app id the page itself is using; falls back to the known public one.
  function detectAppId() {
    try {
      const html = document.documentElement.innerHTML;
      const match =
        html.match(/"X-IG-App-ID"\s*:\s*"(\d+)"/) || html.match(/"appId"\s*:\s*"(\d+)"/);
      if (match) return match[1];
    } catch (e) {
      // innerHTML on a huge document can throw under memory pressure — constant is fine
    }
    return FALLBACK_APP_ID;
  }

  const APP_ID = detectAppId();

  function requestHeaders() {
    const out = {
      "x-ig-app-id": APP_ID,
      "x-requested-with": "XMLHttpRequest",
    };
    const csrf = readCookie("csrftoken");
    if (csrf) out["x-csrftoken"] = csrf;
    return out;
  }

  function onInstagram() {
    const host = location.hostname.toLowerCase().replace(/^www\./, "");
    return host === "instagram.com" || host.endsWith(".instagram.com");
  }

  function looksLikeLoginWall() {
    return /^\/accounts\/(login|onetap)/.test(location.pathname);
  }

  // Classifies a response body once, so a 200-with-error and a 400-challenge are told
  // apart without re-reading the stream.
  function classify(status, text) {
    const lowered = (text || "").toLowerCase();
    if (lowered.includes("challenge_required") || lowered.includes("checkpoint_required")) {
      return "challenge";
    }
    if (lowered.includes("please wait a few minutes") || lowered.includes("rate limit")) {
      return "rate_limit";
    }
    if (status === 401) return "login_wall";
    if (status === 403) return "forbidden";
    if (status === 429) return "rate_limit";
    if (status === 404) return "not_found";
    if (status >= 500) return "network";
    if (lowered.includes("login_required")) return "login_wall";
    return "endpoint_shape";
  }

  // Returns { ok:true, data } or { ok:false, reason, status, detail }.
  // Retries only genuinely transient failures (thrown fetch, 5xx) — an auth wall or a
  // rate limit is never hammered.
  async function getJson(path) {
    let lastDetail = "";
    for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt++) {
      if (!isCurrent()) return { ok: false, reason: "stopped", status: null, detail: "" };

      if (!onInstagram()) {
        return { ok: false, reason: "wrong_origin", status: null, detail: location.href };
      }
      if (looksLikeLoginWall()) {
        return { ok: false, reason: "login_wall", status: null, detail: location.pathname };
      }

      let res;
      try {
        res = await fetch(path, { headers: requestHeaders(), credentials: "include" });
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
        // A 200 that isn't JSON is almost always an HTML login/challenge interstitial.
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

  function isoFromUnix(seconds) {
    const n = Number(seconds);
    if (!n || !isFinite(n)) return null;
    const d = new Date(n * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function bestCandidate(list) {
    if (!Array.isArray(list) || !list.length) return null;
    let best = null;
    for (const candidate of list) {
      if (!candidate || !candidate.url) continue;
      if (!best || (Number(candidate.width) || 0) > (Number(best.width) || 0)) best = candidate;
    }
    return best ? best.url : null;
  }

  function mediaTypeName(code) {
    if (code === 1) return "image";
    if (code === 2) return "video";
    if (code === 8) return "carousel";
    return "unknown";
  }

  function mapChild(item) {
    if (!item) return null;
    return {
      media_type: mediaTypeName(item.media_type),
      display_url: bestCandidate(item.image_versions2 && item.image_versions2.candidates),
      video_url: bestCandidate(item.video_versions),
    };
  }

  function mapTaggedUsers(item) {
    const tags = item && item.usertags && Array.isArray(item.usertags.in) ? item.usertags.in : [];
    const names = [];
    for (const tag of tags) {
      const name = tag && tag.user && tag.user.username;
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function mapLocation(location) {
    if (!location) return null;
    return {
      name: location.name || null,
      pk: location.pk != null ? String(location.pk) : location.id != null ? String(location.id) : null,
    };
  }

  // Feed-API item -> our post schema.
  function mapPost(item) {
    if (!item || (item.pk == null && item.id == null)) return null;
    const id = String(item.pk != null ? item.pk : item.id);
    const shortcode = item.code || null;
    const type = mediaTypeName(item.media_type);
    const children = Array.isArray(item.carousel_media)
      ? item.carousel_media.map(mapChild).filter(Boolean)
      : null;

    let viewCount = null;
    if (typeof item.play_count === "number") viewCount = item.play_count;
    else if (typeof item.view_count === "number") viewCount = item.view_count;

    return {
      id,
      shortcode,
      url: shortcode ? "https://www.instagram.com/p/" + shortcode + "/" : null,
      taken_at: isoFromUnix(item.taken_at),
      media_type: type,
      is_video: type === "video",
      caption: item.caption && typeof item.caption.text === "string" ? item.caption.text : "",
      like_count: typeof item.like_count === "number" ? item.like_count : null,
      comment_count: typeof item.comment_count === "number" ? item.comment_count : null,
      view_count: viewCount,
      display_url: bestCandidate(item.image_versions2 && item.image_versions2.candidates),
      video_url: bestCandidate(item.video_versions),
      carousel_media: children && children.length ? children : null,
      location: mapLocation(item.location),
      tagged_users: mapTaggedUsers(item),
    };
  }

  // GraphQL node -> the same schema, so the output file looks identical whichever
  // source produced it (only the top-level `source` field differs).
  function mapGraphNode(node) {
    if (!node || node.id == null) return null;
    const typename = node.__typename || "";
    const type =
      typename === "GraphVideo" ? "video" : typename === "GraphSidecar" ? "carousel" : "image";
    const captionEdge =
      node.edge_media_to_caption &&
      Array.isArray(node.edge_media_to_caption.edges) &&
      node.edge_media_to_caption.edges[0];
    const childEdges =
      node.edge_sidecar_to_children && Array.isArray(node.edge_sidecar_to_children.edges)
        ? node.edge_sidecar_to_children.edges
        : [];

    const children = childEdges
      .map((edge) => {
        const child = edge && edge.node;
        if (!child) return null;
        return {
          media_type: child.is_video ? "video" : "image",
          display_url: child.display_url || null,
          video_url: child.video_url || null,
        };
      })
      .filter(Boolean);

    let likes = null;
    if (node.edge_liked_by && typeof node.edge_liked_by.count === "number") {
      likes = node.edge_liked_by.count;
    } else if (node.edge_media_preview_like && typeof node.edge_media_preview_like.count === "number") {
      likes = node.edge_media_preview_like.count;
    }

    return {
      id: String(node.id),
      shortcode: node.shortcode || null,
      url: node.shortcode ? "https://www.instagram.com/p/" + node.shortcode + "/" : null,
      taken_at: isoFromUnix(node.taken_at_timestamp),
      media_type: type,
      is_video: type === "video",
      caption: (captionEdge && captionEdge.node && captionEdge.node.text) || "",
      like_count: likes,
      comment_count:
        node.edge_media_to_comment && typeof node.edge_media_to_comment.count === "number"
          ? node.edge_media_to_comment.count
          : null,
      view_count: typeof node.video_view_count === "number" ? node.video_view_count : null,
      display_url: node.display_url || null,
      video_url: node.video_url || null,
      carousel_media: children.length ? children : null,
      location: mapLocation(node.location),
      tagged_users: [],
    };
  }

  function mapProfile(user) {
    const count = (edge) => (edge && typeof edge.count === "number" ? edge.count : null);
    return {
      user_id: String(user.id),
      username: user.username || job.handle,
      full_name: user.full_name || "",
      biography: user.biography || "",
      external_url: user.external_url || null,
      is_private: !!user.is_private,
      is_verified: !!user.is_verified,
      is_business: !!user.is_business_account,
      category: user.category_name || user.business_category_name || user.category || null,
      followers: count(user.edge_followed_by),
      following: count(user.edge_follow),
      posts_count: count(user.edge_owner_to_timeline_media),
      profile_pic_url: user.profile_pic_url || null,
      profile_pic_url_hd: user.profile_pic_url_hd || user.profile_pic_url || null,
    };
  }

  // web_profile_info already carries the first ~12 posts. Using them saves a request and
  // tells us straight away whether there is anything left to paginate.
  function extractSeedPosts(user) {
    const media = user && user.edge_owner_to_timeline_media;
    if (!media || !Array.isArray(media.edges)) return null;
    const posts = media.edges.map((edge) => mapGraphNode(edge && edge.node)).filter(Boolean);
    const info = media.page_info || {};
    return { posts, endCursor: info.end_cursor || null, hasNext: !!info.has_next_page };
  }

  // ------------------------------------------------------------------- profile step

  async function resolveProfile() {
    const res = await getJson(PROFILE_PATH + encodeURIComponent(job.handle));
    if (!res.ok) {
      if (res.reason !== "stopped") await fail(res.reason, res.detail, res.status);
      return null;
    }

    const payload = res.data && res.data.data;
    if (payload && payload.user === null) {
      await fail("not_found", "@" + job.handle + " ka koi profile nahi mila", 200);
      return null;
    }

    const user = payload && payload.user;
    if (!user || user.id == null) {
      await fail("endpoint_shape", "web_profile_info me data.user nahi mila", 200);
      return null;
    }

    const profile = mapProfile(user);
    // A private account we don't follow simply has no readable posts — that's a skip,
    // not a failure, so the profile still gets saved.
    const readable = !profile.is_private || user.followed_by_viewer === true;

    await report("IG_META", { userId: profile.user_id, profile, readable });
    return { profile, readable, user };
  }

  // ----------------------------------------------------------------- pagination step

  async function paginateFeed(userId, startCursor, seenIds, startPageIndex) {
    const seen = new Set(seenIds || []);
    let cursor = startCursor || null;
    let pageIndex = startPageIndex || 0;
    let emptyStreak = 0;
    // Counts pages this endpoint has actually delivered. The caller's pageIndex may
    // already be non-zero (seed page, or a resume), which says nothing about whether the
    // feed API itself has ever worked.
    let banked = 0;

    while (isCurrent()) {
      const path =
        FEED_PATH +
        encodeURIComponent(userId) +
        "/?count=" +
        PAGE_SIZE +
        (cursor ? "&max_id=" + encodeURIComponent(cursor) : "");

      const res = await getJson(path);
      if (!res.ok) {
        if (res.reason === "stopped") return "stopped";
        // The feed endpoint being gone entirely is the signal to try GraphQL — but only
        // before we have banked anything from it. A mid-crawl shape change is a real
        // failure the user should see rather than a silent source switch.
        if ((res.reason === "not_found" || res.reason === "endpoint_shape") && banked === 0) {
          return "fallback";
        }
        await fail(res.reason, res.detail, res.status);
        return "failed";
      }

      const data = res.data || {};
      if (!Array.isArray(data.items)) {
        if (banked === 0) return "fallback";
        await fail("endpoint_shape", "feed response me items[] nahi mila", 200);
        return "failed";
      }

      const fresh = [];
      for (const item of data.items) {
        const post = mapPost(item);
        if (!post || seen.has(post.id)) continue;
        seen.add(post.id);
        fresh.push(post);
      }

      const more = !!data.more_available;
      const nextCursor = data.next_max_id ? String(data.next_max_id) : null;

      if (!data.items.length) {
        // One empty page can be a hiccup; two in a row means we are done or the shape
        // changed. Never spin here.
        emptyStreak += 1;
        if (emptyStreak >= 2 || !more || !nextCursor) {
          await report("IG_DONE", { capped: false });
          return "done";
        }
      } else {
        emptyStreak = 0;
        banked += 1;
        if (fresh.length) {
          const ack = await report("IG_PAGE", {
            userId,
            posts: fresh,
            nextCursor,
            moreAvailable: more,
            pageIndex,
            source: "feed_api",
          });
          if (!ack || ack.ok === false) return "stopped";
        }
      }

      pageIndex += 1;
      cursor = nextCursor;

      if (!more || !cursor) {
        await report("IG_DONE", { capped: false });
        return "done";
      }
      if (pageIndex >= HARD_PAGE_CAP) {
        await report("IG_DONE", { capped: true });
        return "done";
      }
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return "stopped";
    }
    return "stopped";
  }

  // Fallback: classic edge_owner_to_timeline_media cursor pagination.
  async function paginateGraphql(userId, startCursor, seenIds, startPageIndex) {
    const seen = new Set(seenIds || []);
    let cursor = startCursor || null;
    let pageIndex = startPageIndex || 0;
    let hashIndex = 0;

    while (isCurrent()) {
      const variables = JSON.stringify({
        id: String(userId),
        first: GRAPHQL_PAGE_SIZE,
        after: cursor,
      });
      const path =
        GRAPHQL_PATH +
        "?query_hash=" +
        GRAPHQL_HASHES[hashIndex] +
        "&variables=" +
        encodeURIComponent(variables);

      const res = await getJson(path);
      if (!res.ok) {
        if (res.reason === "stopped") return "stopped";
        // A retired query_hash reads as a 404/400 — walk the list before giving up.
        const hashesLeft = hashIndex < GRAPHQL_HASHES.length - 1;
        if ((res.reason === "not_found" || res.reason === "endpoint_shape") && hashesLeft) {
          hashIndex += 1;
          if (!(await pacedSleep(jitter(job.pageDelayMs)))) return "stopped";
          continue;
        }
        if (res.reason === "not_found" || res.reason === "endpoint_shape") return "fallback";
        await fail(res.reason, res.detail, res.status);
        return "failed";
      }

      const media =
        res.data &&
        res.data.data &&
        res.data.data.user &&
        res.data.data.user.edge_owner_to_timeline_media;
      if (!media || !Array.isArray(media.edges)) {
        if (hashIndex < GRAPHQL_HASHES.length - 1) {
          hashIndex += 1;
          continue;
        }
        return "fallback";
      }

      const fresh = [];
      for (const edge of media.edges) {
        const post = mapGraphNode(edge && edge.node);
        if (!post || seen.has(post.id)) continue;
        seen.add(post.id);
        fresh.push(post);
      }

      const info = media.page_info || {};
      const more = !!info.has_next_page;
      const nextCursor = info.end_cursor || null;

      if (fresh.length) {
        const ack = await report("IG_PAGE", {
          userId,
          posts: fresh,
          nextCursor,
          moreAvailable: more,
          pageIndex,
          source: "graphql",
        });
        if (!ack || ack.ok === false) return "stopped";
      }

      pageIndex += 1;
      cursor = nextCursor;

      if (!more || !cursor) {
        await report("IG_DONE", { capped: false });
        return "done";
      }
      if (pageIndex >= HARD_PAGE_CAP) {
        await report("IG_DONE", { capped: true });
        return "done";
      }
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return "stopped";
    }
    return "stopped";
  }

  // Last resort: scroll the rendered grid and harvest shortcodes. Yields a reduced post
  // schema (no counts, no captions) but keeps the feature useful when both JSON paths
  // are gone. Tagged source:"dom" so the file never pretends to be complete data.
  async function harvestDom(userId) {
    const seen = new Set();
    const posts = [];
    let stagnantRounds = 0;
    let pageIndex = 0;

    while (isCurrent() && stagnantRounds < 3 && pageIndex < HARD_PAGE_CAP) {
      const before = posts.length;
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        const match = (anchor.getAttribute("href") || "").match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
        if (!match) continue;
        const shortcode = match[1];
        if (seen.has(shortcode)) continue;
        seen.add(shortcode);
        posts.push({
          id: shortcode,
          shortcode,
          url: "https://www.instagram.com/p/" + shortcode + "/",
          taken_at: null,
          media_type: "unknown",
          is_video: null,
          caption: "",
          like_count: null,
          comment_count: null,
          view_count: null,
          display_url: null,
          video_url: null,
          carousel_media: null,
          location: null,
          tagged_users: [],
        });
      }

      if (posts.length > before) {
        const ack = await report("IG_PAGE", {
          userId,
          posts: posts.slice(before),
          nextCursor: null,
          moreAvailable: true,
          pageIndex,
          source: "dom",
        });
        if (!ack || ack.ok === false) return "stopped";
        stagnantRounds = 0;
      } else {
        stagnantRounds += 1;
      }

      pageIndex += 1;
      window.scrollTo(0, document.body.scrollHeight);
      if (!(await pacedSleep(Math.max(1200, jitter(job.pageDelayMs))))) return "stopped";
    }

    if (!isCurrent()) return "stopped";
    await report("IG_DONE", { capped: pageIndex >= HARD_PAGE_CAP });
    return "done";
  }

  // ------------------------------------------------------------------------ main run

  (async function run() {
    if (!onInstagram()) {
      await fail("wrong_origin", "Tab instagram.com pe nahi hai (" + location.href + ")");
      return;
    }
    if (looksLikeLoginWall()) {
      await fail("login_wall", "Instagram login page dikh raha hai");
      return;
    }

    let userId = job.userId || null;
    let seenIds = job.seenPostIds || [];
    const cursor = job.cursor || null;
    let pageIndex = job.pagesFetched || 0;

    // Fresh account: resolve the profile first. Resuming mid-account: the worker already
    // has it, so go straight back to the saved cursor.
    if (!userId) {
      const resolved = await resolveProfile();
      if (!resolved) return;
      if (!resolved.readable) return; // private — the worker records it and moves on
      userId = resolved.profile.user_id;

      const seed = extractSeedPosts(resolved.user);
      if (seed && seed.posts.length) {
        const ack = await report("IG_PAGE", {
          userId,
          posts: seed.posts,
          // The feed API carries its own cursor, so nothing to hand forward here.
          nextCursor: null,
          moreAvailable: true,
          pageIndex: 0,
          source: "web_profile_info",
        });
        if (!ack || ack.ok === false) return;
        seenIds = seed.posts.map((post) => post.id);
        // Keep the page counter honest: the seed page already counted as page 0.
        pageIndex = 1;
        // If the whole profile fits on that one page there is nothing left to paginate.
        if (!seed.hasNext) {
          await report("IG_DONE", { capped: false });
          return;
        }
      }
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return;
    }

    let outcome = await paginateFeed(userId, cursor, seenIds, pageIndex);

    if (outcome === "fallback") {
      await report("IG_NOTE", { detail: "feed API ne kaam nahi kiya — GraphQL try kar rahe hain" });
      outcome = await paginateGraphql(userId, null, seenIds, pageIndex);
    }
    if (outcome === "fallback") {
      await report("IG_NOTE", { detail: "GraphQL bhi fail — DOM scroll se shortcodes nikaal rahe hain" });
      outcome = await harvestDom(userId);
    }
    if (outcome === "fallback") {
      await fail("endpoint_shape", "feed API, GraphQL aur DOM — teeno fail ho gaye");
    }
  })();
})();
