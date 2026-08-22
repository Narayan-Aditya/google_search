// Insta Handle Finder — LinkedIn search-results post harvester, injected into the driven
// linkedin.com tab.
//
// Same shape as the Instagram and YouTube fetchers: the loop lives HERE because an MV3
// worker dies after ~30s idle while a scroll-through takes minutes, and every batch is
// reported to the worker as it lands, so a crash or a closed tab never costs more than the
// scroll in flight.
//
// Unlike the other two this one reads the *rendered page* rather than a private JSON API.
// That is deliberate: LinkedIn's Voyager endpoints are gated behind decoration ids that
// rotate constantly, whereas search results are an infinite scroll — scrolling is the
// native way to page through them, and the DOM is what the user is already looking at.
//
// Deliberately does NOT: spoof headers or user-agent, use a proxy, bypass the auth wall or
// a checkpoint, log in, or retry through a limit. It drives the user's own logged-in tab
// and surfaces every wall to the UI as a resumable pause.

(function () {
  const STOP_CHECK_MS = 500;
  const RESULTS_WAIT_MS = 25000; // first render can be slow on a cold cache
  const RESULTS_POLL_MS = 500;
  // Scrolls with nothing new before we call it the end. LinkedIn can take a couple of
  // rounds to answer, and stopping early silently truncates the export — the cost of
  // waiting longer is only a few seconds at the very end of a run.
  const STALL_ROUNDS = 6;
  const HARD_ROUND_CAP = 400; // runaway guard

  // Tried in order, most-specific first; the first selector that matches anything wins, so
  // a layout change only has to leave one of them working. Several are deliberately
  // redundant — LinkedIn has shipped all of these wrappers at one time or another.
  const POST_SELECTORS = [
    "[data-chameleon-result-urn]",
    "div.feed-shared-update-v2[data-urn]",
    "[data-urn^='urn:li:activity']",
    "[data-id^='urn:li:activity']",
    "div.fie-impression-container",
    "div.feed-shared-update-v2",
    "[data-view-name='feed-full-update']",
    "div.occludable-update",
    "li.reusable-search__result-container",
    "li.artdeco-list__item",
  ];

  // aria-label survives class-name hashing, so it is listed alongside the class hooks.
  const SEE_MORE_SELECTORS = [
    "button.feed-shared-inline-show-more-text__see-more-less-toggle",
    "button.inline-show-more-text__button",
    ".feed-shared-inline-show-more-text button",
    "button[aria-label*='see more' i]",
    "button[aria-label*='more of this' i]",
  ];

  // A post identity, wherever LinkedIn hangs it. Two spellings are in the wild and both
  // must be read: the classic `urn:li:activity:123…` and the share-link form that appears
  // inside /posts/ URLs, `…_slug-activity-123…-AbCd`.
  const ACTIVITY_ID_RE = /(?:activity|ugcPost|share)[-:](\d{15,25})/;

  const LOAD_MORE_SELECTORS = [
    "button.scaffold-finite-scroll__load-button",
    "button.artdeco-button--muted[aria-label*='more result' i]",
  ];

  const job = window.__LI_JOB__;
  if (!job || !job.searchKey) return; // seeded by the worker right before injection

  // Re-injection guard: the worker re-injects on resume and the old loop may still be
  // parked in a sleep. Each loop captures its token and exits the moment a newer one takes
  // over, so two loops can never report into the same search.
  const runToken = job.runToken;
  window.__LI_RUN_TOKEN__ = runToken;
  window.__LI_STOP__ = false;

  function isCurrent() {
    return window.__LI_RUN_TOKEN__ === runToken && !window.__LI_STOP__;
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
        Object.assign({ type, search: job.searchKey }, payload)
      );
      // The worker answers { abort:true } when this run is no longer the live one
      // (stopped, reset, or superseded) — stop harvesting data nobody will store.
      if (ack && ack.abort) window.__LI_STOP__ = true;
      return ack;
    } catch (e) {
      // Worker gone / extension reloaded mid-run. Nothing can receive results any more.
      window.__LI_STOP__ = true;
      return null;
    }
  }

  function fail(reason, detail) {
    return report("LI_ERROR", { reason, detail: detail || "" });
  }

  // ------------------------------------------------------------------- page state

  function onLinkedIn() {
    const host = location.hostname.toLowerCase().replace(/^www\./, "");
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  }

  function pageText() {
    const body = document.body;
    if (!body) return "";
    return (body.innerText || body.textContent || "").slice(0, 4000).toLowerCase();
  }

  // LinkedIn answers every wall with a rendered page rather than a status code, so the
  // path and the visible copy are all there is to go on.
  function detectWall() {
    const path = location.pathname.toLowerCase();
    if (path.indexOf("/checkpoint/challenge") !== -1) return "challenge";
    if (path.indexOf("/checkpoint") !== -1) return "challenge";
    if (path.indexOf("/authwall") !== -1 || path.indexOf("/login") !== -1) return "login_wall";
    if (path.indexOf("/uas/login") !== -1) return "login_wall";

    const text = pageText();
    if (text.indexOf("sign in to see") !== -1 || text.indexOf("join linkedin") !== -1) {
      // Only trust this when there is no results container — the words also appear in ads.
      if (!findPostNodes().length) return "login_wall";
    }
    if (text.indexOf("you've reached the weekly limit") !== -1) return "rate_limit";
    if (text.indexOf("commercial use limit") !== -1) return "rate_limit";
    if (text.indexOf("too many requests") !== -1) return "rate_limit";
    if (text.indexOf("we restrict") !== -1 && text.indexOf("search") !== -1) return "rate_limit";
    return null;
  }

  // ------------------------------------------------------------------ DOM helpers

  function textOf(el) {
    if (!el) return "";
    // innerText collapses the hidden duplicate spans LinkedIn ships for screen readers;
    // textContent is the fallback for environments that do not implement it.
    const value = typeof el.innerText === "string" && el.innerText ? el.innerText : el.textContent;
    return (value || "").replace(/\s+\n/g, "\n").trim();
  }

  // LinkedIn renders each label twice — once visible, once for screen readers — and the
  // hidden copy is clipped rather than display:none, so it lands in the text either way.
  // Taking the aria-hidden copy is what avoids "Jane DoeJane Doe". aria-* attributes are
  // not touched by class-name hashing, so this keeps working when the classes are gibberish.
  // "Vivek MehtaVivek Mehta" -> "Vivek Mehta". When the screen-reader copy has no
  // aria-hidden sibling to prefer, it lands glued to the visible one.
  function dedupeDoubled(text) {
    const half = text.length / 2;
    if (text.length >= 4 && text.length % 2 === 0 && text.slice(0, half) === text.slice(half)) {
      return text.slice(0, half);
    }
    return text;
  }

  function visibleText(el) {
    if (!el) return "";
    const visible = el.querySelector ? el.querySelector("span[aria-hidden='true']") : null;
    return dedupeDoubled(textOf(visible || el));
  }

  // The card's visible text, line by line, in DOM order. This is the only reading of a
  // card that survives class hashing completely — LinkedIn can rename every wrapper, but
  // the order stays name, headline, age, body.
  function cardLines(node) {
    const out = [];
    let walker;
    try {
      walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    } catch (e) {
      return out;
    }
    let current;
    while ((current = walker.nextNode())) {
      const text = (current.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text) continue;

      const parent = current.parentElement;
      if (parent) {
        // The permalink's own label ("3w", "link") is chrome, not content.
        if (parent.closest("a[href*='/posts/'],a[href*='/feed/update/'],a[href*='activity-']")) {
          continue;
        }
        // LinkedIn marks the *visible* copy of a doubled label aria-hidden="true" and
        // leaves the screen-reader copy unmarked. So an unmarked node with a marked
        // sibling is the copy — and it is not always identical, which is why comparing
        // against the previous line is not enough on its own.
        if (!parent.hasAttribute("aria-hidden") && parent.parentElement) {
          const twin = parent.parentElement.querySelector(":scope > [aria-hidden='true']");
          if (twin && twin !== parent) continue;
        }
      }

      // Consecutive duplicates are the screen-reader copy of the line before.
      if (out.length && out[out.length - 1] === text) continue;
      out.push(text);
      if (out.length >= 40) break;
    }
    return out;
  }

  const AGE_LINE_RE = /^\d+\s*(s|m|h|d|w|mo|yr|y)\b/i;
  const DEGREE_LINE_RE = /^\d+(st|nd|rd|th)\+?$/i;
  const NOISE_LINE_RE = /^(•|·|\+?\s*follow|connect|message|edited|promoted|visible to anyone)$/i;

  // The line under the name — what LinkedIn shows as the author's headline. It is read
  // positionally because on a hashed build there is no class or aria hook left to use.
  function readHeadline(node, name) {
    const lines = cardLines(node);
    let start = 0;
    if (name) {
      const index = lines.indexOf(name);
      if (index >= 0) start = index + 1;
    }
    for (let i = start; i < Math.min(lines.length, start + 8); i++) {
      // Separators travel glued to the label they follow — "• 3rd+" is the connection
      // badge, not a headline, and only reads as one if the bullet is left on.
      const line = String(lines[i] || "")
        .replace(/^[•·・|•\-–—\s]+/, "")
        .trim();
      if (!line || line === name || line.length < 3) continue;
      if (AGE_LINE_RE.test(line) || DEGREE_LINE_RE.test(line) || NOISE_LINE_RE.test(line)) continue;
      return line;
    }
    return null;
  }

  function labelText(root, selector) {
    return visibleText(root.querySelector(selector));
  }

  function firstMatch(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  // A reshare embeds another post card, so only the outermost of any nested pair is a row.
  function outermost(nodes) {
    const unique = Array.from(new Set(nodes)).filter(Boolean).slice(0, 600);
    return unique.filter((node) => !unique.some((other) => other !== node && other.contains(node)));
  }

  // Both spellings normalise to the canonical urn, so ids stay comparable across layouts.
  function urnFromText(value) {
    if (!value || typeof value !== "string") return null;
    const match = value.match(ACTIVITY_ID_RE);
    return match ? "urn:li:activity:" + match[1] : null;
  }

  function urnFromAttributes(el) {
    if (!el || !el.attributes) return null;
    for (const attr of Array.from(el.attributes)) {
      const urn = urnFromText(attr.value);
      if (urn) return urn;
    }
    return null;
  }

  function looksLikeCard(el) {
    if (!el || !el.querySelector) return false;
    return !!(
      el.querySelector("[class*='actor'],[class*='update-components-text']") &&
      el.querySelector("a[href*='/in/'],a[href*='/company/'],a[href*='/school/']")
    );
  }

  // A urn found on a permalink anchor points at the post but *is* not the post — walk up
  // to the card that anchor belongs to, stopping before the ancestor starts covering a
  // different post.
  function promoteToCard(el, urn, others) {
    let card = el;
    for (let hops = 0; hops < 10; hops++) {
      const parent = card.parentElement;
      if (!parent) break;
      // One foreign id inside is a reshare quoting another post — climbing past it is
      // correct. Two or more means we have climbed out into the results list, so stop.
      let foreign = 0;
      for (const other of others) {
        if (other.urn !== urn && parent.contains(other.el)) foreign += 1;
        if (foreign >= 2) break;
      }
      if (foreign >= 2) break;
      card = parent;
      if (looksLikeCard(card)) break;
    }
    return card;
  }

  // Strategy B — ignore class names entirely and go by the activity urn. LinkedIn has to
  // carry it somewhere for its own permalinks and impression tracking, whatever the
  // wrappers are called this month.
  function findByUrnAttributes() {
    let found = [];
    try {
      found = Array.from(
        document.querySelectorAll(
          "[data-urn],[data-id],[data-chameleon-result-urn],[data-activity-urn]," +
            "[data-entity-urn],[data-finite-scroll-hotkey-item]," +
            "a[href*='/feed/update/'],a[href*='/posts/'],a[href*='activity-']"
        )
      )
        .slice(0, 400)
        .map((el) => ({ el, urn: urnFromAttributes(el) }))
        .filter((entry) => !!entry.urn);
    } catch (e) {
      return [];
    }
    if (!found.length) return [];

    // Only anchors and empty markers need promoting; a wrapper that already carries the
    // urn is the card.
    const candidates = found.map((entry) =>
      entry.el.tagName === "A" || !entry.el.children.length
        ? promoteToCard(entry.el, entry.urn, found)
        : entry.el
    );

    // An element that swallows several other candidates is a list wrapper, not a card —
    // keep what is inside it instead. A reshare only ever contains one, so it survives.
    const kept = outermost(candidates);
    const expanded = [];
    for (const node of kept) {
      const inside = candidates.filter((other) => other !== node && node.contains(other));
      if (inside.length > 3) expanded.push(...outermost(inside));
      else expanded.push(node);
    }
    return outermost(expanded);
  }

  // Strategy C — pure structure: the smallest ancestor that holds both an author block and
  // a post body. Survives even a full rename, as long as the page still looks like posts.
  function findByStructure() {
    let actors = [];
    try {
      actors = Array.from(
        document.querySelectorAll("[class*='update-components-actor'],[class*='feed-shared-actor']")
      );
    } catch (e) {
      return [];
    }
    const cards = [];
    for (const actor of actors) {
      let el = actor.parentElement;
      for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
        if (el.querySelector("[class*='update-components-text'],[class*='feed-shared-text']")) {
          cards.push(el);
          break;
        }
      }
    }
    return outermost(cards);
  }

  function isPostLike(el) {
    if (!el || !el.querySelector) return false;
    const link = el.querySelector(
      "a[href*='/in/'],a[href*='/company/'],a[href*='/school/'],a[href*='/posts/'],a[href*='/feed/update/']"
    );
    if (!link) return false;
    return textOf(el).length >= 25;
  }

  // Strategy D — no class names, no urns, no attributes: find the element whose children
  // are all post-shaped and take those children. This is what is left when LinkedIn ships
  // hashed class names and drops the urn from the markup entirely.
  function findByRepeatedSiblings() {
    let anchors = [];
    try {
      anchors = Array.from(
        document.querySelectorAll(
          "a[href*='/posts/'],a[href*='/feed/update/'],a[href*='/in/'],a[href*='/company/']"
        )
      ).slice(0, 600);
    } catch (e) {
      return [];
    }
    if (anchors.length < 3) return [];

    // For every ancestor, remember which of its *direct children* contain a post link. The
    // results list is the ancestor that splits into the most such children — a wrapper
    // above it holds only one child, and a card below it holds only a couple.
    const branches = new Map();
    for (const anchor of anchors) {
      let child = anchor;
      let parent = anchor.parentElement;
      for (let hops = 0; parent && hops < 25; hops++) {
        let set = branches.get(parent);
        if (!set) {
          set = new Set();
          branches.set(parent, set);
        }
        set.add(child);
        child = parent;
        parent = parent.parentElement;
      }
    }

    let best = null;
    for (const [el, children] of branches) {
      if (children.size < 3) continue;
      if (!best || children.size > best.size) best = { el, size: children.size, children };
    }
    if (!best) return [];

    let cards = Array.from(best.children).filter(isPostLike);

    // LinkedIn appends each further page of results as a *new sibling container* rather
    // than into the existing one. Taking only the biggest container therefore harvests the
    // first batch and then reports "nothing new" forever, which is what capped a run at
    // one screenful. Sweep the siblings for the same shape and take the union.
    const parent = best.el.parentElement;
    if (parent) {
      for (const sibling of Array.from(parent.children)) {
        if (sibling === best.el) continue;
        const siblingChildren = branches.get(sibling);
        if (!siblingChildren || siblingChildren.size < 2) continue;
        const siblingCards = Array.from(siblingChildren).filter(isPostLike);
        if (siblingCards.length >= 2) cards = cards.concat(siblingCards);
      }
    }

    return cards.length >= 3 ? outermost(cards) : [];
  }

  // Remembered so the log can say which strategy carried the run.
  let lastStrategy = "";

  // The urn scan goes first on purpose. A named selector only knows about the elements it
  // matches, so when a reshare's quoted post carries `data-urn` and the outer card does
  // not, the selector returns the quoted post and the real one is lost. The scan sees every
  // urn on the page at once and can tell which card contains which.
  function findPostNodes() {
    const byUrn = findByUrnAttributes();
    if (byUrn.length) {
      lastStrategy = "activity-urn scan";
      return byUrn;
    }

    for (const selector of POST_SELECTORS) {
      let nodes;
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (e) {
        continue; // selector unsupported in this browser
      }
      if (!nodes.length) continue;
      const outer = outermost(nodes);
      if (outer.length) {
        lastStrategy = "selector " + selector;
        return outer;
      }
    }

    const byShape = findByStructure();
    if (byShape.length) {
      lastStrategy = "structure (actor + text)";
      return byShape;
    }

    const bySiblings = findByRepeatedSiblings();
    if (bySiblings.length) {
      lastStrategy = "repeated siblings";
      return bySiblings;
    }

    lastStrategy = "";
    return [];
  }

  const COUNT_SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };

  // "1,234" -> 1234, "1.2K" -> 1200, "" -> null. Same stance as the other fetchers: a
  // number it cannot read confidently comes back null rather than as a guess.
  function parseCount(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return null;
    const abbrev = text.match(/(?:^|[^\d.,])(\d+(?:\.\d+)?)\s*([KMB])\b/i);
    if (abbrev) {
      const value = Math.round(parseFloat(abbrev[1]) * COUNT_SUFFIX[abbrev[2].toLowerCase()]);
      return isFinite(value) ? value : null;
    }
    const digits = text.match(/\d[\d,.\s]*\d|\d/);
    if (!digits) return null;
    const cleaned = digits[0];
    if (!/^\d+$|^\d{1,3}([,.\s]\d{3})+$/.test(cleaned)) return null;
    const value = parseInt(cleaned.replace(/\D/g, ""), 10);
    return isFinite(value) ? value : null;
  }

  // A LinkedIn activity id carries its creation time in its top 41 bits, which is the only
  // exact timestamp available here — the page itself only ever shows "2d".
  function isoFromUrn(urn) {
    const match = String(urn || "").match(/urn:li:(?:activity|share|ugcPost):(\d+)/);
    if (!match) return null;
    let ms;
    try {
      ms = Number(BigInt(match[1]) >> BigInt(22));
    } catch (e) {
      return null;
    }
    // Sanity-check the decode instead of trusting it: LinkedIn launched in 2003, and a
    // future timestamp means the id was not what we thought.
    if (!isFinite(ms) || ms < 1041379200000 || ms > Date.now() + 86400000) return null;
    return new Date(ms).toISOString();
  }

  // Query strings are dropped by default because LinkedIn hangs tracking (?trk=, ?utm_)
  // off every link. Media is the exception: its query carries the CDN signature, and a
  // stripped media URL is a broken one.
  function absoluteUrl(href, keepQuery) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin).href;
      return keepQuery ? url : url.split("?")[0];
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ post mapping

  function readUrn(node) {
    // The card's own attributes first — on a reshare the quoted post carries a urn too,
    // and the outer post's own id must win.
    const own = urnFromAttributes(node);
    if (own) return own;

    // The post's permalink (its timestamp or overflow menu) spells the id out in the href —
    // either as a urn under /feed/update/, or as `-activity-<id>-` under /posts/.
    for (const link of Array.from(
      node.querySelectorAll("a[href*='/feed/update/'],a[href*='/posts/'],a[href*='activity-']")
    ).slice(0, 20)) {
      const fromHref = urnFromText(link.getAttribute("href") || "");
      if (fromHref) return fromHref;
    }

    for (const el of Array.from(
      node.querySelectorAll("[data-urn],[data-id],[data-activity-urn],[data-entity-urn]")
    )) {
      const found = urnFromAttributes(el);
      if (found) return found;
    }
    return null;
  }

  // The post's own link. The current layout points at /posts/<slug>-activity-<id>-<hash>;
  // older ones at /feed/update/urn:li:activity:<id>.
  function readPermalink(node) {
    const link = node.querySelector(
      "a[href*='/posts/'],a[href*='/feed/update/'],a[href*='activity-']"
    );
    return link ? absoluteUrl(link.getAttribute("href")) : null;
  }

  function readAuthor(node) {
    const actor = node.querySelector(".update-components-actor") || node;

    // The avatar and the name are two separate links to the same profile, and only one of
    // them carries text. Taking the first match returns the avatar, whose text is empty —
    // which is how the name came back null while the profile URL came back fine.
    const profileLinks = Array.from(
      node.querySelectorAll("a[href*='/in/'],a[href*='/company/'],a[href*='/school/']")
    ).slice(0, 12);
    const namedLink = profileLinks.find((el) => visibleText(el).length > 1);
    const link =
      actor.querySelector("a.update-components-actor__meta-link[href]") ||
      namedLink ||
      profileLinks[0] ||
      null;
    const profileUrl = absoluteUrl(link && link.getAttribute("href"));

    let type = null;
    if (profileUrl && profileUrl.indexOf("/in/") !== -1) type = "person";
    else if (profileUrl && profileUrl.indexOf("/company/") !== -1) type = "company";
    else if (profileUrl && profileUrl.indexOf("/school/") !== -1) type = "school";

    let name =
      labelText(actor, ".update-components-actor__title") ||
      labelText(actor, ".update-components-actor__name") ||
      labelText(node, "[class*='actor__title']");
    if (!name && namedLink) name = visibleText(namedLink).split("\n")[0];
    // Last resort: the first line of the card is the author's name.
    if (!name) {
      const lines = cardLines(node);
      if (lines.length && lines[0].length < 80) name = lines[0];
    }

    const headline =
      labelText(actor, ".update-components-actor__description") ||
      labelText(node, "[class*='actor__description']") ||
      readHeadline(node, name);

    return {
      name: name || null,
      headline: headline || null,
      profile_url: profileUrl,
      type,
    };
  }

  function readPostedText(node) {
    const raw =
      labelText(node, ".update-components-actor__sub-description") ||
      labelText(node, "[class*='sub-description']");
    // With hashed class names there is no sub-description to find, so fall back to the
    // shape of the label itself: always a short relative age like "2d" or "3h •".
    if (!raw) {
      for (const el of Array.from(node.querySelectorAll("time,span,div")).slice(0, 80)) {
        const text = textOf(el);
        if (text.length <= 24 && /^\d+\s*(s|m|h|d|w|mo|yr|y)\b/i.test(text)) return text;
      }
      return null;
    }
    // "2d • Edited • Visible to anyone" -> "2d • Edited"
    return raw.split("\n")[0].replace(/\s*•\s*Visible to anyone.*$/i, "").trim() || null;
  }

  // The counts are the one place LinkedIn is generous: every button carries an aria-label
  // that spells the number out ("1,234 reactions"), which survives icon-only redesigns.
  function readSocialCounts(node) {
    const counts = { reaction_count: null, comment_count: null, repost_count: null };
    const social =
      node.querySelector(".social-details-social-counts") ||
      node.querySelector("[class*='social-details-social-counts']") ||
      node;

    const labelled = Array.from(social.querySelectorAll("[aria-label]"));
    for (const el of labelled) {
      const label = el.getAttribute("aria-label") || "";
      const value = parseCount(label);
      if (value == null) continue;
      if (counts.reaction_count == null && /reaction|like/i.test(label)) counts.reaction_count = value;
      else if (counts.comment_count == null && /comment/i.test(label)) counts.comment_count = value;
      else if (counts.repost_count == null && /repost|share/i.test(label)) counts.repost_count = value;
    }

    if (counts.reaction_count == null) {
      const el = firstMatch(social, [
        ".social-details-social-counts__reactions-count",
        "[class*='reactions-count']",
      ]);
      if (el) counts.reaction_count = parseCount(textOf(el));
    }
    // Older and low-engagement posts render the whole row as plain text with no labels
    // and no count element — "89 reactions", "12 comments" — so read those directly.
    if (counts.reaction_count == null || counts.comment_count == null || counts.repost_count == null) {
      for (const el of Array.from(social.querySelectorAll("button, span, li"))) {
        const text = textOf(el);
        // The length guard keeps post copy that happens to contain "comments" out of it.
        if (!text || text.length > 40) continue;
        if (counts.reaction_count == null && /\breactions?\b|\blikes?\b/i.test(text)) {
          counts.reaction_count = parseCount(text);
        }
        if (counts.comment_count == null && /\bcomments?\b/i.test(text)) {
          counts.comment_count = parseCount(text);
        }
        if (counts.repost_count == null && /\breposts?\b|\bshares?\b/i.test(text)) {
          counts.repost_count = parseCount(text);
        }
      }
    }
    return counts;
  }

  // Told apart from post media by where it sits and how big it is, not by its class name —
  // an avatar lives inside the author link and is served from a profile-photo path.
  function isAvatarImage(img) {
    const src = img.getAttribute("src") || "";
    const cls = String(img.className || "");
    if (/EntityPhoto|profile-displayphoto|company-logo|reaction|ghost|static\.licdn/i.test(src + " " + cls)) {
      return true;
    }
    if (img.closest && img.closest("a[href*='/in/'],a[href*='/company/'],a[href*='/school/'],button")) {
      return true;
    }
    const width = Number(img.getAttribute("width")) || 0;
    const height = Number(img.getAttribute("height")) || 0;
    return !!(width && width <= 120 && height && height <= 120);
  }

  function readMedia(node) {
    const images = [];
    for (const img of Array.from(node.querySelectorAll("img")).slice(0, 40)) {
      const src = img.getAttribute("src") || "";
      if (!src || src.indexOf("data:") === 0) continue;
      if (isAvatarImage(img)) continue;
      const absolute = absoluteUrl(src, true);
      if (absolute && images.indexOf(absolute) === -1) images.push(absolute);
    }

    // The first external link in the card is the shared article. Anything pointing back at
    // linkedin.com is navigation, not the post's subject.
    let articleUrl = null;
    for (const link of Array.from(node.querySelectorAll("a[href]")).slice(0, 40)) {
      const href = link.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) continue;
      let host = "";
      try {
        host = new URL(href).hostname.toLowerCase();
      } catch (e) {
        continue;
      }
      if (host.indexOf("linkedin.com") !== -1 || host.indexOf("licdn.com") !== -1) continue;
      articleUrl = absoluteUrl(href);
      break;
    }

    // aria-label and element type survive class hashing; the class hooks stay as a fast
    // path for the layouts that still have them.
    let type = null;
    if (node.querySelector("video,[class*='linkedin-video'],[aria-label*='video' i]")) {
      type = "video";
    } else if (
      node.querySelector("iframe,[class*='document-s-container'],[class*='update-components-document'],[aria-label*='document' i]")
    ) {
      type = "document";
    } else if (node.querySelector("[class*='update-components-poll'],[aria-label*='poll' i]")) {
      type = "poll";
    } else if (articleUrl) {
      type = "article";
    } else if (images.length) {
      type = "image";
    }

    return { media_type: type, media_urls: images, article_url: articleUrl };
  }

  // The card's direct child that holds the author link — name, headline, degree badge, age
  // and the follow button all live inside it. Everything the post itself says is outside.
  function authorBranch(node) {
    const link = node.querySelector("a[href*='/in/'],a[href*='/company/'],a[href*='/school/']");
    if (!link) return null;
    let branch = link;
    while (branch.parentElement && branch.parentElement !== node) branch = branch.parentElement;
    return branch.parentElement === node ? branch : null;
  }

  function readText(node, author) {
    const el = firstMatch(node, [
      ".update-components-text",
      ".feed-shared-update-v2__description",
      ".update-components-update-v2__commentary",
      "[class*='update-components-text']",
    ]);
    if (el) return cleanBody(textOf(el), el);

    // Class-free fallback: the body is the longest run of text in the card once the whole
    // author branch is out of the way. Excluding that branch — rather than excluding text
    // that matches the headline — is what keeps this from being circular: the headline is
    // only known after the body is, because a card with no headline borrows the post's
    // first line.
    //
    // Buttons are deliberately NOT excluded: the body container holds the "…see more"
    // toggle, and excluding it skipped the post text entirely.
    // Pass 1: everything outside the author branch.
    let picked = longestBlock(node, authorBranch(node));
    // Pass 2: when the detected card is one wrapper above the real one, its only child
    // holds the author *and* the post, so pass 1 excludes the whole card and comes back
    // empty. Dropping the branch rule still leaves the actor block out, because that
    // subtree is the one holding the profile link.
    if (!picked.text) picked = longestBlock(node, null);
    // Pass 3: nothing but the author block is an element of its own — read the card's own
    // lines and drop the author chrome off the front.
    if (!picked.text) return cleanBody(bodyFromLines(node, author), null);
    return cleanBody(picked.text, picked.el);
  }

  function longestBlock(node, branch) {
    let best = "";
    let bestEl = null;
    for (const candidate of Array.from(node.querySelectorAll("span,p,div")).slice(0, 300)) {
      if (branch && (branch === candidate || branch.contains(candidate))) continue;
      if (candidate.querySelector("a[href*='/in/'],a[href*='/company/'],a[href*='/school/']")) {
        continue;
      }
      const text = textOf(candidate).trim();
      if (!text) continue;
      // >= so that the innermost of two elements with the same text wins — children come
      // after their parents in document order.
      if (text.length >= best.length) {
        best = text;
        bestEl = candidate;
      }
    }
    return { text: best, el: bestEl };
  }

  // The body element contains the expand toggle, so the toggle's label rides along on the
  // end of the text. Subtracting the control's own words beats guessing at them — LinkedIn
  // writes "…see more", "… more" and "see less" depending on the build and the language.
  function cleanBody(text, el) {
    let out = String(text || "").trim();
    if (el && el.querySelectorAll) {
      for (const control of Array.from(el.querySelectorAll("button,[role='button']")).slice(0, 10)) {
        const label = textOf(control).trim();
        if (!label || label.length > 30) continue;
        if (out.slice(-label.length) === label) out = out.slice(0, out.length - label.length).trim();
      }
    }
    // Safety net for a toggle that is not a button. The ellipsis is required, so a post
    // that genuinely ends in "and much more" keeps its last words.
    out = out.replace(/\s*(?:(?:…|\.\.\.)\s*(?:see\s+)?(?:more|less)|see\s+(?:more|less))\s*$/i, "");
    return out.replace(/\s*(?:…|\.\.\.)\s*$/, "").trim();
  }

  // Last resort: the card's text lines with the author chrome trimmed off the front and
  // the reaction counts trimmed off the back.
  function bodyFromLines(node, author) {
    const lines = cardLines(node).map((line) => String(line).replace(/^[•·・|\-–—\s]+/, "").trim());
    const name = author && author.name;
    const headline = author && author.headline;

    let start = 0;
    while (start < lines.length) {
      const line = lines[start];
      const isChrome =
        !line ||
        line === name ||
        line === headline ||
        AGE_LINE_RE.test(line) ||
        DEGREE_LINE_RE.test(line) ||
        NOISE_LINE_RE.test(line);
      if (!isChrome) break;
      start += 1;
    }

    const body = lines.slice(start);
    while (body.length && /^[\d.,\s]*[KMB]?$/i.test(body[body.length - 1])) body.pop();
    return body.join("\n").trim();
  }

  // A reshare is either announced in a header line, or given away by a second, different
  // post id nested inside this card. The second test needs no class names at all.
  function readIsRepost(node, ownId) {
    if (node.querySelector("[class*='mini-update-v2'],[class*='update-components-header']")) {
      return true;
    }
    for (const el of Array.from(
      node.querySelectorAll("[data-urn],[data-id],a[href*='/posts/'],a[href*='/feed/update/']")
    ).slice(0, 30)) {
      const other = urnFromAttributes(el);
      if (other && other !== ownId) return true;
    }
    return /\breposted this\b|\bshared this\b/i.test(textOf(node).slice(0, 200));
  }

  // Cheap stable hash, only used to give a post an identity when its urn has moved.
  function stableHash(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  function mapPost(node) {
    const urn = readUrn(node);
    // Author first: knowing the name and the headline is what lets the body reader tell
    // the post apart from the lines above it.
    const author = readAuthor(node);
    const text = readText(node, author);
    // If the line taken as a headline turns out to open the post, this card simply has no
    // headline — better an honest null than the first sentence of the post.
    if (author.headline && text && text.indexOf(author.headline) === 0) author.headline = null;

    // A missing urn used to drop the post entirely, which turned one moved attribute into
    // an empty export. Fall back to a fingerprint of the content instead: the post keeps
    // all its data and still dedupes across scrolls, it just has no permalink.
    let id = urn;
    if (!id) {
      const fingerprint = (author.profile_url || author.name || "") + "|" + text.slice(0, 160);
      if (!fingerprint.replace(/\|/g, "").trim()) return null; // an empty card, not a post
      id = "li:hash:" + stableHash(fingerprint);
    }

    const counts = readSocialCounts(node);
    const media = readMedia(node);

    return {
      id,
      urn: urn || null,
      url: urn ? "https://www.linkedin.com/feed/update/" + urn + "/" : null,
      author,
      text,
      posted_text: readPostedText(node),
      posted_at: isoFromUrn(urn),
      permalink: readPermalink(node),
      reaction_count: counts.reaction_count,
      comment_count: counts.comment_count,
      repost_count: counts.repost_count,
      media_type: media.media_type,
      media_urls: media.media_urls,
      article_url: media.article_url,
      is_repost: readIsRepost(node, id),
    };
  }

  // Names what the page actually contains, so a layout change reads as a diagnosable line
  // in the log instead of a silent zero. When nothing matched at all it dumps the shape of
  // the results area, which is what tells us the next selector to add.
  function describePage() {
    const counts = [];
    for (const selector of POST_SELECTORS) {
      let n = 0;
      try {
        n = document.querySelectorAll(selector).length;
      } catch (e) {
        n = 0;
      }
      if (n) counts.push(selector + " x" + n);
    }
    const byUrn = findByUrnAttributes().length;
    const byShape = findByStructure().length;
    const bySiblings = findByRepeatedSiblings().length;
    if (byUrn) counts.push("urn-scan x" + byUrn);
    if (byShape) counts.push("structure x" + byShape);
    if (bySiblings) counts.push("siblings x" + bySiblings);
    if (counts.length) {
      return (lastStrategy ? "via " + lastStrategy + " — " : "") + counts.join(", ");
    }

    // Nothing recognised. Report the actual DOM under the results area so the fix can be
    // made without another round trip.
    const linkCount = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch (e) {
        return -1;
      }
    };
    const parts = [
      "path=" + location.pathname,
      "activity-id-in-html=" +
        (ACTIVITY_ID_RE.test(document.documentElement.innerHTML || "") ? "yes" : "no"),
      "post-links=" + linkCount("a[href*='/posts/']"),
      "update-links=" + linkCount("a[href*='/feed/update/']"),
      "profile-links=" + linkCount("a[href*='/in/']"),
      "aria-reaction-btns=" + linkCount("[aria-label*='reaction' i]"),
    ];
    const main = document.querySelector("main") || document.body;
    if (main) {
      const kids = Array.from(main.querySelectorAll("*"))
        .slice(0, 4000)
        .filter((el) => el.children.length >= 3);
      // The element with the most same-shaped children is almost always the results list.
      let best = null;
      for (const el of kids) {
        if (!best || el.children.length > best.children.length) best = el;
      }
      if (best) {
        parts.push("biggest-list=" + best.tagName.toLowerCase() + "." + String(best.className).trim().split(/\s+/).slice(0, 3).join("."));
        parts.push("children=" + best.children.length);
        const child = best.children[0];
        if (child) {
          parts.push("child=" + child.tagName.toLowerCase() + "." + String(child.className).trim().split(/\s+/).slice(0, 3).join("."));
          const attrs = Array.from(child.attributes || [])
            .filter((a) => a.name.indexOf("data-") === 0)
            .map((a) => a.name)
            .slice(0, 6);
          if (attrs.length) parts.push("child-data-attrs=" + attrs.join(","));
        }
      }
    }
    return "koi post node nahi mila (" + parts.join(", ") + ")";
  }

  // ------------------------------------------------------------------ scroll loop

  async function waitForResults() {
    const until = Date.now() + RESULTS_WAIT_MS;
    let polls = 0;
    while (Date.now() < until) {
      if (!isCurrent()) return false;
      const wall = detectWall();
      if (wall) {
        await fail(wall, location.pathname);
        return false;
      }
      if (findPostNodes().length) return true;

      // A tab opened programmatically is never scrolled, and LinkedIn defers rendering the
      // list until something moves. Nudge it every few polls — cheap, and it is the
      // difference between an empty page and a full one.
      polls += 1;
      if (polls % 4 === 0) {
        try {
          window.scrollBy(0, 400);
          window.scrollTo(0, 0);
        } catch (e) {
          // No layout in this context; the poll loop is still the real wait.
        }
      }
      await sleep(RESULTS_POLL_MS);
    }
    return findPostNodes().length > 0;
  }

  // Opens every truncated post in view. LinkedIn only ships the first ~200 characters
  // until this is clicked, so without it most of `text` would end in "…see more".
  function expandTruncatedPosts() {
    const buttons = new Set();
    for (const selector of SEE_MORE_SELECTORS) {
      try {
        for (const button of Array.from(document.querySelectorAll(selector))) buttons.add(button);
      } catch (e) {
        // Selector unsupported here; the others still apply.
      }
    }
    // Last resort for a hashed layout with no aria-label either: match the button's own
    // wording. Bounded so a page full of buttons cannot turn this into a scan.
    if (!buttons.size) {
      for (const button of Array.from(document.querySelectorAll("button")).slice(0, 400)) {
        const text = textOf(button);
        if (text.length <= 24 && /see more|…\s*more|\bmore\b$/i.test(text)) buttons.add(button);
      }
    }

    let clicked = 0;
    for (const button of buttons) {
      const label = (button.getAttribute("aria-label") || textOf(button)).toLowerCase();
      if (label.indexOf("less") !== -1) continue; // already expanded
      try {
        button.click();
        clicked += 1;
      } catch (e) {
        // A detached or disabled button is not worth failing the round over.
      }
    }
    return clicked;
  }

  const LOAD_MORE_TEXT_RE = /(show|see|load)\s+more|more\s+results?/i;

  function clickLoadMore() {
    for (const selector of LOAD_MORE_SELECTORS) {
      const button = document.querySelector(selector);
      if (!button || button.disabled) continue;
      try {
        button.click();
        return true;
      } catch (e) {
        // Fall through to the text search below.
      }
    }

    // The class hooks above are gone on a hashed build, so find the button by what it
    // says. Without this, the run stops at whatever LinkedIn auto-loaded before it
    // switched to asking for a click.
    for (const button of Array.from(document.querySelectorAll("button,[role='button']")).slice(0, 400)) {
      if (button.disabled) continue;
      const label = (button.getAttribute("aria-label") || "") + " " + textOf(button);
      if (!label.trim() || label.length > 60) continue;
      if (!LOAD_MORE_TEXT_RE.test(label)) continue;
      try {
        button.click();
        return true;
      } catch (e) {
        // Detached mid-click; the next round will try again.
      }
    }
    return false;
  }

  // Some layouts scroll an inner element instead of the window; whichever one actually
  // holds the overflow is the one that has to move.
  function scrollToBottom() {
    try {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } catch (e) {
      // No layout in this context.
    }
    const nodes = findPostNodes();
    let el = nodes.length ? nodes[nodes.length - 1] : null;
    for (let hops = 0; el && hops < 12; hops++, el = el.parentElement) {
      if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 40) {
        try {
          el.scrollTop = el.scrollHeight;
        } catch (e) {
          // Not scrollable after all.
        }
        return;
      }
    }
  }

  (async function run() {
    if (!onLinkedIn()) {
      await fail("wrong_origin", "Tab linkedin.com pe nahi hai (" + location.href + ")");
      return;
    }

    const wall = detectWall();
    if (wall) {
      await fail(wall, location.pathname);
      return;
    }

    if (!(await waitForResults())) {
      if (!isCurrent()) return;
      await fail("no_results", "Results render nahi hue — " + describePage());
      return;
    }

    await report("LI_NOTE", { detail: "Results mil gaye — " + describePage() });

    const seen = new Set(job.seenPostIds || []);
    let round = job.roundsDone || 0;
    let harvested = job.postsCount || 0;
    let stalls = 0;
    let warnedUnreadable = false;
    const maxPosts = Number(job.maxPosts) > 0 ? Number(job.maxPosts) : Infinity;

    while (isCurrent() && round < HARD_ROUND_CAP) {
      expandTruncatedPosts();
      // A click only swaps text in; one frame is enough before reading it back.
      if (!(await pacedSleep(400))) return;

      const nodes = findPostNodes();
      const fresh = [];
      let readable = 0;
      for (const node of nodes) {
        const post = mapPost(node);
        if (!post) continue;
        readable += 1;
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        fresh.push(post);
        if (seen.size >= maxPosts) break;
      }

      // Cards on the page that yield nothing is the one failure that used to look exactly
      // like "this search has no results". Say it out loud, once, with what was found.
      if (nodes.length && !readable && !warnedUnreadable) {
        warnedUnreadable = true;
        await report("LI_NOTE", {
          detail:
            nodes.length + " post card mile par unme se data nahi nikla — " + describePage(),
        });
      }

      if (fresh.length) {
        harvested += fresh.length;
        stalls = 0;
        const ack = await report("LI_PAGE", {
          posts: fresh,
          round,
          onPage: nodes.length,
          source: "dom",
        });
        if (!ack || ack.ok === false) return;
      } else {
        stalls += 1;
      }

      if (harvested >= maxPosts) {
        await report("LI_DONE", { reachedLimit: true, foundNothing: false, page: describePage() });
        return;
      }
      if (stalls >= STALL_ROUNDS) {
        await report("LI_DONE", { reachedLimit: false, foundNothing: harvested === 0, page: describePage() });
        return;
      }

      // Scroll first; if LinkedIn is showing an explicit button instead, press that. The
      // click is also tried when the page did grow, because LinkedIn often renders the
      // button *and* keeps growing by a little.
      const before = document.documentElement.scrollHeight;
      scrollToBottom();
      if (!(await pacedSleep(jitter(job.scrollDelayMs)))) return;
      const grew = document.documentElement.scrollHeight > before;
      if (!grew || !fresh.length) {
        if (clickLoadMore() && !(await pacedSleep(jitter(job.scrollDelayMs)))) return;
      }

      const laterWall = detectWall();
      if (laterWall) {
        await fail(laterWall, location.pathname);
        return;
      }

      round += 1;
    }

    if (!isCurrent()) return;
    await report("LI_DONE", {
      reachedLimit: round >= HARD_ROUND_CAP,
      foundNothing: harvested === 0,
      page: describePage(),
    });
  })();
})();
