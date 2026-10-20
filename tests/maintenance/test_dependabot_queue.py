"""Synthetic API tests of App maintenance, including concurrency boundaries."""

import copy
import importlib.util
import pathlib
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("queue", pathlib.Path(__file__).parents[2] / "scripts/dependabot-maintain.py")
queue = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(queue)
REPO = "owner/repo"
HEAD = "a" * 40
RULES = [{"type": name} for name in ("pull_request", "required_signatures", "deletion", "non_fast_forward")]
RULES.append({"type": "required_status_checks", "parameters": {
    "required_status_checks": [{"context": "ci"}], "strict_required_status_checks_policy": True}})


def pr(number, **overrides):
    result = {"number": number, "user": {"login": "dependabot[bot]"},
              "state": "open", "base": {"ref": "main", "repo": {"full_name": REPO}},
              "head": {"sha": HEAD, "repo": {"full_name": REPO}}, "auto_merge": None}
    result.update(overrides)
    return result


class FakeGitHub:
    def __init__(self, pulls=None, behind=0, fail=None):
        self.pulls = pulls or []
        self.behind = behind
        self.fail = fail
        self.calls = []

    def api(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if path == self.fail:
            raise queue.MaintenanceError("synthetic API failure")
        if "/rules/" in path:
            return RULES
        if "/pulls?" in path:
            return self.pulls
        if "/compare/" in path:
            return {"behind_by": self.behind}
        if method == "PUT":
            return {"message": "Updating pull request branch"}
        number = int(path.rsplit("/", 1)[1])
        return next(p for p in self.pulls if p["number"] == number)

    def command(self, args):
        self.calls.append(("CLI", args))


class DependabotQueueTest(unittest.TestCase):
    def test_only_same_repo_bot_prs_to_main_are_eligible(self):
        self.assertTrue(queue.eligible(pr(1), REPO))
        for override in ({"user": {"login": "human"}}, {"draft": True}, {"state": "closed"},
                         {"head": {"repo": {"full_name": "fork/repo"}}},
                         {"head": {"repo": None}}, {"base": {"ref": "other"}}):
            self.assertFalse(queue.eligible(pr(1, **override), REPO))

    def test_branch_update_is_bound_to_current_head_and_waits_for_new_ci(self):
        github = FakeGitHub([pr(1)], behind=1)
        self.assertFalse(queue.maintain(github, REPO))
        puts = [call for call in github.calls if call[0] == "PUT"]
        self.assertEqual(puts, [("PUT", "repos/owner/repo/pulls/1/update-branch", {"expected_head_sha": HEAD})])
        self.assertFalse(any(call[0] == "CLI" for call in github.calls))

    def test_failed_pr_does_not_block_later_pr_and_head_is_checked_at_merge(self):
        github = FakeGitHub([pr(1), pr(2)], fail="repos/owner/repo/pulls/1")
        self.assertTrue(queue.maintain(github, REPO))
        cli = [call for call in github.calls if call[0] == "CLI"]
        self.assertEqual(cli, [("CLI", ["pr", "merge", "2", "--repo", REPO, "--auto", "--merge", "--match-head-commit", HEAD])])

    def test_missing_protection_refuses_mutations(self):
        for types in ([], RULES[:-1]):
            with self.assertRaises(queue.MaintenanceError):
                queue.require_protection(types)
        rules = copy.deepcopy(RULES)
        rules[-1]["parameters"]["strict_required_status_checks_policy"] = False
        with self.assertRaises(queue.MaintenanceError):
            queue.require_protection(rules)

    def test_existing_automerge_and_nonbot_prs_are_not_mutated(self):
        github = FakeGitHub([pr(1, auto_merge={"merge_method": "merge"}), pr(2, user={"login": "human"})])
        self.assertFalse(queue.maintain(github, REPO))
        self.assertFalse(any(call[0] in ("PUT", "CLI") for call in github.calls))

    def test_protection_is_rechecked_immediately_before_mutation(self):
        for behind in (0, 1):
            github = FakeGitHub([pr(1)], behind=behind)
            original_api = github.api
            reads = 0
            def changed_rules(method, path, payload=None):
                nonlocal reads
                if "/rules/" in path:
                    reads += 1
                    if reads > 1:
                        return []
                return original_api(method, path, payload)
            github.api = changed_rules
            self.assertTrue(queue.maintain(github, REPO))
            self.assertFalse(any(call[0] in ("PUT", "CLI") for call in github.calls))

    def test_failed_list_aborts_before_mutations(self):
        github = FakeGitHub(fail="repos/owner/repo/pulls?state=open&per_page=100&page=1")
        with self.assertRaises(queue.MaintenanceError):
            queue.maintain(github, REPO)
        self.assertFalse(any(call[0] in ("PUT", "CLI") for call in github.calls))

    def test_missing_token_does_not_call_github(self):
        with mock.patch.dict(queue.os.environ, {"GH_TOKEN": ""}), mock.patch.object(queue, "GitHub") as github:
            self.assertEqual(queue.main(), 1)
            github.assert_not_called()

    def test_cli_errors_do_not_expose_captured_credentials(self):
        response = mock.Mock(returncode=1, stdout="", stderr="synthetic-secret-value")
        with mock.patch.object(queue.subprocess, "run", return_value=response):
            with self.assertRaises(queue.MaintenanceError) as error:
                queue.GitHub().command(["api", "user"])
        self.assertNotIn("synthetic-secret-value", str(error.exception))


if __name__ == "__main__":
    unittest.main()
