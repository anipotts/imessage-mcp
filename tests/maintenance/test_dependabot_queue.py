"""Exercise the actual workflow shell with synthetic GitHub CLI responses."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
MOCK_GH = r'''#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["MOCK_CALLS"], "a") as log:
    log.write(json.dumps(args) + "\n")
mode = os.environ["MOCK_MODE"]
if args[:2] == ["pr", "list"]:
    if mode == "list-failure":
        sys.exit(1)
    print(json.dumps([
        {"number": n, "url": f"https://example.invalid/pull/{n}",
         "headRefOid": f"head{n}", "autoMergeRequest": None}
        for n in range(1, 8)
    ]))
elif args[:2] == ["pr", "merge"]:
    if mode == "mixed-failures" and args[-1].endswith("/1"):
        sys.exit(1)
elif args[:2] == ["pr", "comment"]:
    if mode == "mixed-failures" and args[2].endswith("/6"):
        sys.exit(1)
elif args[0] == "api":
    endpoint = args[1]
    if "/compare/" in endpoint:
        if mode == "mixed-failures" and endpoint.endswith("head2"):
            sys.exit(1)
        print(0 if endpoint.endswith("head5") else 1)
    elif "/commits/" in endpoint:
        print("2026-10-19T10:00:00Z")
    elif "/comments?" in endpoint:
        print("2026-10-19T11:00:00Z" if "/3/" in endpoint else "")
    else:
        sys.exit("Unexpected mock endpoint")
else:
    sys.exit("Unexpected mock command")
'''


@unittest.skipUnless(shutil.which("bash") and shutil.which("jq"), "workflow requires bash and jq")
class DependabotQueueTest(unittest.TestCase):
    def run_workflow(self, name="dependabot-rebase.yml", mode="healthy", token="synthetic-token"):
        source = (ROOT / ".github" / "workflows" / name).read_text()
        script = textwrap.dedent(source.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            gh = temp / "gh"
            gh.write_text(MOCK_GH)
            gh.chmod(0o755)
            workflow = temp / "workflow.sh"
            workflow.write_text(script)
            calls = temp / "calls.jsonl"
            calls.write_text("")
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ["PATH"],
                       GH_TOKEN=token, REPO="synthetic/repo", RUNNER_TEMP=directory,
                       PR_URL="https://example.invalid/pull/1", MOCK_MODE=mode,
                       MOCK_CALLS=str(calls))
            result = subprocess.run(
                [shutil.which("bash"), "--noprofile", "--norc", "-eo", "pipefail", str(workflow)],
                env=env, capture_output=True, text=True, timeout=20)
            return result, [json.loads(line) for line in calls.read_text().splitlines()]

    @staticmethod
    def comments(calls):
        return [int(call[2].rsplit("/", 1)[1]) for call in calls if call[:2] == ["pr", "comment"]]

    def test_missing_token_fails_before_any_github_call(self):
        for name in ("dependabot-rebase.yml", "dependabot-automerge.yml"):
            with self.subTest(workflow=name):
                result, calls = self.run_workflow(name=name, token="")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error", result.stdout)
                self.assertEqual(calls, [])

    def test_failed_prs_do_not_starve_queue_and_summary_lists_exact_failures(self):
        result, calls = self.run_workflow(mode="mixed-failures")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Failed pull requests: #1 #2 #6", result.stdout)
        self.assertEqual(self.comments(calls), [4, 6, 7])
        self.assertIn("#7: rebase requested", result.stdout)
        self.assertNotIn("#6: rebase requested", result.stdout)

    def test_healthy_queue_skips_current_and_already_requested_rebases(self):
        result, calls = self.run_workflow()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.comments(calls), [1, 2, 4, 6, 7])
        self.assertIn("#3: rebase already requested", result.stdout)

    def test_failed_list_does_not_attempt_mutations(self):
        result, calls = self.run_workflow(mode="list-failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ["pr", "list"])


if __name__ == "__main__":
    unittest.main()
