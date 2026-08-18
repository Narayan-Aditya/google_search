# Insta Handle Finder (Google Search)

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

## How to use it

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

## Output format

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

## Good to know / limits

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

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension config, permissions, icons |
| `background.js` | Service worker — orchestrates the city × page loop, drives the tab |
| `content-scraper.js` | Injected into the Google results tab — scrapes handles, detects CAPTCHA/block |
| `popup/` | The side panel UI (HTML/CSS/JS), loaded via `side_panel.default_path` |
| `icons/` | Toolbar/notification icons |
