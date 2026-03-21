#!/usr/bin/env python3
import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable


@dataclass(frozen=True)
class ReviewItem:
    kind: str
    item_id: int
    author: str
    created_at: datetime
    body: str
    url: str | None = None
    path: str | None = None
    line: int | None = None
    state: str | None = None

    @property
    def short_body(self) -> str:
        text = " ".join(self.body.split())
        return text[:220]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Watch GitHub PR review activity with gh CLI")
    parser.add_argument("--url", help="GitHub pull request URL")
    parser.add_argument("--repo", help="GitHub repo in owner/name form")
    parser.add_argument("--pr", type=int, help="Pull request number")
    parser.add_argument("--minutes", type=int, default=10, help="Watch duration in minutes (default: 10)")
    parser.add_argument("--interval", type=int, default=60, help="Polling interval in seconds (default: 60)")
    parser.add_argument("--snapshot-only", action="store_true", help="Print current snapshot and exit")
    return parser.parse_args()


def parse_url(url: str) -> tuple[str, int]:
    match = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/(\d+)(?:/.*)?$", url.strip())
    if not match:
        raise ValueError(f"Unsupported PR URL: {url}")
    return match.group(1), int(match.group(2))


def iso_to_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def gh_api(path: str) -> Any:
    result = subprocess.run(
        ["gh", "api", path],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"gh api failed for {path}")
    return json.loads(result.stdout)


def fetch_items(repo: str, pr: int) -> list[ReviewItem]:
    issue_comments = gh_api(f"repos/{repo}/issues/{pr}/comments")
    review_comments = gh_api(f"repos/{repo}/pulls/{pr}/comments")
    reviews = gh_api(f"repos/{repo}/pulls/{pr}/reviews")

    items: list[ReviewItem] = []

    for item in issue_comments:
        created = iso_to_dt(item.get("created_at"))
        if created is None:
            continue
        items.append(
            ReviewItem(
                kind="issue_comment",
                item_id=int(item["id"]),
                author=item.get("user", {}).get("login", "unknown"),
                created_at=created,
                body=item.get("body") or "",
                url=item.get("html_url"),
            )
        )

    for item in review_comments:
        created = iso_to_dt(item.get("created_at"))
        if created is None:
            continue
        line = item.get("line")
        try:
            parsed_line = int(line) if line is not None else None
        except Exception:
            parsed_line = None
        items.append(
            ReviewItem(
                kind="review_comment",
                item_id=int(item["id"]),
                author=item.get("user", {}).get("login", "unknown"),
                created_at=created,
                body=item.get("body") or "",
                url=item.get("html_url"),
                path=item.get("path"),
                line=parsed_line,
            )
        )

    for item in reviews:
        created = iso_to_dt(item.get("submitted_at"))
        if created is None:
            continue
        items.append(
            ReviewItem(
                kind="review",
                item_id=int(item["id"]),
                author=item.get("user", {}).get("login", "unknown"),
                created_at=created,
                body=item.get("body") or "",
                url=item.get("html_url"),
                state=item.get("state"),
            )
        )

    items.sort(key=lambda item: (item.created_at, item.kind, item.item_id))
    return items


def latest_of_kind(items: Iterable[ReviewItem], kind: str) -> ReviewItem | None:
    filtered = [item for item in items if item.kind == kind]
    return filtered[-1] if filtered else None


def format_item(item: ReviewItem) -> str:
    extra = []
    if item.path:
        extra.append(item.path)
    if item.line is not None:
        extra.append(f"line {item.line}")
    if item.state:
        extra.append(item.state)
    extra_text = f" [{' | '.join(extra)}]" if extra else ""
    return (
        f"- {item.kind}: {item.author} at {item.created_at.isoformat()}"
        f"{extra_text} :: {item.short_body}"
    )


def print_snapshot(items: list[ReviewItem]) -> None:
    print("=== Current PR review snapshot ===")
    if not items:
        print("No review activity found")
        return

    print(f"Total items: {len(items)}")
    for kind in ("issue_comment", "review_comment", "review"):
        latest = latest_of_kind(items, kind)
        if latest:
            print(f"Latest {kind}: {latest.item_id}\t{latest.author}\t{latest.created_at.isoformat()}")
        else:
            print(f"Latest {kind}: none")


def watch(repo: str, pr: int, minutes: int, interval: int) -> int:
    start = datetime.now(timezone.utc)
    deadline = start + timedelta(minutes=minutes)
    seen_ids: set[tuple[str, int]] = set()
    collected_new: list[ReviewItem] = []

    baseline_items = fetch_items(repo, pr)
    for item in baseline_items:
        seen_ids.add((item.kind, item.item_id))

    print(f"Watching PR {repo}#{pr} for {minutes} minute(s) starting at {start.isoformat()}...")
    print_snapshot(baseline_items)

    poll = 1
    while True:
        now = datetime.now(timezone.utc)
        if now > deadline:
            break

        print(f"--- poll {poll} at {now.isoformat()} ---")
        items = fetch_items(repo, pr)
        new_items = [item for item in items if (item.kind, item.item_id) not in seen_ids and item.created_at >= start]
        if new_items:
            print(f"New activity: {len(new_items)} item(s)")
            for item in new_items:
                print(format_item(item))
                seen_ids.add((item.kind, item.item_id))
                collected_new.append(item)
        else:
            print("No new review activity")

        poll += 1
        if datetime.now(timezone.utc) + timedelta(seconds=interval) > deadline:
            break
        time.sleep(interval)

    print("=== Final summary ===")
    if collected_new:
        print(f"Detected {len(collected_new)} new item(s) since watch start:")
        for item in collected_new:
            print(format_item(item))
        return 2

    print("No new review activity detected during watch window")
    return 0


def main() -> int:
    args = parse_args()
    repo = args.repo
    pr = args.pr

    if args.url:
        repo, pr = parse_url(args.url)

    if not repo or not pr:
        print("Provide either --url or both --repo and --pr", file=sys.stderr)
        return 1

    try:
        if args.snapshot_only:
            print_snapshot(fetch_items(repo, pr))
            return 0
        return watch(repo, pr, args.minutes, args.interval)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
