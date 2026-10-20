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
STALLED_DAYS = 7


def stalled_prs(pulls, now):
    return [pr["number"] for pr in pulls
            if pr.get("user", {}).get("login") == "dependabot[bot]"
            and dt.datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00"))
            <= now - dt.timedelta(days=STALLED_DAYS)]


def request_json(path, token, payload=None):
    request = urllib.request.Request(
        "https://api.github.com" + path,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "imessage-mcp-maintenance"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response), response.headers
    except urllib.error.HTTPError as error:
        # Do not include response bodies, headers, exception reprs or request URLs.
        error.close()
        raise RuntimeError(f"GitHub authentication/API check failed (HTTP {error.code}). Check the maintenance App installation, private key, and token permissions.") from None
    except (OSError, ValueError):
        raise RuntimeError("GitHub health check could not complete; investigate connectivity or the API response.") from None


def check(token, repository, now, api=request_json):
    if not token:
        return ["The maintenance App installation token is missing. Check App token creation and repository configuration."]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        return ["GITHUB_REPOSITORY is missing or invalid."]
    problems = []
    try:
        installation, _ = api("/installation/repositories", token)
        accessible = installation.get("repositories", [])
        if (installation.get("total_count") != 1 or len(accessible) != 1
                or accessible[0].get("full_name", "").casefold() != repository.casefold()):
            return ["Maintenance installation token must access exactly this repository. Review App installation and token repository scope."]
        repo, _ = api(f"/repos/{repository}", token)
        auto_merge = repo.get("allow_auto_merge")
        if auto_merge is None:
            # REST hides merge settings from read-only installation tokens.
            owner, name = repository.split("/")
            result, _ = api("/graphql", token, {
                "query": "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { autoMergeAllowed } }",
                "variables": {"owner": owner, "name": name},
            })
            if result.get("errors"):
                problems.append("Repository auto-merge settings could not be verified with this installation token.")
            else:
                auto_merge = ((result.get("data") or {}).get("repository") or {}).get("autoMergeAllowed")
                if auto_merge is None:
                    problems.append("Repository auto-merge settings could not be verified with this installation token.")
        if auto_merge is False:
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
        lines.append("App installation authentication and repository scope, repository auto-merge, and dependency PR age checks passed.")
        print(lines[-1])
    lines.extend(["", "This check is read-only. See CONTRIBUTING.md for recovery and unattended-operation limits."])
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write("\n".join(lines) + "\n")
    return bool(problems)


if __name__ == "__main__":
    sys.exit(main())
