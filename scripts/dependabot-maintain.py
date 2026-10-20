#!/usr/bin/env python3
"""Maintain same-repository Dependabot PRs using a short-lived App token."""

import json
import os
import re
import subprocess
import sys


class MaintenanceError(RuntimeError):
    pass


class GitHub:
    def command(self, args, payload=None):
        try:
            result = subprocess.run(
                ["gh", *args], input=json.dumps(payload) if payload is not None else None,
                capture_output=True, text=True, timeout=45)
        except (OSError, subprocess.TimeoutExpired):
            raise MaintenanceError("GitHub CLI was unavailable or timed out") from None
        if result.returncode:
            # Never echo stderr, request bodies, headers, or the token environment.
            raise MaintenanceError(f"GitHub command failed (exit {result.returncode})")
        return result.stdout

    def api(self, method, path, payload=None):
        args = ["api", "--method", method, path]
        if payload is not None:
            args.extend(["--input", "-"])
        try:
            return json.loads(self.command(args, payload))
        except ValueError:
            raise MaintenanceError("GitHub returned an invalid API response") from None


def require_protection(rules):
    types = {rule["type"] for rule in rules}
    required = {"pull_request", "required_status_checks", "required_signatures", "deletion", "non_fast_forward"}
    checks = next((rule.get("parameters", {}) for rule in rules if rule["type"] == "required_status_checks"), {})
    if not required.issubset(types) or not checks.get("required_status_checks") or not checks.get("strict_required_status_checks_policy"):
        raise MaintenanceError("main is missing required PR, signature, strict CI, force-push, or deletion protection; no PRs were changed")


def eligible(pr, repository):
    return (pr.get("user", {}).get("login") == "dependabot[bot]"
            and pr.get("base", {}).get("ref") == "main"
            and pr.get("base", {}).get("repo", {}).get("full_name") == repository
            and (pr.get("head", {}).get("repo") or {}).get("full_name") == repository
            and not pr.get("draft")
            and pr.get("state") == "open")


def maintain_pr(github, repository, number):
    path = f"repos/{repository}/pulls/{number}"
    # Re-read each PR: an earlier merge or Dependabot push may have changed it.
    pr = github.api("GET", path)
    if not eligible(pr, repository) or pr.get("merged"):
        return "no longer eligible"
    head = pr["head"]["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise MaintenanceError("PR head is invalid")
    comparison = github.api("GET", f"repos/{repository}/compare/main...{head}")
    if comparison["behind_by"] > 0:
        # App bots cannot rely on owner-only @dependabot comments. GitHub's
        # update-branch API adds a signed merge commit and starts fresh CI.
        # expected_head_sha prevents overwriting a concurrent Dependabot push.
        require_protection(github.api("GET", f"repos/{repository}/rules/branches/main"))
        github.api("PUT", path + "/update-branch", {"expected_head_sha": head})
        return "branch update requested; fresh CI must pass"
    if not pr.get("auto_merge"):
        require_protection(github.api("GET", f"repos/{repository}/rules/branches/main"))
        github.command(["pr", "merge", str(number), "--repo", repository,
                        "--auto", "--merge", "--match-head-commit", head])
        return "protected auto-merge enabled"
    return "protected auto-merge already enabled"


def maintain(github, repository):
    require_protection(github.api("GET", f"repos/{repository}/rules/branches/main"))
    candidates = []
    page = 1
    while True:
        batch = github.api("GET", f"repos/{repository}/pulls?state=open&per_page=100&page={page}")
        candidates.extend(pr["number"] for pr in batch if eligible(pr, repository))
        if len(batch) < 100:
            break
        page += 1
    failed = []
    for number in candidates:
        if not isinstance(number, int) or number <= 0:
            raise MaintenanceError("GitHub returned an invalid PR number")
        try:
            print(f"#{number}: {maintain_pr(github, repository, number)}")
        except MaintenanceError as error:
            failed.append(number)
            print(f"::error::PR #{number}: {error}; continuing with the remaining queue")
    if failed:
        print("::error::Failed pull requests: " + " ".join(f"#{number}" for number in failed))
    else:
        print(f"Dependency maintenance passed ({len(candidates)} eligible PRs).")
    return bool(failed)


def main():
    if not os.environ.get("GH_TOKEN"):
        print("::error::Maintenance App token is missing; no PRs were changed")
        return 1
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        print("::error::GITHUB_REPOSITORY is missing or invalid")
        return 1
    try:
        return maintain(GitHub(), repository)
    except MaintenanceError as error:
        print(f"::error::{error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
