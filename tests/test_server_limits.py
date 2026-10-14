"""Cache bounds, single-flight fetching and login rate limiting."""
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard


class CacheTest(unittest.TestCase):
    def setUp(self):
        dashboard._cache_clear()

    def tearDown(self):
        dashboard._cache_clear()

    def test_empty_results_count_as_cached(self):
        dashboard._cache_set("k", [])
        self.assertEqual(dashboard._cache_get("k"), [])

    def test_expired_entries_are_dropped(self):
        dashboard._cache_set("old", {"v": 1})
        with patch.object(dashboard.time, "time", return_value=time.time() + dashboard._TTL + 1):
            self.assertIsNone(dashboard._cache_get("old"))
        self.assertNotIn("old", dashboard._CACHE)

    def test_size_is_bounded(self):
        with patch.object(dashboard, "_CACHE_MAX", 10):
            for i in range(25):
                dashboard._cache_set(f"k{i}", i)
            self.assertLessEqual(len(dashboard._CACHE), 10)
            self.assertEqual(dashboard._cache_get("k24"), 24)

    def test_concurrent_misses_compute_once(self):
        calls = []

        def slow():
            calls.append(1)
            time.sleep(0.2)
            return "value", True

        results = []
        threads = [threading.Thread(target=lambda: results.append(dashboard._compute_once("same", slow))) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(calls), 1)
        self.assertEqual(results, ["value"] * 5)

    def test_concurrent_callers_share_an_uncacheable_failure(self):
        calls = []
        started = []
        release = threading.Event()

        def failing():
            calls.append(1)
            release.wait(5)  # hold the flight open until every caller has arrived
            return "upstream down", False

        def caller():
            started.append(1)
            results.append(dashboard._compute_once("down", failing))

        results = []
        threads = [threading.Thread(target=caller) for _ in range(5)]
        for t in threads:
            t.start()
        deadline = time.monotonic() + 5
        while len(started) < 5 and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.3)  # let the last callers reach the in-flight wait
        release.set()
        for t in threads:
            t.join()
        self.assertEqual(len(calls), 1)
        self.assertEqual(results, ["upstream down"] * 5)
        self.assertIsNone(dashboard._cache_get("down"))

    def test_uncacheable_results_are_not_stored(self):
        self.assertEqual(dashboard._compute_once("err", lambda: ("bad", False)), "bad")
        self.assertIsNone(dashboard._cache_get("err"))


class LoginLimitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            patch.object(dashboard, "_OWNER_FILE", str(root / "owner.json")),
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
        dashboard._LOGIN_ATTEMPTS.clear()
        self.tmp.cleanup()

    def test_concurrent_wrong_passwords_cannot_exceed_the_limit(self):
        statuses = []

        def attempt():
            client = dashboard.app.test_client()
            statuses.append(client.post("/api/auth/login", json={"password": "salah-sekali"}).status_code)

        threads = [threading.Thread(target=attempt) for _ in range(dashboard._LOGIN_LIMIT + 6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(statuses.count(401), dashboard._LOGIN_LIMIT)
        self.assertEqual(statuses.count(429), 6)

    def test_successful_login_clears_the_counter(self):
        client = dashboard.app.test_client()
        client.post("/api/auth/login", json={"password": "salah-sekali"})
        self.assertEqual(client.post("/api/auth/login", json={"password": "pemilik-rahasia"}).status_code, 200)
        self.assertNotIn("127.0.0.1", dashboard._LOGIN_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
