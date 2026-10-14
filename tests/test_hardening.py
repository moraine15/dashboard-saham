"""Backend hardening for a public release: data safety, inputs, caching, sessions."""
import json
import os
import re
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

import app as dashboard
import indicators as ind

ROOT = Path(__file__).resolve().parent.parent
WIB = "Asia/Jakarta"


def _frame(closes, start, freq="D", tz=WIB):
    index = pd.date_range(start, periods=len(closes), freq=freq, tz=tz)
    closes = np.asarray(closes, dtype=float)
    return pd.DataFrame({"Open": closes, "High": closes + 5, "Low": closes - 5,
                         "Close": closes, "Volume": np.full(len(closes), 1000.0)}, index=index)


class _Ticker:
    def __init__(self, intraday, daily):
        self.intraday, self.daily, self.info = intraday, daily, {}

    def history(self, **kwargs):
        return self.daily if kwargs.get("interval") == "1d" else self.intraday


class SignedInBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "state.json"
        self.patches = [
            patch.object(dashboard, "_OWNER_FILE", str(root / "owner.json")),
            patch.object(dashboard, "_STATE_FILE", str(self.state)),
            patch.object(dashboard, "_STATE_META_FILE", str(root / "state-meta.json")),
            patch.object(dashboard, "_APP_FILE", str(root / "app.json")),
            patch.object(dashboard, "_get_config_file", return_value=str(root / "admin.json")),
        ]
        for item in self.patches:
            item.start()
        dashboard._LOGIN_ATTEMPTS.clear()
        dashboard._cache_clear()
        dashboard._set_owner_password("pemilik-rahasia")
        dashboard.app.config.update(TESTING=True)
        self.client = dashboard.app.test_client()
        response = self.client.post("/api/auth/login", json={"password": "pemilik-rahasia"})
        self.headers = {"X-CSRF-Token": response.get_json()["csrf_token"]}

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        dashboard._cache_clear()
        self.tmp.cleanup()


class DayStatsTest(SignedInBase):
    def test_missing_daily_bars_never_fake_day_statistics(self):
        intraday = _frame([1090.0] * 10 + [1100.0], start="2026-10-09 09:00", freq="5min")
        fake = _Ticker(intraday, pd.DataFrame())
        with patch.object(dashboard.yf, "Ticker", return_value=fake):
            body = self.client.get("/api/stock/BBCA?range=1d&interval=5m").get_json()
        self.assertIsNone(body["change"])
        self.assertIsNone(body["changePct"])
        self.assertIsNone(body["dayHigh"])
        self.assertTrue(all(v is None for v in body["pivots"].values()))
        self.assertIsNone(dashboard._cache_get("BBCA.JK:1d:5m"))  # retried next time

    def test_header_shows_a_dash_without_a_daily_change(self):
        app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        render = app_js[app_js.index("function renderDetail("):]
        self.assertIn("d.changePct == null", render[:800])


class StateSafetyTest(SignedInBase):
    def test_clear_on_an_unreadable_file_keeps_the_backup(self):
        self.state.write_text("{rusak", encoding="utf-8")
        backup = Path(str(self.state) + ".bak")
        backup.write_text('{"format": 2, "revision": 3, "epoch": 0, "state": {}}', encoding="utf-8")
        response = self.client.post("/api/state/clear", headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertIn('"revision": 3', backup.read_text(encoding="utf-8"))

    def test_state_with_a_byte_order_mark_still_loads(self):
        doc = {"format": 2, "revision": 4, "epoch": 0, "state": {"mc_theme": "light"}}
        self.state.write_bytes(b"\xef\xbb\xbf" + json.dumps(doc).encode("utf-8"))
        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["revision"], 4)

    def test_state_write_retries_a_busy_file(self):
        real_replace = os.replace
        calls = []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 1:
                raise PermissionError("busy")
            return real_replace(src, dst)

        with patch.object(dashboard.os, "replace", side_effect=flaky):
            dashboard._write_state_doc({"revision": 1, "epoch": 0, "state": {"mc_theme": "light"}})
        self.assertEqual(json.loads(self.state.read_text(encoding="utf-8"))["revision"], 1)

    def test_instance_lock_is_exclusive(self):
        path = os.path.join(self.tmp.name, ".lock")
        first = dashboard._acquire_instance_lock(path)
        self.assertIsNotNone(first)
        self.assertIsNone(dashboard._acquire_instance_lock(path))
        dashboard._release_instance_lock(first)
        again = dashboard._acquire_instance_lock(path)
        self.assertIsNotNone(again)
        dashboard._release_instance_lock(again)


class InputShapeTest(SignedInBase):
    def test_non_object_json_never_causes_a_server_error(self):
        failures = []
        with patch.object(dashboard.yf, "Ticker", side_effect=RuntimeError("offline")), \
                patch.object(dashboard.yf, "download", side_effect=RuntimeError("offline")):
            for rule in dashboard.app.url_map.iter_rules():
                if "POST" not in rule.methods or rule.rule.startswith("/static"):
                    continue
                url = re.sub(r"<[^>]+>", "left", rule.rule)
                response = self.client.post(url, json=[1, 2], headers=self.headers)
                if response.status_code >= 500:
                    failures.append(f"{rule.rule} -> {response.status_code}")
        self.assertEqual(failures, [])

    def test_candles_skip_rows_with_missing_prices(self):
        frame = _frame([100.0, 101.0, 102.0, 103.0], start="2026-10-01")
        frame.iloc[2, frame.columns.get_loc("Open")] = np.nan
        candles = ind.series_for_chart(frame)["candles"]
        self.assertEqual(len(candles), 3)
        self.assertTrue(all(None not in c.values() for c in candles))


class HttpHardeningTest(SignedInBase):
    def test_only_versioned_static_files_are_immutable(self):
        versioned = self.client.get("/static/css/tokens.css?v=abc")
        self.assertIn("immutable", versioned.headers["Cache-Control"])
        versioned.close()
        plain = self.client.get("/static/icon-32.png")
        self.assertNotIn("immutable", plain.headers["Cache-Control"])
        plain.close()
        missing = self.client.get("/static/nope.css?v=abc")
        self.assertNotIn("immutable", missing.headers.get("Cache-Control", ""))
        # Font files never change, and their preloads must not revalidate on every page.
        font = self.client.get("/static/fonts/IBMPlexSans-Regular-Latin1.woff2")
        self.assertIn("immutable", font.headers["Cache-Control"])
        font.close()

    def test_csp_allows_only_the_pinned_chart_script(self):
        csp = self.client.get("/").headers["Content-Security-Policy"]
        self.assertIn("form-action 'self'", csp)
        self.assertNotRegex(csp, r"https://unpkg\.com[;\s]")
        index = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        script = re.search(r'<script src="(https://unpkg\.com/[^"]+)"', index).group(1)
        self.assertIn(script, csp)

    def test_expired_cache_entries_are_purged_on_every_write(self):
        dashboard._cache_set("old", 1)
        later = time.time() + dashboard._TTL + 5
        with patch.object(dashboard.time, "time", return_value=later):
            dashboard._cache_set("new", 2)
        self.assertNotIn("old", dashboard._CACHE)


class SessionHardeningTest(SignedInBase):
    def test_sessions_end_twelve_hours_after_login(self):
        # Each request re-signs the cookie, so activity alone must not keep it alive.
        start = time.time()
        for hours in (6, 11):
            with patch.object(dashboard.time, "time", return_value=start + hours * 3600):
                self.assertTrue(self.client.get("/api/auth/session").get_json()["authenticated"])
        with patch.object(dashboard.time, "time", return_value=start + 13 * 3600):
            self.assertFalse(self.client.get("/api/auth/session").get_json()["authenticated"])
            self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_cookie_has_its_own_name(self):
        self.assertEqual(dashboard.app.config["SESSION_COOKIE_NAME"], "saham_session")

    def test_password_change_is_rate_limited(self):
        codes = [self.client.post("/api/auth/owner/change", headers=self.headers,
                                  json={"current_password": "salah", "new_password": "baru-panjang-sekali"}).status_code
                 for _ in range(9)]
        self.assertEqual(codes[:8], [403] * 8)
        self.assertEqual(codes[8], 429)

    def test_short_seed_passwords_are_refused(self):
        owner = Path(self.tmp.name) / "fresh-owner.json"
        with patch.object(dashboard, "_OWNER_FILE", str(owner)), \
                patch.dict(os.environ, {"OWNER_PASSWORD": "abc"}):
            dashboard._migrate_owner_password()
            self.assertFalse(dashboard._owner_configured())
        saved = (dashboard._ADMIN_PASSWORD_HASH, dashboard._ADMIN_SALT, dashboard._ADMIN_FROM_ENV)
        try:
            with patch.dict(os.environ, {"MASTER_ADMIN_PASSWORD": "1234567"}):
                dashboard._ADMIN_PASSWORD_HASH = None
                dashboard._init_admin_password()
                self.assertIsNone(dashboard._ADMIN_PASSWORD_HASH)
        finally:
            dashboard._ADMIN_PASSWORD_HASH, dashboard._ADMIN_SALT, dashboard._ADMIN_FROM_ENV = saved

    @unittest.skipIf(os.name == "nt", "POSIX file modes")
    def test_private_files_are_owner_only(self):
        path = os.path.join(self.tmp.name, "secret.json")
        dashboard._atomic_json(path, {"a": 1})
        self.assertEqual(os.stat(path).st_mode & 0o077, 0)


if __name__ == "__main__":
    unittest.main()
