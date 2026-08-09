#!/usr/bin/env python3
"""Fetch all feeds from feeds.yaml and rebuild the site's JSON data files.

Outputs (all under public/data/):
  latest.json           - per-feed newest articles, grouped by topic, plus fetch status
  archive/YYYY-MM.json  - append-only monthly archive of every article ever seen
  archive/index.json    - list of archive months with entry counts

Articles are deduplicated by a hash of their normalized URL against the last
DEDUPE_MONTHS months of archive, so re-runs only append genuinely new items.
"""

import concurrent.futures
import datetime as dt
import hashlib
import html
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "public" / "data"
ARCHIVE_DIR = DATA_DIR / "archive"

LATEST_PER_FEED = 10      # headlines shown per feed card
MAX_PER_FETCH = 50        # entries considered per feed per run
SUMMARY_LEN = 280         # plain-text summary truncation
DEDUPE_MONTHS = 3         # months of archive to load for dedupe
FETCH_TIMEOUT = 25
USER_AGENT = "feed.codycarey.com aggregator (+https://feed.codycarey.com)"

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid", "ref"}


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
    ]
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, urlencode(query), ""))


def entry_id(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode("utf-8")).hexdigest()[:16]


def clean_summary(text: str) -> str:
    text = WS_RE.sub(" ", html.unescape(TAG_RE.sub(" ", text or ""))).strip()
    if len(text) > SUMMARY_LEN:
        text = text[:SUMMARY_LEN].rsplit(" ", 1)[0] + "…"
    return text


def parse_date(entry) -> dt.datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        parsed = entry.get(key)
        if parsed:
            try:
                return dt.datetime(*parsed[:6], tzinfo=dt.timezone.utc)
            except (ValueError, TypeError):
                continue
    return None


def fetch_feed(feed: dict, topic: str) -> dict:
    result = {"feed": feed["name"], "topic": topic, "ok": False, "error": None, "entries": []}
    try:
        resp = requests.get(feed["url"], timeout=FETCH_TIMEOUT, headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
    except Exception as exc:  # noqa: BLE001 - one bad feed must never sink the run
        result["error"] = f"{type(exc).__name__}: {exc}"[:200]
        return result

    if parsed.bozo and not parsed.entries:
        result["error"] = f"unparseable feed: {parsed.bozo_exception}"[:200]
        return result

    now = now_utc()
    for entry in parsed.entries[:MAX_PER_FETCH]:
        link = (entry.get("link") or "").strip()
        title = WS_RE.sub(" ", html.unescape(entry.get("title") or "")).strip()
        if not link.startswith("http") or not title:
            continue
        published = parse_date(entry)
        if published is None or published > now + dt.timedelta(days=1):
            published = now
        result["entries"].append(
            {
                "id": entry_id(link),
                "title": title,
                "url": link,
                "source": feed["name"],
                "topic": topic,
                "published": iso(published),
                "summary": clean_summary(entry.get("summary") or entry.get("description") or ""),
            }
        )
    result["ok"] = True
    return result


def month_key(ts: dt.datetime) -> str:
    return ts.strftime("%Y-%m")


def recent_month_keys(count: int) -> list[str]:
    first = now_utc().replace(day=1)
    keys = []
    cursor = first
    for _ in range(count):
        keys.append(month_key(cursor))
        cursor = (cursor - dt.timedelta(days=1)).replace(day=1)
    return keys


def load_month(key: str) -> list[dict]:
    path = ARCHIVE_DIR / f"{key}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))["entries"]


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )


def main() -> int:
    config = yaml.safe_load((ROOT / "feeds.yaml").read_text(encoding="utf-8"))
    jobs = [(feed, topic["name"]) for topic in config["topics"] for feed in topic["feeds"]]

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda job: fetch_feed(*job), jobs))

    # Dedupe against recent archive months and append new entries to the current month.
    seen: set[str] = set()
    for key in recent_month_keys(DEDUPE_MONTHS):
        seen.update(e["id"] for e in load_month(key))

    now = now_utc()
    current_key = month_key(now)
    current_entries = load_month(current_key)
    new_count = 0
    for result in results:
        for entry in result["entries"]:
            if entry["id"] in seen:
                continue
            seen.add(entry["id"])
            entry["first_seen"] = iso(now)
            current_entries.append(entry)
            new_count += 1

    current_entries.sort(key=lambda e: e["published"], reverse=True)
    write_json(ARCHIVE_DIR / f"{current_key}.json", {"month": current_key, "entries": current_entries})

    months = sorted(p.stem for p in ARCHIVE_DIR.glob("*.json") if re.fullmatch(r"\d{4}-\d{2}", p.stem))
    write_json(
        ARCHIVE_DIR / "index.json",
        {
            "generated": iso(now),
            "months": [
                {"month": key, "count": len(load_month(key))} for key in reversed(months)
            ],
        },
    )

    # Rebuild latest.json from the archive so a temporarily failing feed keeps
    # showing its most recent known articles.
    recent: dict[str, list[dict]] = {}
    for key in recent_month_keys(2):
        for entry in load_month(key):
            recent.setdefault(entry["source"], []).append(entry)

    status_by_feed = {r["feed"]: r for r in results}
    topics_out = []
    for topic in config["topics"]:
        feeds_out = []
        for feed in topic["feeds"]:
            entries = sorted(
                recent.get(feed["name"], []), key=lambda e: e["published"], reverse=True
            )[:LATEST_PER_FEED]
            status = status_by_feed[feed["name"]]
            feeds_out.append(
                {
                    "name": feed["name"],
                    "site": feed.get("site", ""),
                    "ok": status["ok"],
                    "error": status["error"],
                    "entries": entries,
                }
            )
        topics_out.append({"name": topic["name"], "feeds": feeds_out})

    write_json(DATA_DIR / "latest.json", {"generated": iso(now), "topics": topics_out})

    failures = [r for r in results if not r["ok"]]
    print(f"fetched {len(results)} feeds, {new_count} new articles, {len(failures)} failures")
    for failure in failures:
        print(f"  FAIL {failure['feed']}: {failure['error']}", file=sys.stderr)
    return 0  # feed failures are reported on the site, not fatal to the run


if __name__ == "__main__":
    sys.exit(main())
