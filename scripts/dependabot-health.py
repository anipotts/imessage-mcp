#!/usr/bin/env python3
"""Read-only checks for the dependency automation; never emit credentials."""

import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

UTC = dt.timezone.utc
RENEWAL_DAYS = 14
STALLED_DAYS = 7


def expiry_problem(value, now):
    if not value:
        return "GitHub did not report a token expiration; verify the credential's lifecycle manually."
    try:
        expires = dt.datetime.strptime(value, "%Y-%m-%d %H:%M:%S UTC").replace(tzinfo=UTC)
    except ValueError:
        return "GitHub returned an unrecognized token expiration; verify it manually."
    if expires <= now + dt.timedelta(days=RENEWAL_DAYS):
        return f"The auto-merge token expires {expires.date().isoformat()} UTC. Renew it in BOTH Actions and Dependabot secrets."
    return None


def stalled_prs(pulls, now):
    return [pr["number"] for pr in pulls
            if pr.get("user", {}).get("login") == "dependabot[bot]"
            and dt.datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00"))
            <= now - dt.timedelta(days=STALLED_DAYS)]


def request_json(path, token):
    request = urllib.request.Request(
        "https://api.github.com" + path,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "imessage-mcp-maintenance"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response), response.headers
    except urllib.error.HTTPError as error:
        # Do not include response bodies, headers, exception reprs or request URLs.
        raise RuntimeError(f"GitHub authentication/API check failed (HTTP {error.code}). Check both auto-merge secret copies and token permissions.") from None
    except (OSError, ValueError):
        raise RuntimeError("GitHub health check could not complete; investigate connectivity or the API response.") from None


def check(token, repository, now, api=request_json):
    if not token:
        return ["DEPENDABOT_AUTOMERGE_TOKEN is missing from Actions secrets. Dependency maintenance cannot authenticate."]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        return ["GITHUB_REPOSITORY is missing or invalid."]
    problems = []
    try:
        _, headers = api("/user", token)
        problem = expiry_problem(headers.get("GitHub-Authentication-Token-Expiration"), now)
        if problem:
            problems.append(problem)
        repo, _ = api(f"/repos/{repository}", token)
        if not repo.get("allow_auto_merge"):
            problems.append("Repository auto-merge is disabled. Review the repository settings.")
        pulls = []
        page = 1
        while True:
            batch, _ = api(f"/repos/{repository}/pulls?state=open&per_page=100&page={page}", token)
            pulls.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        stalled = stalled_prs(pulls, now)
        if stalled:
            numbers = ", ".join(f"#{number}" for number in stalled)
            problems.append(f"Dependabot PRs open for at least {STALLED_DAYS} days: {numbers}. Inspect failing checks, conflicts, and auto-merge state.")
    except RuntimeError as error:
        problems.append(str(error))
    return problems


def main():
    problems = check(os.environ.get("GH_TOKEN", ""), os.environ.get("GITHUB_REPOSITORY", ""), dt.datetime.now(UTC))
    lines = ["## Dependency automation health", ""]
    if problems:
        lines.extend(f"- {problem}" for problem in problems)
        for problem in problems:
            print(f"::error::{problem}")
    else:
        lines.append("Token authentication and expiry, repository auto-merge, and dependency PR age checks passed.")
        print(lines[-1])
    lines.extend(["", "This check is read-only. See CONTRIBUTING.md for recovery and unattended-operation limits."])
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write("\n".join(lines) + "\n")
    return bool(problems)


if __name__ == "__main__":
    sys.exit(main())
