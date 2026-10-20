import datetime as dt
import importlib.util
import pathlib
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("health", pathlib.Path(__file__).parents[2] / "scripts/dependabot-health.py")
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)
NOW = dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc)
EXPIRY = "2027-01-18 02:01:45 UTC"


class HealthTest(unittest.TestCase):
    def api(self, path, token):
        self.assertEqual(token, "synthetic-token")
        if path == "/user":
            return {}, {"GitHub-Authentication-Token-Expiration": EXPIRY}
        if path == "/repos/owner/repo":
            return {"allow_auto_merge": True}, {}
        return [], {}

    def test_healthy(self):
        self.assertEqual(health.check("synthetic-token", "owner/repo", NOW, self.api), [])

    def test_missing_token_does_not_call_api(self):
        api = mock.Mock()
        self.assertTrue(health.check("", "owner/repo", NOW, api))
        api.assert_not_called()

    def test_expiry_boundary_and_missing_metadata(self):
        self.assertIsNone(health.expiry_problem(EXPIRY, NOW))
        self.assertTrue(health.expiry_problem("2026-11-03 00:00:00 UTC", NOW))
        self.assertTrue(health.expiry_problem("2026-10-19 00:00:00 UTC", NOW))
        self.assertTrue(health.expiry_problem(None, NOW))
        self.assertTrue(health.expiry_problem("unknown", NOW))

    def test_stalled_bot_prs_only(self):
        def pr(number, user, date):
            return {"number": number, "user": {"login": user}, "created_at": date}
        pulls = [pr(1, "dependabot[bot]", "2026-10-13T00:00:00Z"),
                 pr(2, "human", "2026-01-01T00:00:00Z"),
                 pr(3, "dependabot[bot]", "2026-10-19T00:00:00Z")]
        self.assertEqual(health.stalled_prs(pulls, NOW), [1])

    def test_pagination_does_not_hide_stalled_prs(self):
        def api(path, token):
            if "&page=1" in path:
                return [{"user": {"login": "human"}}] * 100, {}
            if "&page=2" in path:
                return [{"number": 9, "user": {"login": "dependabot[bot]"}, "created_at": "2026-01-01T00:00:00Z"}], {}
            return self.api(path, token)
        self.assertIn("#9", health.check("synthetic-token", "owner/repo", NOW, api)[0])

    def test_invalid_credential_and_disabled_automerge_are_failures(self):
        def failed(path, token):
            raise RuntimeError("GitHub authentication/API check failed (HTTP 401).")
        self.assertIn("401", health.check("synthetic-token", "owner/repo", NOW, failed)[0])
        def disabled(path, token):
            if path == "/repos/owner/repo":
                return {"allow_auto_merge": False}, {}
            return self.api(path, token)
        self.assertIn("disabled", health.check("synthetic-token", "owner/repo", NOW, disabled)[0])


if __name__ == "__main__":
    unittest.main()
