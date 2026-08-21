# Insta Handle Finder

Three tools in one side panel, switched with the tabs at the top:

| Mode | What it does |
|---|---|
| **Google handles** | Walks `site:instagram.com "<city>"` Google results and collects public profile handles. |
| **Instagram profiles** | Takes profile URLs/handles and exports each account's full profile + every post to `<handle>.json`. |
| **YouTube channels** | Takes channel URLs/@handles and exports each channel's full profile + every video to `<handle>.json`. |

They are independent — separate runs, separate tabs, separate saved state — so
the natural workflow is to find handles in the first mode and feed them into the
second.

## Setup

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `extension` folder.
4. The extension icon (purple "IH") should appear in the toolbar. Pin it for
   easy access if you like.
5. Clicking the icon opens the extension as a **side panel** docked to the
   right of the browser window (not a dropdown popup) — it stays open and
   keeps its own state even as the tab next to it navigates from page to
   page, so it never reloads or loses progress mid-run.

Whenever you (or I) change any of the extension's files, come back to
`chrome://extensions` and click the reload icon (🔄) on the extension's card
to pick up the changes.

### Permissions it asks for, and why

Chrome shows these on the extension's card. Nothing here talks to a server that
isn't Google or Instagram — there is no backend, no telemetry, no account.

| Permission | Why it is needed |
|---|---|
| `tabs`, `scripting` | Open and drive the one working tab, and inject the scraper into it |
| `storage`, `unlimitedStorage` | Keep run state and collected posts across restarts; a 16k-post account exceeds the default 10 MB quota |
| `alarms` | Pace the run in a way that survives the service worker being shut down |
| `notifications` | Tell you when a run pauses and needs you |
| `sidePanel` | The UI itself |
| `downloads` | Save `<handle>.json` |
| `offscreen` | A service worker can't create a blob URL, so a hidden page does it |
| `https://www.google.com/*` | Mode 1 — read search results |
| `https://www.instagram.com/*`, `https://instagram.com/*`, `https://i.instagram.com/*` | Mode 2 — open the profile and read its data as your logged-in session |
| `https://www.youtube.com/*`, `https://youtube.com/*`, `https://m.youtube.com/*` | Mode 3 — open the channel and read its data as your logged-in session |

> After adding a new host permission, Chrome may show the extension as needing
> re-enabling on the `chrome://extensions` card the first time. Toggle it off and
> on if a mode does nothing at all.

---

## Mode 1 — Google handles

1. Click the toolbar icon to open the side panel.
2. **Cities** — type or paste city names, one per line. You can also paste a
   comma-separated list (`lucknow,kanpur,agra`) — it auto-converts to one
   city per line.
3. **Max pages / city** — how many Google result pages to walk per city
   (1–50). Each page is ~10 results. Default is `3`.
4. **Delay between pages (s)** — wait time between page loads (min 5,
   default `10`). Lower delay = faster but more likely to trigger a CAPTCHA.
5. Click **Start**. A new tab opens and starts walking through
   `site:instagram.com "<city>"` results, page by page, city by city.
6. Watch the **live status/log** in the side panel — current city, current page,
   and how many new handles were found on each page.
7. Click **Download JSON** any time (even mid-run) to save whatever has been
   collected so far.

### If a CAPTCHA/block shows up

- The run **pauses automatically** and you'll get a **desktop notification**
  ("Insta Handle Finder — Paused"). Clicking the notification brings the
  driven tab to the front.
- Solve the CAPTCHA yourself in that tab.
- Come back to the side panel and click **Resume** — it re-loads the same page it
  paused on and continues from there.
- The run only ever moves forward when you click Resume — there's no
  automatic retry.

### Reset

The **Reset** button clears the current run's results, log, and settings
back to defaults. It asks for confirmation first since this is not
reversible — **download your JSON before resetting** if you want to keep it.

### Output format

```json
{
  "generated_at": "2026-08-18T12:00:00.000Z",
  "query_template": "site:instagram.com \"<city>\"",
  "max_pages_per_city": 3,
  "delay_seconds": 10,
  "status": "done",
  "total_handles": 23,
  "cities": {
    "lucknow": [
      { "handle": "@nowlucknow", "profile_url": "https://www.instagram.com/nowlucknow/" }
    ],
    "kanpur": [ ... ]
  }
}
```

- Handles are deduped **globally** — if the same handle shows up for two
  different cities, it's only kept under whichever city found it first.
- Only URLs shaped like `instagram.com/<single-segment-handle>/` are kept —
  posts, reels, stories, explore, and similar non-profile links are filtered
  out.

### Good to know / limits

- **No early exit**: every city runs through its full "Max pages" setting,
  even if some pages turn up zero new handles. Deep page counts (30–50) can
  take a while — each page waits `delaySec` seconds, plus a longer pause
  when moving to the next city.
- **Nothing is evaded**: the extension uses your real logged-in browser tab
  as-is — no proxies, no spoofed headers, no hidden/parallel tabs, no
  CAPTCHA automation. This keeps it simple but means it's still subject to
  normal Google rate-limiting.
- **Progress survives side panel close**: closing the side panel doesn't stop
  the run; it keeps going in the driven tab. Reopen the panel any time to see
  where it's at.
- **Progress survives browser restart... partially**: if Chrome restarts
  mid-run, the run stops (status becomes "Stopped") but whatever was
  collected up to that point is preserved — just click Start again or
  Download.
- Closing the driven tab manually also stops the run (results are kept).

---

## Mode 2 — Instagram profiles (full profile + all posts)

Paste one or more **public Instagram profile URLs or handles** and it opens each
one in a tab, pulls the profile plus every post by paging to the end, and
downloads one JSON file per account named after the handle (`natgeo.json`).
With several accounts, the files arrive one by one as each account finishes.

### How to use it

1. Log into instagram.com in the same Chrome profile. These endpoints usually
   return `401` for a logged-out browser, so the run would just pause asking you
   to log in.
2. Switch the side panel to **Instagram profiles**.
3. **Accounts** — one per line. All of these work and mean the same thing:
   `https://www.instagram.com/natgeo/`, `www.instagram.com/natgeo`, `@natgeo`,
   `natgeo`, and URLs with tracking junk like `?igsh=...`. Post, reel, story,
   explore and `/tagged/` links are rejected — you'll be told how many lines were
   skipped before anything starts.
4. **Delay between pages** (default 3s, min 2) and **Delay between accounts**
   (default 8s, min 3). Lower = faster and more likely to hit a rate limit.
5. Click **Start**. Watch the live status: which account, which page, how many
   posts so far, and a running list of finished accounts.
6. Each account's file downloads automatically the moment it completes — the
   side panel does not have to stay open.

### When it pauses

Same posture as mode 1: **it pauses, it never evades and it never retries in a
loop.** You get a red `⏸` badge and a sticky desktop notification (click it to
jump to the tab). The panel tells you exactly what happened and what to do:

| What happened | What you do |
|---|---|
| Rate limit (429) | Wait — **Resume** is disabled with a live countdown, then enabled. Backoff doubles per consecutive hit, capped at 15 min. |
| Not logged in (401) | Log into Instagram in that tab, then **Resume**. |
| Blocked (403) / checkpoint | Clear it in the tab, then **Resume**. |
| Network dropped | Check your connection, then **Resume**. |
| Instagram changed its API | All fallbacks failed — the extension needs updating. |
| Tab closed / browser restarted | **Resume** re-opens the tab and carries on. |

**Resume always continues from the saved cursor**, so nothing is re-downloaded
and nothing is lost. Two cases are handled without pausing at all: a **private**
account you don't follow gets a profile-only file and the run moves on, and a
**handle that doesn't exist** is simply skipped.

### Output format — `<handle>.json`

```json
{
  "handle": "natgeo",
  "profile_url": "https://www.instagram.com/natgeo/",
  "fetched_at": "2026-08-21T12:00:00.000Z",
  "source": "web_profile_info+feed_api",
  "complete": true,
  "incomplete_reason": null,
  "profile": {
    "user_id": "787132",
    "username": "natgeo",
    "full_name": "National Geographic",
    "biography": "...",
    "external_url": "http://natgeo.com",
    "is_private": false,
    "is_verified": true,
    "is_business": true,
    "category": "Media/News Company",
    "followers": 280000000,
    "following": 150,
    "posts_count": 30000,
    "profile_pic_url": "https://...",
    "profile_pic_url_hd": "https://..."
  },
  "posts_count_reported": 30000,
  "posts_collected": 30000,
  "posts": [
    {
      "id": "3123456789012345678",
      "shortcode": "C1a2b3c4d5",
      "url": "https://www.instagram.com/p/C1a2b3c4d5/",
      "taken_at": "2026-08-01T09:15:00.000Z",
      "media_type": "carousel",
      "is_video": false,
      "caption": "...",
      "like_count": 12345,
      "comment_count": 678,
      "view_count": null,
      "display_url": "https://...",
      "video_url": null,
      "carousel_media": [
        { "media_type": "image", "display_url": "https://...", "video_url": null }
      ],
      "location": { "name": "Delhi", "pk": "42" },
      "tagged_users": ["someone"]
    }
  ]
}
```

- **`complete`** is `true` only when the account was paged all the way to the
  end. Anything else sets it to `false` and fills in `incomplete_reason`
  (`private`, `capped`, `partial: rate_limit`, ...) — a partial file never
  pretends to be a full one.
- **`source`** records which endpoints produced the data, so you can tell a
  clean run from one that fell back.
- **Posts are deduped by id** when the file is assembled, so an overlapping page
  after a resume can never produce a duplicate.
- **`comment_count` is the number, not the comments.** Fetching the actual
  comment threads would mean one extra request per post (and those are paginated
  too) — hours of requests and a near-certain block.
- **Media URLs are links, not files.** Nothing is downloaded except the JSON.
  Note that Instagram's CDN URLs expire after a few days, so archive the media
  yourself if you need it long-term.

### Good to know / limits

- **Nothing is evaded.** It uses your own logged-in tab, your own cookies, no
  proxies, no spoofed headers, no parallel hidden tabs, no captcha solving.
  Heavy scraping on your own account can still earn you a rate limit or an
  action block — that's why the default delays are conservative.
- **Instagram's data endpoints are undocumented and change.** If the main one
  breaks, the extension tries GraphQL, then a DOM scroll harvest (which yields
  only shortcodes, tagged `"source": "dom"`) before giving up. The endpoint
  constants live at the top of `content-ig-fetch.js` for easy updating.
- **Hard cap of 500 pages** (~16k posts) per account as a runaway guard. Hitting
  it is reported in the log and marks the file `complete: false` — it is never a
  silent truncation.
- **Progress survives a sleeping service worker.** The paging loop runs in the
  page itself, and every page is persisted, so an MV3 worker shutdown mid-crawl
  costs nothing.
- **Download partial** grabs whatever the current account has so far, at any
  point, without disturbing the run.
- **Reset** clears the Instagram run's collected data and stored pages. Files
  already downloaded are untouched.

---

## Mode 3 — YouTube channels (full profile + all videos)

Same shape as mode 2, pointed at YouTube. You give it channels, it gives you one
`<handle>.json` per channel containing the channel's profile and every video it
publishes — regular uploads and past live streams. Shorts are deliberately skipped.

### How to use it

1. Log into YouTube in this Chrome profile (not strictly required for public
   channels, but a logged-out session hits walls sooner).
2. Open the side panel, switch to the **YouTube channels** tab.
3. Paste channels, one per line. All of these work:

   ```
   https://www.youtube.com/@mkbhd
   https://www.youtube.com/@mkbhd/videos
   @NASA
   mkbhd
   https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ
   https://www.youtube.com/c/SomeOldChannel
   https://www.youtube.com/user/SomeOldUser
   ```

   Video, Shorts-video, playlist and search links are **rejected** — the panel
   tells you how many lines it skipped before it starts.
4. Set the delays. Defaults are 3 s between listing pages, 8 s between channels,
   700 ms between videos.
5. **Full video details** (on by default) is the important switch — see below.
6. **Start**. A tab opens on the first channel and works through it.

### The details switch

The channel listing only carries cheap fields: url, title, thumbnail, a rounded
view count ("1.2M views"), duration and "2 days ago". **Like count, comment
count, exact view count and the full description do not exist in the listing** —
each one needs its own request per video.

| Details | What you get | Cost |
|---|---|---|
| **On** (default) | Every field, exact view counts, full description | ~1 request per video — a 1,000-video channel takes roughly 20 minutes |
| **Off** | url, title, thumbnail, approximate views, duration, published-ago | One request per ~30 videos — minutes for the same channel |

With details off, `like_count`, `comment_count` and `description` are `null` and
`details_source` is `null`, so a thin file is always self-describing rather than
looking like a channel with zero likes.

### When it pauses

Same stance as the other modes: every wall becomes a resumable pause with a
notification, never a silent failure and never a retry storm.

| Reason | What to do |
|---|---|
| `login_wall` | Log into YouTube in that tab, then **Resume** |
| `consent_wall` | Accept YouTube's cookie consent in that tab, then **Resume** |
| `bot_check` | YouTube asked you to confirm you're not a bot — clear it in the tab, then **Resume** (cool-down applies) |
| `rate_limit` | Wait out the cool-down on the Resume button, then **Resume** |
| `forbidden` / `network` | Wait a bit, check the connection, **Resume** |
| `endpoint_shape` | YouTube changed its layout — see Troubleshooting |

Resume picks up from the exact continuation token and the exact channel tab it
was inside, so nothing is re-crawled. A channel that does not exist is skipped
rather than pausing the whole queue.

### Output format — `<handle>.json`

Deliberately the same envelope as mode 2, with `videos` where that one has
`posts`:

```json
{
  "handle": "@mkbhd",
  "profile_url": "https://www.youtube.com/@mkbhd",
  "fetched_at": "2026-08-22T12:00:00.000Z",
  "source": "browse+browse_continuation",
  "complete": true,
  "incomplete_reason": null,
  "details_enabled": true,
  "profile": {
    "channel_id": "UCBJycsmduvYEL83R_U4JriQ",
    "handle": "@mkbhd",
    "title": "Marques Brownlee",
    "description": "...",
    "canonical_url": "https://www.youtube.com/@mkbhd",
    "subscriber_count": 20300000,
    "subscriber_count_text": "20.3M subscribers",
    "subscriber_count_exact": false,
    "video_count": 1703,
    "video_count_text": "1,703 videos",
    "view_count": 4459442510,
    "view_count_text": "4,459,442,510 views",
    "joined_date": "Joined Mar 21, 2008",
    "country": "United States",
    "keywords": ["tech reviews", "smartphones"],
    "is_verified": true,
    "is_family_safe": true,
    "avatar_url": "https://...",
    "avatars": [{ "url": "https://...", "width": 900, "height": 900 }],
    "banner_url": "https://...",
    "links": [{ "title": "Twitter", "display": "twitter.com/MKBHD", "url": "https://twitter.com/MKBHD" }]
  },
  "videos_count_reported": 1703,
  "videos_collected": 1541,
  "videos": [
    {
      "id": "dQw4w9WgXcQ",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "kind": "video",
      "title": "...",
      "description": "full description\nwith line breaks",
      "thumbnail_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      "thumbnails": [{ "url": "https://...", "width": 1280, "height": 720 }],
      "view_count": 1234567,
      "view_count_text": "1,234,567 views",
      "view_count_exact": true,
      "like_count": 34567,
      "comment_count": 2345,
      "published_text": "2 days ago",
      "published_date_text": "Jan 5, 2024",
      "published_at": "2024-01-05T00:00:00.000Z",
      "duration_text": "12:34",
      "duration_seconds": 754,
      "is_live_now": false,
      "live_viewers": null,
      "details_source": "next",
      "details_error": null
    }
  ]
}
```

- **`kind`** is `video` or `live` — the Videos and Live tabs are crawled in that order
  into one list, deduped by id (a past stream can appear in both). **Shorts are not
  collected at all** — the Shorts tab is never requested, and a Shorts shelf appearing
  inside another tab is skipped rather than mapped.
- **`videos_count_reported` is YouTube's own channel total**, which counts Shorts. Since
  Shorts are not collected, `videos_collected` is normally lower — that gap is expected
  and does not make the file incomplete.
- **`comment_count` is a plain number** (or `null` if comments are off/unreadable). No
  comment text, authors or threads are fetched — only the count YouTube itself displays.
- **`view_count_exact`** tells you whether the number is YouTube's exact figure
  or its rounded "1.2M". With details on it is exact; with details off it is not.
- **`details_source`** is `next` (or `next+player`) for an enriched video and
  `null` for one that was never enriched; `details_error` says why a single
  video could not be read (removed, private, age-gated) without failing the run.
- **`subscriber_count`** is parsed from YouTube's own rounded text — YouTube
  itself does not publish an exact subscriber number any more, hence
  `subscriber_count_exact: false`.
- **A stream that is live right now** reports watchers, not views, in the same field —
  those land in `live_viewers` with `is_live_now: true`, and `view_count` stays null
  rather than being quietly understated.
- **A count YouTube writes in a form the parser cannot trust becomes `null`**, never a
  guess; the raw string is always kept alongside in the matching `*_text` field.
- **Thumbnail URLs are links, not files.** Nothing is downloaded except the JSON.

### Good to know / limits

- **Nothing is evaded.** It calls YouTube's own InnerTube endpoints from your own
  logged-in tab with the page's own client identity — no proxies, no spoofed
  user-agent, no hidden parallel tabs, no bot-check solving.
- **Requests ask for English labels** (`hl=en`, region left alone). Every count YouTube
  ships is a *string*, and separator rules differ per language — a German
  "1,2 Mio. Aufrufe" cannot be read without guessing. The channel profile is fetched
  through that same English request rather than scraped off the rendered page.
- **The InnerTube API is undocumented and changes.** Every field is located by
  key rather than by a fixed path, so a renamed wrapper does not break the crawl;
  a renamed *field* becomes `null` rather than a crash. The endpoint constants
  and channel-tab `params` live at the top of `content-yt-fetch.js`.
- **Hard cap of 500 pages** (~15k videos) per channel as a runaway guard, same as
  mode 2 — reported in the log and marked `complete: false`.
- **Progress survives a sleeping service worker.** The paging loop runs in the
  page itself and every page is persisted.
- **Download partial** and **Reset** behave exactly as in mode 2.

---

## Troubleshooting

**Where to look first.** `chrome://extensions` → the extension's card →
**Service worker** → *Inspect*. That console is where all three background scripts
log. The side panel's own log (last 20 events) is the quicker read for
"what just happened".

| Symptom | What it usually means |
|---|---|
| Mode 2 does nothing, no tab opens | Every line you pasted was rejected. The log says how many were skipped — check for post/reel links. |
| Pauses immediately with `401` | Not logged into instagram.com in this Chrome profile. |
| Pauses on the first page with "API badli" | Instagram changed its endpoints — see below. |
| The page never scrolls | **Expected.** Mode 2 calls Instagram's JSON endpoints directly instead of scrolling. Scrolling only happens in the last-resort DOM fallback. |
| File downloaded but `posts` is short | Check `complete` and `incomplete_reason` in the JSON — it will say `capped`, `private`, or which pause stopped it. |
| Mode 3 is very slow | Expected with details on — one extra request per video. Turn the details checkbox off for a listing-only run, or lower the per-video delay. |
| Mode 3 videos have `null` likes/comments | Either details were off, or that video's `details_error` says why (removed, private, age-gated). |
| Mode 3 pauses with "consent page" | YouTube showed its cookie consent interstitial. Accept it in that tab, then Resume. |
| Mode 3 file has an empty `videos` list | It will say `complete: false` with `no videos found`. Check the side panel log — it names the renderer YouTube actually sent (e.g. `lockupViewModel x30`), which is the one line to add to `VIDEO_KEYS`. |

**If Instagram changes its API.** These endpoints are undocumented and rotate.
When all three fallbacks fail, find the current one yourself:

1. Open a profile in a normal tab with DevTools → **Network** → filter `XHR`.
2. Scroll the post grid. The request that returns the next batch of posts is the
   one to copy — note its path and its request headers.
3. Update the constants at the top of `content-ig-fetch.js`
   (`PROFILE_PATH`, `FEED_PATH`, `GRAPHQL_HASHES`, `FALLBACK_APP_ID`) and reload
   the extension.

They are deliberately kept together at the top of that file so this stays a
one-line fix rather than a rewrite.

**If YouTube changes its layout.** Mode 3 looks every field up *by key* rather
than by a fixed path, so a renamed wrapper is survivable and a renamed field
degrades to `null` instead of crashing. When something genuinely breaks:

1. Open a channel's Videos tab with DevTools → **Network** → filter `Fetch/XHR`.
2. Scroll the grid. The `/youtubei/v1/browse` request that returns the next batch
   is the one to compare against — check its `params` (the channel-tab constant)
   and the renderer key the videos arrive under.
3. Update `CHANNEL_TABS` / `VIDEO_KEYS` at the top of `content-yt-fetch.js`, or the
   key names in `extractLikeCount` / `extractCommentCount` / `extractDescription`
   for a details-pass break, and reload the extension.

You usually will not need step 1 and 2: when a tab yields nothing, the log already names
the item renderers that were in the response, and a run that collected nothing is marked
`complete: false` rather than quietly succeeding.

Both of YouTube's current channel layouts are handled — the older `videoRenderer` grid
with a `c4TabbedHeaderRenderer`, and the newer `lockupViewModel` grid with a
`pageHeaderRenderer` whose counts are plain display strings. Channel facts that only the
About panel holds (joined date, country, links) are fetched with a dedicated request when
the channel page does not carry them.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension config, permissions, icons |
| `background.js` | Service worker — orchestrates the city × page loop, drives the tab |
| `content-scraper.js` | Injected into the Google results tab — scrapes handles, detects CAPTCHA/block |
| `background-profiles.js` | Service worker — orchestrates the Instagram account queue, persists pages, writes the files |
| `content-ig-fetch.js` | Injected into the Instagram tab — fetches the profile and pages through every post |
| `background-youtube.js` | Service worker — orchestrates the YouTube channel queue, persists pages, writes the files |
| `content-yt-fetch.js` | Injected into the YouTube tab — reads the channel profile and pages through every video |
| `offscreen.html` / `offscreen.js` | Turns the collected JSON into a downloadable blob URL (a service worker can't) |
| `popup/` | The side panel UI (HTML/CSS/JS), loaded via `side_panel.default_path` |
| `icons/` | Toolbar/notification icons |
