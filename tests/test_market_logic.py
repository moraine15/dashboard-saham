"""Market data helpers and endpoints.

No network is used: yfinance is mocked with unittest.mock. Data files are
isolated through patch.object on the module-level path constants.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

import app as dashboard
import indicators as ind


def _frame(rows, start="2024-01-01", freq="D", tz=None):
    """Build an OHLCV frame of a given length with a DatetimeIndex."""
    index = pd.date_range(start=start, periods=rows, freq=freq, tz=tz)
    close = [100 + i for i in range(rows)]
    data = {
        "Open": [c - 1 for c in close],
        "High": [c + 2 for c in close],
        "Low": [c - 2 for c in close],
        "Close": close,
        "Volume": [1000 + i for i in range(rows)],
    }
    return pd.DataFrame(data, index=index)


class FakeTicker:
    """Minimal stand-in for yfinance.Ticker."""

    def __init__(self, hist, info=None):
        self._hist = hist
        self.info = info or {}
        self.history_kwargs = None

    def history(self, **kwargs):
        self.history_kwargs = kwargs
        return self._hist


class PercentNormalizationTest(unittest.TestCase):
    def test_pct_treats_values_as_fractions(self):
        # ROE/ROA/NPM/payoutRatio arrive as fractions and are scaled to percent.
        self.assertAlmostEqual(dashboard._pct(0.23), 23.0)
        self.assertAlmostEqual(dashboard._pct(1.2), 120.0)
        self.assertAlmostEqual(dashboard._pct(-0.05), -5.0)
        self.assertIsNone(dashboard._pct(None))
        self.assertIsNone(dashboard._pct(float("nan")))


class ChartSeriesTest(unittest.TestCase):
    def test_duplicate_daily_index_is_collapsed(self):
        frame = _frame(10)
        duplicated = pd.concat([frame, frame.iloc[[-1]]])  # repeat last bar
        self.assertTrue(duplicated.index.has_duplicates)
        out = ind.series_for_chart(duplicated, intraday=False)
        times = [c["time"] for c in out["candles"]]
        self.assertEqual(len(times), len(set(times)), "candle times must be unique")

    def test_intraday_times_are_unique_and_sorted(self):
        frame = _frame(12, freq="5min")
        shuffled = pd.concat([frame.iloc[6:], frame.iloc[:6], frame.iloc[[6]]])
        out = ind.series_for_chart(shuffled, intraday=True)
        times = [c["time"] for c in out["candles"]]
        self.assertEqual(times, sorted(times))
        self.assertEqual(len(times), len(set(times)))
        self.assertTrue(all(isinstance(t, int) for t in times))

    def test_daily_times_are_date_strings(self):
        out = ind.series_for_chart(_frame(8), intraday=False)
        self.assertTrue(all(isinstance(c["time"], str) for c in out["candles"]))


class BackendEndpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            patch.object(dashboard, "_OWNER_FILE", str(root / "owner.json")),
            patch.object(dashboard, "_STATE_FILE", str(root / "state.json")),
            patch.object(dashboard, "_STATE_META_FILE", str(root / "meta.json")),
            patch.object(dashboard, "_get_config_file", return_value=str(root / "admin.json")),
        ]
        for item in self.patches:
            item.start()
        self.saved_env = os.environ.pop("MASTER_ADMIN_PASSWORD", None)
        dashboard._init_admin_password()
        dashboard._LOGIN_ATTEMPTS.clear()
        dashboard._cache_clear()
        dashboard._set_owner_password("pemilik-rahasia")
        dashboard.app.config.update(TESTING=True)
        self.client = dashboard.app.test_client()
        response = self.client.post("/api/auth/login", json={"password": "pemilik-rahasia"})
        self.headers = {"X-CSRF-Token": response.get_json()["csrf_token"]}

    def tearDown(self):
        os.environ.pop("MASTER_ADMIN_PASSWORD", None)
        if self.saved_env is not None:
            os.environ["MASTER_ADMIN_PASSWORD"] = self.saved_env
        for item in reversed(self.patches):
            item.stop()
        dashboard._init_admin_password()
        dashboard._cache_clear()
        self.tmp.cleanup()

    def test_stock_reports_percent_values_and_passes_timeout(self):
        fake = FakeTicker(_frame(60), info={
            "longName": "Bank Test",
            "dividendYield": 3.1,       # already a percent
            "returnOnEquity": 0.23,     # fraction -> 23%
            "trailingPE": 10.0,
            "priceToBook": 1.5,
        })
        with patch.object(dashboard.yf, "Ticker", return_value=fake):
            response = self.client.get("/api/stock/BBCA?range=1y&interval=1d")
        self.assertEqual(response.status_code, 200)
        fundamentals = response.get_json()["fundamentals"]
        self.assertAlmostEqual(fundamentals["dividendYield"], 3.1)
        self.assertAlmostEqual(fundamentals["roe"], 23.0)
        # The history call must carry an explicit read timeout.
        self.assertIn("timeout", fake.history_kwargs)
        self.assertEqual(fake.history_kwargs["timeout"], dashboard._YF_TIMEOUT)

    def test_stock_rejects_duplicate_free_chart_output(self):
        # Intraday frame with a duplicated timestamp must not crash the chart
        # payload and must deduplicate candle times.
        frame = _frame(40, freq="5min")
        dup = pd.concat([frame, frame.iloc[[-1]]])
        fake = FakeTicker(dup, info={"longName": "X"})
        with patch.object(dashboard.yf, "Ticker", return_value=fake):
            response = self.client.get("/api/stock/BBCA?range=1d&interval=5m")
        self.assertEqual(response.status_code, 200)
        candles = response.get_json()["chart"]["candles"]
        times = [c["time"] for c in candles]
        self.assertEqual(len(times), len(set(times)))

    def test_news_cache_key_is_scoped_by_limit(self):
        calls = []

        def fake_market(limit):
            calls.append(limit)
            return {"query": "x", "count": 1, "items": [{"title": "x"}], "note": ""}

        with patch.object(dashboard.news_mod, "market_news", side_effect=fake_market):
            self.client.get("/api/news/market?limit=5")
            self.client.get("/api/news/market?limit=5")   # served from cache
            self.client.get("/api/news/market?limit=25")  # different key, refetch
        self.assertEqual(calls, [5, 25])

    def test_market_chart_rejects_unknown_symbol_without_upstream(self):
        with patch.object(dashboard.yf, "Ticker", side_effect=AssertionError("no upstream")):
            response = self.client.get("/api/marketchart/EVIL?range=1y&interval=1d")
        self.assertEqual(response.status_code, 400)

    def test_owner_password_migration_from_env(self):
        # Fresh owner file missing + OWNER_PASSWORD env should seed a scrypt hash.
        os.remove(dashboard._OWNER_FILE)
        with patch.dict(os.environ, {"OWNER_PASSWORD": "rahasia-env-123"}):
            dashboard._migrate_owner_password()
        self.assertTrue(dashboard._verify_owner("rahasia-env-123"))


class AiProviderTest(unittest.TestCase):
    def tearDown(self):
        import ai as ai_mod
        ai_mod._override = None

    def test_web_toggle_on_uses_ollama_when_env_off(self):
        import ai as ai_mod
        with patch.dict(os.environ, {"STOCK_AI_PROVIDER": "none"}):
            ai_mod.set_mode(True)
            self.assertEqual(ai_mod.provider(), "ollama")
            ai_mod.set_mode(False)
            self.assertEqual(ai_mod.provider(), "none")


if __name__ == "__main__":
    unittest.main()
