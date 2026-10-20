import datetime as dt
import importlib.util
import pathlib
import unittest
import urllib.error
from unittest import mock

SPEC = importlib.util.spec_from_file_location("health", pathlib.Path(__file__).parents[2] / "scripts/dependabot-health.py")
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)
NOW = dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc)


class HealthTest(unittest.TestCase):
    def api(self, path, token):
        self.assertEqual(token, "synthetic-token")
        if path == "/installation/repositories":
            return {"total_count": 1, "repositories": [{"full_name": "owner/repo"}]}, {}
        if path == "/repos/owner/repo":
            return {"allow_auto_merge": True}, {}
        return [], {}

    def test_healthy(self):
        self.assertEqual(health.check("synthetic-token", "owner/repo", NOW, self.api), [])

    def test_missing_token_does_not_call_api(self):
        api = mock.Mock()
        self.assertTrue(health.check("", "owner/repo", NOW, api))
        api.assert_not_called()

    def test_installation_scope_must_be_exactly_current_repository(self):
        scopes = [
            {"total_count": 0, "repositories": []},
            {"total_count": 1, "repositories": [{"full_name": "owner/other"}]},
            {"total_count": 2, "repositories": [{"full_name": "owner/repo"}, {"full_name": "owner/other"}]},
            {"total_count": 2, "repositories": [{"full_name": "owner/repo"}]},
            {},
        ]
        for scope in scopes:
            with self.subTest(scope=scope):
                api = mock.Mock(return_value=(scope, {}))
                self.assertIn("exactly this repository", health.check("synthetic-token", "owner/repo", NOW, api)[0])
                api.assert_called_once_with("/installation/repositories", "synthetic-token")

    def test_read_only_token_uses_graphql_when_rest_hides_merge_settings(self):
        for allowed in (True, False):
            with self.subTest(allowed=allowed):
                def api(path, token, payload=None):
                    if path == "/repos/owner/repo":
                        return {}, {}
                    if path == "/graphql":
                        self.assertEqual(payload["variables"], {"owner": "owner", "name": "repo"})
                        self.assertIn("autoMergeAllowed", payload["query"])
                        return {"data": {"repository": {"autoMergeAllowed": allowed}}}, {}
                    return self.api(path, token)
                problems = health.check("synthetic-token", "owner/repo", NOW, api)
                self.assertEqual(bool(problems), not allowed)
                if not allowed:
                    self.assertIn("disabled", problems[0])

    def test_graphql_errors_and_missing_data_fail_without_echoing_response(self):
        for response in ({"errors": [{"message": "synthetic-private-value"}]}, {"data": {"repository": None}}):
            with self.subTest(response=response):
                def api(path, token, payload=None):
                    if path == "/repos/owner/repo":
                        return {}, {}
                    if path == "/graphql":
                        return response, {}
                    return self.api(path, token)
                problems = health.check("synthetic-token", "owner/repo", NOW, api)
                self.assertIn("could not be verified", problems[0])
                self.assertNotIn("synthetic-private-value", str(problems))

    def test_http_failure_does_not_echo_credentials_or_response_details(self):
        error = urllib.error.HTTPError("https://example.invalid/synthetic-private-value", 401,
                                       "synthetic-private-value", {}, None)
        with mock.patch.object(health.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                health.request_json("/installation/repositories", "synthetic-private-value")
        self.assertIn("401", str(raised.exception))
        self.assertNotIn("synthetic-private-value", str(raised.exception))

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
