# feed.codycarey.com

A personal news aggregator in the style of [jimmyr.com](https://www.jimmyr.com):
a static site on GitHub Pages, rebuilt hourly by GitHub Actions from the RSS/Atom
feeds listed in [`feeds.opml`](feeds.opml).

## Features

- **Aggregation** — feeds grouped under topic sections, each rendered as a dense
  headline card. Refreshed hourly by CI.
- **History** — every article ever seen is appended to a monthly archive file
  (`public/data/archive/YYYY-MM.json`) committed to the repo, browsable and
  searchable from the History tab.
- **Read tracking** — clicking a headline records it as read (localStorage).
  Read items are dimmed; an "unread only" toggle hides them. Read history can
  be exported/imported as JSON from the ⚙ menu to move between browsers.
- **Search & filters** — live keyword search across headlines/summaries/sources;
  History tab adds topic, source, read/unread, and date-range filters.

## How it works

```
feeds.opml ──► scripts/fetch_feeds.py (hourly via Actions)
                 ├── public/data/archive/YYYY-MM.json   append-only history
                 ├── public/data/archive/index.json     month listing
                 ├── public/data/latest.json            newest N per feed
                 └── public/feeds.opml                  published copy of the config
public/ ──► deployed to GitHub Pages
```

The published `feeds.opml` means <https://feed.codycarey.com/feeds.opml> can be
imported into any RSS reader, and the site's footer links to it.

Articles are deduplicated by a hash of their normalized URL (tracking params
stripped) against the last 3 months of archive. `latest.json` is rebuilt from
the archive, so a feed that's temporarily down keeps showing its last-known
articles (with a ⚠ badge).

## Setup

1. **Create the GitHub repo and push:**

   ```bash
   git init -b main
   git add -A
   git commit -m "Initial commit"
   gh repo create NewsAggregator --public --source . --push
   ```

   (Public repo recommended — GitHub Pages and Actions minutes are free for
   public repos. The archive is just public article metadata; your read history
   never leaves the browser.)

2. **Enable Pages:** repo → Settings → Pages → Source: **GitHub Actions**.

3. **Custom domain:** in the same Pages settings, set custom domain to
   `feed.codycarey.com` and check **Enforce HTTPS**. In your DNS, add:

   ```
   feed  CNAME  <your-github-username>.github.io
   ```

4. **First run:** the workflow runs on push; after it finishes the site is live.
   It then runs hourly (`cron: 7 * * * *`). You can also trigger it manually
   from the Actions tab.

### Adding/removing feeds

Edit `feeds.opml` and push. It's standard OPML 2.0: one top-level `<outline>`
per topic, each containing `<outline type="rss" text="…" xmlUrl="…" htmlUrl="…"/>`
entries.

```xml
<outline text="Security News" title="Security News">
  <outline type="rss" text="Krebs on Security"
           xmlUrl="https://krebsonsecurity.com/feed/"
           htmlUrl="https://krebsonsecurity.com/"/>
</outline>
```

Notes:

- `text`/`title` is the stable key articles are archived under — add new entries
  rather than renaming existing ones.
- Because it's plain OPML you can export from an RSS reader and drop the feeds
  straight in, or import this file into one.
- A feed that starts failing shows a ⚠ badge on its card but keeps its
  last-known articles; failures never block other feeds. Feeds with no working
  URL are left in the file as XML comments explaining why.

### Local development

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows; use .venv/bin/pip on Linux
.venv/Scripts/python scripts/fetch_feeds.py
python -m http.server 8137 -d public
```

Then open http://localhost:8137.

## Operational notes

- **Scheduled-run drift:** GitHub's cron scheduler can delay runs by a few
  minutes (occasionally more) at busy times; the `:07` offset helps.
- **Repo inactivity:** GitHub disables scheduled workflows after 60 days without
  repo activity; the hourly data commits count as activity, so this shouldn't
  trigger — but if you ever pause the workflow, re-enable it from the Actions tab.
- **Repo growth:** archive files are compact JSON (~1 KB per ~3 articles); even
  years of history stay small. If it ever bothers you, old months can be pruned
  or moved without affecting dedupe (only the last 3 months are used).

## Possible future: cross-device read sync

Read state is per-browser. If that becomes annoying, the GCP e2-micro VM can
host a tiny sync endpoint (a few lines of Flask/Caddy + a JSON file keyed by a
token) and `app.js` can push/pull the same `{id: timestamp}` map it already
stores. The export/import format was designed to make that a drop-in addition.
