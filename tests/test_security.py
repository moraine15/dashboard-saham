import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard


class SecurityContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.owner = root / "owner.json"
        self.state = root / "state.json"
        self.meta = root / "state-meta.json"
        self.admin = root / "admin.json"
        self.patches = [
            patch.object(dashboard, "_OWNER_FILE", str(self.owner)),
            patch.object(dashboard, "_STATE_FILE", str(self.state)),
            patch.object(dashboard, "_STATE_META_FILE", str(self.meta)),
            patch.object(dashboard, "_get_config_file", return_value=str(self.admin)),
        ]
        for item in self.patches: item.start()
        dashboard._LOGIN_ATTEMPTS.clear()
        dashboard._ADMIN_PASSWORD_HASH = None
        dashboard._ADMIN_SALT = None
        dashboard._set_owner_password("pemilik-rahasia")
        dashboard.app.config.update(TESTING=True)
        self.client = dashboard.app.test_client()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.tmp.cleanup()

    def login(self, password="pemilik-rahasia", role="owner"):
        response = self.client.post("/api/auth/login", json={"password": password, "role": role})
        return response, response.get_json().get("csrf_token") if response.is_json else None

    def test_private_page_and_api_are_not_disclosed(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertNotIn(b"saham_portfolio_v1", page.data)
        self.assertNotIn(b"watchlist", page.data.lower())
        self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_login_csrf_revision_and_key_validation(self):
        response, csrf = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.post("/api/state", json={}).status_code, 403)
        headers = {"X-CSRF-Token": csrf}
        ok = self.client.post("/api/state", json={"changes": {"mc_theme": "light"}, "revision": 0}, headers=headers)
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.get_json()["revision"], 1)
        conflict = self.client.post("/api/state", json={"changes": {"mc_theme": "default"}, "revision": 0}, headers=headers)
        self.assertEqual(conflict.status_code, 409)
        invalid = self.client.post("/api/state", json={"changes": {"secret": "x"}, "revision": 1}, headers=headers)
        self.assertEqual(invalid.status_code, 400)

    def test_owner_password_never_returns_in_state(self):
        self.state.write_text(json.dumps({"mc_password": "lama", "mc_theme": "light"}), encoding="utf-8")
        self.owner.unlink()
        dashboard._migrate_owner_password()
        self.assertTrue(dashboard._verify_owner("lama"))
        self.assertNotIn("mc_password", json.loads(self.state.read_text(encoding="utf-8")))

    def test_admin_role_is_required_for_cache_management(self):
        _, csrf = self.login()
        self.assertEqual(self.client.post("/api/cache/clear", headers={"X-CSRF-Token": csrf}).status_code, 403)

    def test_failed_login_is_generic(self):
        response, _ = self.login("salah")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "Kredensial tidak valid.")

    def test_portfolio_period_return_uses_start_value_weights(self):
        _, csrf = self.login()
        returns = {
            "AAAA.JK": {"ret": 100.0, "last": 200.0},
            "BBBB.JK": {"ret": 0.0, "last": 100.0},
            "^JKSE": {"ret": 10.0, "last": 7000.0},
        }
        dashboard._cache_clear()
        with patch.object(dashboard, "_period_return", side_effect=lambda symbol, _rng: returns[symbol]):
            response = self.client.post(
                "/api/portfolio/performance",
                json={"holdings": [{"ticker": "AAAA", "lots": 1}, {"ticker": "BBBB", "lots": 1}], "range": "1y"},
                headers={"X-CSRF-Token": csrf},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["portfolio"], 50.0)


if __name__ == "__main__":
    unittest.main()
