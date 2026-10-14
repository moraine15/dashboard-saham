"""Environment file loading and session revocation."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard


class EnvFileTest(unittest.TestCase):
    def test_values_are_loaded_without_overriding_the_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text(
                "# comment\n\nSAHAM_TEST_A=from-file\nSAHAM_TEST_B = \"quoted value\"\n"
                "SAHAM_TEST_C=kept\nnot a pair\nexport SAHAM_TEST_D=exported\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"SAHAM_TEST_C": "from-env"}, clear=False):
                dashboard._load_env_file(str(path))
                self.assertEqual(os.environ["SAHAM_TEST_A"], "from-file")
                self.assertEqual(os.environ["SAHAM_TEST_B"], "quoted value")
                self.assertEqual(os.environ["SAHAM_TEST_C"], "from-env")
                self.assertEqual(os.environ["SAHAM_TEST_D"], "exported")
            for key in ("SAHAM_TEST_A", "SAHAM_TEST_B", "SAHAM_TEST_D"):
                os.environ.pop(key, None)

    def test_missing_file_is_ignored(self):
        dashboard._load_env_file(os.path.join(tempfile.gettempdir(), "does-not-exist.env"))


class SessionRevocationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            patch.object(dashboard, "_OWNER_FILE", str(root / "owner.json")),
            patch.object(dashboard, "_STATE_FILE", str(root / "state.json")),
            patch.object(dashboard, "_get_config_file", return_value=str(root / "admin.json")),
        ]
        for item in self.patches:
            item.start()
        dashboard._LOGIN_ATTEMPTS.clear()
        dashboard._set_owner_password("pemilik-rahasia")
        dashboard.app.config.update(TESTING=True)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def login(self, password="pemilik-rahasia"):
        client = dashboard.app.test_client()
        token = client.post("/api/auth/login", json={"password": password}).get_json().get("csrf_token")
        return client, {"X-CSRF-Token": token}

    def test_password_change_signs_out_other_devices_but_not_this_one(self):
        laptop, laptop_headers = self.login()
        phone, _ = self.login()
        changed = laptop.post("/api/auth/owner/change", headers=laptop_headers,
                              json={"current_password": "pemilik-rahasia", "new_password": "rahasia-baru-1"})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(phone.get("/api/state").status_code, 401)
        self.assertEqual(laptop.get("/api/state").status_code, 200)

    def test_logout_only_ends_this_session(self):
        laptop, laptop_headers = self.login()
        phone, _ = self.login()
        laptop.post("/api/auth/logout", headers=laptop_headers)
        self.assertEqual(laptop.get("/api/state").status_code, 401)
        self.assertEqual(phone.get("/api/state").status_code, 200)


if __name__ == "__main__":
    unittest.main()
