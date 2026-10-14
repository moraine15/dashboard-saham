"""Portfolio, quote and market endpoints with upstream data mocked."""
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

import app as dashboard


def _frame(closes, start="2026-10-01"):
    index = pd.date_range(start=start, periods=len(closes), freq="D")
    return pd.DataFrame({"Open": closes, "High": closes, "Low": closes, "Close": closes,
                         "Volume": [1000] * len(closes)}, index=index)


class FakeTicker:
    def __init__(self, hist, info=None):
        self.hist, self.info = hist, info or {}
        self.kwargs = None

    def history(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.hist, Exception):
            raise self.hist
        return self.hist


class ApiTestCase(unittest.TestCase):
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
        dashboard._cache_clear()
        dashboard._set_owner_password("pemilik-rahasia")
        dashboard.app.config.update(TESTING=True)
        self.client = dashboard.app.test_client()
        token = self.client.post("/api/auth/login", json={"password": "pemilik-rahasia"}).get_json()["csrf_token"]
        self.headers = {"X-CSRF-Token": token}

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        dashboard._cache_clear()
        self.tmp.cleanup()


class QuoteTest(ApiTestCase):
    def test_trailing_empty_bar_is_ignored_and_prices_are_unadjusted(self):
        fake = FakeTicker(_frame([100.0, 110.0, np.nan]))
        with patch.object(dashboard.yf, "Ticker", return_value=fake):
            response = self.client.get("/api/quote/BBCA")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["price"], 110.0)
        self.assertAlmostEqual(body["changePct"], 10.0)
        self.assertIs(fake.kwargs.get("auto_adjust"), False)


class HoldingsValidationTest(ApiTestCase):
    def test_non_list_holdings_are_rejected(self):
        for path in ("/api/portfolio", "/api/portfolio/performance", "/api/portfolio/valueseries", "/api/dividends"):
            with self.subTest(path=path):
                response = self.client.post(path, json={"holdings": {"ticker": "BBCA"}}, headers=self.headers)
                self.assertEqual(response.status_code, 400)

    def test_bad_entries_are_skipped_not_crashing(self):
        holdings = ["BBCA", {"ticker": "BBCA", "avg": "nan", "lots": 1}, {"ticker": "BBCA", "avg": 100, "lots": "inf"}]
        with patch.object(dashboard.yf, "Ticker", side_effect=AssertionError("no upstream")):
            response = self.client.post("/api/portfolio", json={"holdings": holdings}, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["holdings"], [])


class ValueSeriesTest(ApiTestCase):
    def test_a_failed_ticker_does_not_empty_the_series(self):
        good = FakeTicker(_frame([100.0, 101.0, 102.0]))
        bad = FakeTicker(RuntimeError("delisted"))
        with patch.object(dashboard.yf, "Ticker", side_effect=lambda tk: good if tk == "BBCA.JK" else bad):
            response = self.client.post("/api/portfolio/valueseries", headers=self.headers, json={
                "holdings": [{"ticker": "BBCA", "avg": 100, "lots": 1}, {"ticker": "XXXX", "avg": 100, "lots": 1}],
            })
        body = response.get_json()
        self.assertEqual(len(body["series"]), 3)
        self.assertEqual(body["series"][-1]["value"], 10200.0)


class GoldTest(ApiTestCase):
    def test_gold_in_rupiah_includes_the_exchange_rate_move(self):
        quotes = {
            "GC=F": {"symbol": "GC=F", "price": 2000.0, "changePct": 1.0},
            "SI=F": {"symbol": "SI=F", "price": 25.0, "changePct": 0.0},
            "IDR=X": {"symbol": "IDR=X", "price": 16000.0, "changePct": 2.0},
        }
        with patch.object(dashboard, "_market_quote", side_effect=lambda sym: quotes[sym]):
            items = self.client.get("/api/gold").get_json()["items"]
        gram = next(i for i in items if i["name"] == "Emas (IDR / gram)")
        self.assertAlmostEqual(gram["changePct"], 3.02)
        usd = next(i for i in items if i["name"] == "Emas (USD / oz)")
        self.assertAlmostEqual(usd["changePct"], 1.0)
        self.assertFalse(math.isnan(gram["price"]))


if __name__ == "__main__":
    unittest.main()
