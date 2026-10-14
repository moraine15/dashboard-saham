"""Server-side state storage: single-file revisions, corruption safety, epochs."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard


class StateSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "state.json"
        self.meta = root / "state-meta.json"
        self.patches = [
            patch.object(dashboard, "_OWNER_FILE", str(root / "owner.json")),
            patch.object(dashboard, "_STATE_FILE", str(self.state)),
            patch.object(dashboard, "_STATE_META_FILE", str(self.meta)),
            patch.object(dashboard, "_get_config_file", return_value=str(root / "admin.json")),
        ]
        for item in self.patches:
            item.start()
        dashboard._LOGIN_ATTEMPTS.clear()
        dashboard._set_owner_password("pemilik-rahasia")
        dashboard.app.config.update(TESTING=True)
        self.client = dashboard.app.test_client()
        response = self.client.post("/api/auth/login", json={"password": "pemilik-rahasia"})
        self.headers = {"X-CSRF-Token": response.get_json()["csrf_token"]}

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def post(self, changes=None, removals=None, revision=0, **extra):
        body = {"changes": changes or {}, "removals": removals or [], "revision": revision, **extra}
        return self.client.post("/api/state", json=body, headers=self.headers)

    def test_revision_lives_in_the_state_file(self):
        self.assertEqual(self.post({"mc_theme": "light"}).status_code, 200)
        doc = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(doc["format"], 2)
        self.assertEqual(doc["revision"], 1)
        self.assertEqual(doc["state"], {"mc_theme": "light"})
        self.assertFalse(self.meta.exists())

    def test_legacy_flat_state_and_meta_are_migrated(self):
        self.state.write_text(json.dumps({"mc_theme": "light"}), encoding="utf-8")
        self.meta.write_text(json.dumps({"revision": 7}), encoding="utf-8")
        got = self.client.get("/api/state").get_json()
        self.assertEqual(got["state"], {"mc_theme": "light"})
        self.assertEqual(got["revision"], 7)
        self.assertEqual(self.post({"mc_font": "x"}, revision=7).get_json()["revision"], 8)
        doc = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(doc["state"], {"mc_theme": "light", "mc_font": "x"})

    def test_corrupt_state_is_never_served_as_empty(self):
        self.state.write_text("{not json", encoding="utf-8")
        before = self.state.read_bytes()
        self.assertEqual(self.client.get("/api/state").status_code, 503)
        self.assertEqual(self.post({"mc_theme": "light"}).status_code, 503)
        self.assertEqual(self.client.get("/api/state/revision").status_code, 503)
        self.assertEqual(self.state.read_bytes(), before)
        self.assertTrue(list(self.state.parent.glob("state.json.corrupt-*")))

    def test_conflict_reports_revision_and_epoch(self):
        self.post({"mc_theme": "light"})
        conflict = self.post({"mc_theme": "dark"}, revision=0)
        self.assertEqual(conflict.status_code, 409)
        body = conflict.get_json()
        self.assertEqual(body["revision"], 1)
        self.assertIn("epoch", body)

    def test_revision_endpoint(self):
        self.post({"mc_theme": "light"})
        got = self.client.get("/api/state/revision").get_json()
        self.assertEqual(got["revision"], 1)
        self.assertIn("epoch", got)

    def test_clear_changes_epoch_and_rejects_stale_epoch(self):
        self.post({"mc_theme": "light"})
        epoch = self.client.get("/api/state/revision").get_json()["epoch"]
        cleared = self.client.post("/api/state/clear", headers=self.headers).get_json()
        self.assertNotEqual(cleared["epoch"], epoch)
        stale = self.post({"mc_theme": "dark"}, revision=cleared["revision"], epoch=epoch)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["reason"], "epoch")

    def test_previous_state_is_kept_as_backup(self):
        self.post({"mc_theme": "light"})
        self.post({"mc_theme": "dark"}, revision=1)
        backup = json.loads((self.state.parent / "state.json.bak").read_text(encoding="utf-8"))
        self.assertEqual(backup["state"], {"mc_theme": "light"})

    def test_interrupted_write_leaves_previous_state_readable(self):
        self.post({"mc_theme": "light"})
        with patch.object(dashboard.os, "replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                dashboard._write_state_doc({"revision": 9, "epoch": 0, "state": {"mc_theme": "dark"}})
        self.assertEqual(self.client.get("/api/state").get_json()["state"], {"mc_theme": "light"})

    def test_disallowed_key_is_rejected(self):
        self.assertEqual(self.post({"secret": "x"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
