"""First-run setup, the app name, and the "by Moraine" credit."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard


class FirstRunBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.owner = root / "owner.json"
        self.state = root / "state.json"
        self.app_file = root / "app.json"
        self.patches = [
            patch.object(dashboard, "_OWNER_FILE", str(self.owner)),
            patch.object(dashboard, "_STATE_FILE", str(self.state)),
            patch.object(dashboard, "_STATE_META_FILE", str(root / "state-meta.json")),
            patch.object(dashboard, "_APP_FILE", str(self.app_file)),
            patch.object(dashboard, "_get_config_file", return_value=str(root / "admin.json")),
        ]
        for item in self.patches:
            item.start()
        dashboard._LOGIN_ATTEMPTS.clear()
        dashboard._SETUP["code"] = None
        dashboard.app.config.update(TESTING=True)
        self.client = dashboard.app.test_client()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def setup(self, **overrides):
        body = {"password": "rahasia-baru", "app_name": "Dompet Keluarga", "code": dashboard._setup_code()}
        body.update(overrides)
        return self.client.post("/api/auth/setup", json=body)


class SetupTest(FirstRunBase):
    def test_setup_saves_the_name_and_signs_the_owner_in(self):
        response = self.setup()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["csrf_token"])
        session = self.client.get("/api/auth/session").get_json()
        self.assertTrue(session["authenticated"])
        self.assertEqual(session["role"], "owner")
        self.assertTrue(dashboard._owner_configured())
        self.assertEqual(dashboard._app_name(), "Dompet Keluarga")

    def test_setup_code_is_required_and_one_time(self):
        self.assertEqual(self.setup(code="").status_code, 403)
        self.assertEqual(self.setup(code="AAAA-AAAA").status_code, 403)
        self.assertFalse(dashboard._owner_configured())
        code = dashboard._setup_code()
        typed = code.lower().replace("-", " ")  # case and separators don't matter
        self.assertEqual(self.setup(code=typed).status_code, 200)
        self.assertIsNone(dashboard._SETUP["code"])

    def test_setup_only_from_the_server_computer(self):
        remote = self.client.post("/api/auth/setup", environ_base={"REMOTE_ADDR": "192.168.1.20"},
                                  json={"password": "rahasia-baru", "code": dashboard._setup_code()})
        self.assertEqual(remote.status_code, 403)
        proxied = self.client.post("/api/auth/setup", headers={"X-Forwarded-For": "203.0.113.9"},
                                   json={"password": "rahasia-baru", "code": dashboard._setup_code()})
        self.assertEqual(proxied.status_code, 403)
        rebound = self.client.post("/api/auth/setup", base_url="http://evil.test/",
                                   json={"password": "rahasia-baru", "code": dashboard._setup_code()})
        self.assertEqual(rebound.status_code, 403)
        self.assertFalse(dashboard._owner_configured())

    def test_setup_rejects_short_passwords_and_runs_once(self):
        self.assertEqual(self.setup(password="pendek").status_code, 400)
        self.assertFalse(dashboard._owner_configured())
        self.assertEqual(self.setup().status_code, 200)
        self.assertEqual(self.setup(password="lain-lagi-panjang").status_code, 409)

    def test_unreadable_owner_file_is_never_overwritten(self):
        self.owner.write_text("{rusak", encoding="utf-8")
        self.assertTrue(dashboard._owner_configured())
        self.assertEqual(self.setup().status_code, 409)
        self.assertEqual(self.owner.read_text(encoding="utf-8"), "{rusak")

    def test_non_object_body_is_rejected(self):
        self.assertEqual(self.client.post("/api/auth/setup", json=[1, 2]).status_code, 400)


class AppNameTest(FirstRunBase):
    def test_name_cleaning(self):
        self.assertEqual(dashboard._clean_app_name("  Dompet\x07  Keluarga \n"), "Dompet Keluarga")
        self.assertEqual(dashboard._clean_app_name(""), dashboard.DEFAULT_APP_NAME)
        self.assertEqual(dashboard._clean_app_name(None), dashboard.DEFAULT_APP_NAME)
        self.assertEqual(len(dashboard._clean_app_name("x" * 90)), 40)

    def test_default_name_until_one_is_set(self):
        self.assertEqual(dashboard._app_name(), "Dashboard Saham")

    def test_renaming_needs_a_session_and_csrf(self):
        self.assertEqual(self.client.post("/api/app", json={"name": "Baru"}).status_code, 401)
        token = self.setup().get_json()["csrf_token"]
        self.assertEqual(self.client.post("/api/app", json={"name": "Baru"}).status_code, 403)
        response = self.client.post("/api/app", json={"name": "  Portofolio   Ayah "},
                                    headers={"X-CSRF-Token": token})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["name"], "Portofolio Ayah")
        self.assertEqual(dashboard._app_name(), "Portofolio Ayah")

    def test_pages_show_the_name_and_credit_escaped(self):
        dashboard._set_app_name("<script>x</script>")
        login = self.client.get("/").get_data(as_text=True)
        self.assertIn("&lt;script&gt;x&lt;/script&gt;", login)
        self.assertNotIn("<script>x</script>", login)
        self.assertIn("by Moraine", login)
        token = self.setup(app_name="<script>x</script>").get_json()["csrf_token"]
        self.assertTrue(token)
        page = self.client.get("/").get_data(as_text=True)
        self.assertIn("<title>&lt;script&gt;x&lt;/script&gt;</title>", page)
        self.assertIn('<meta name="application-name" content="&lt;script&gt;x&lt;/script&gt;">', page)
        self.assertIn('class="brand-by">by Moraine<', page)

    def test_about_pane_names_version_source_disclaimer_and_credits(self):
        self.setup()
        page = self.client.get("/").get_data(as_text=True)
        about = page[page.index('id="setPane-tentang"'):]
        about = about[:about.index("</section>")]
        self.assertIn(dashboard.APP_CREDIT, about)
        self.assertIn(f"versi {dashboard.APP_VERSION}", about)
        self.assertIn("Yahoo Finance", about)
        self.assertIn("15 menit", about)
        self.assertIn("bukan rekomendasi", about)
        # Lightweight Charts' license asks for its notice and a link to TradingView.
        self.assertIn("TradingView Lightweight Charts", about)
        self.assertIn('href="https://www.tradingview.com/"', about)
        self.assertIn("IBM Plex Sans", about)

    def test_login_page_explains_setup_to_other_devices(self):
        local = self.client.get("/").get_data(as_text=True)
        self.assertIn('id="setupPassword2"', local)
        self.assertIn('id="setupName"', local)
        remote = self.client.get("/", environ_base={"REMOTE_ADDR": "192.168.1.20"}).get_data(as_text=True)
        self.assertNotIn('id="setupPassword"', remote)
        self.assertIn("komputer yang menjalankan aplikasi", remote)


class AppNameSeedTest(FirstRunBase):
    def test_seed_from_environment(self):
        with patch.dict(os.environ, {"APP_NAME": "Saham Rumah"}):
            dashboard._seed_app_name()
        self.assertEqual(dashboard._app_name(), "Saham Rumah")

    def test_seed_from_legacy_profile_brand(self):
        profile = json.dumps({"name": "A", "brand": "Merek Lama"})
        self.state.write_text(json.dumps({"format": 2, "revision": 1, "epoch": 0,
                                          "state": {"saham_profile": profile}}), encoding="utf-8")
        with patch.dict(os.environ, {"APP_NAME": ""}):
            dashboard._seed_app_name()
        self.assertEqual(dashboard._app_name(), "Merek Lama")

    def test_existing_setting_is_not_overwritten(self):
        dashboard._set_app_name("Sudah Ada")
        with patch.dict(os.environ, {"APP_NAME": "Lain"}):
            dashboard._seed_app_name()
        self.assertEqual(dashboard._app_name(), "Sudah Ada")


if __name__ == "__main__":
    unittest.main()
