# Insta Handle Finder

Two tools in one side panel, switched with the tabs at the top:

| Mode | What it does |
|---|---|
| **Google handles** | Walks `site:instagram.com "<city>"` Google results and collects public profile handles. |
| **Instagram profiles** | Takes profile URLs/handles and exports each account's full profile + every post to `<handle>.json`. |

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

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension config, permissions, icons |
| `background.js` | Service worker — orchestrates the city × page loop, drives the tab |
| `content-scraper.js` | Injected into the Google results tab — scrapes handles, detects CAPTCHA/block |
| `background-profiles.js` | Service worker — orchestrates the Instagram account queue, persists pages, writes the files |
| `content-ig-fetch.js` | Injected into the Instagram tab — fetches the profile and pages through every post |
| `offscreen.html` / `offscreen.js` | Turns the collected JSON into a downloadable blob URL (a service worker can't) |
| `popup/` | The side panel UI (HTML/CSS/JS), loaded via `side_panel.default_path` |
| `icons/` | Toolbar/notification icons |
