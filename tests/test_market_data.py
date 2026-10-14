"""Indicator math and the stock endpoint's day statistics."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

import app as dashboard
import indicators as ind

WIB = "Asia/Jakarta"


def _frame(closes, start="2026-01-01", freq="D", tz=None, highs=None, lows=None, volumes=None):
    index = pd.date_range(start=start, periods=len(closes), freq=freq, tz=tz)
    return pd.DataFrame({
        "Open": closes,
        "High": highs or [c + 1 for c in closes],
        "Low": lows or [c - 1 for c in closes],
        "Close": closes,
        "Volume": volumes or [1000] * len(closes),
    }, index=index)


class RsiTest(unittest.TestCase):
    def test_pure_uptrend_reads_100(self):
        out = ind.rsi(pd.Series([float(x) for x in range(1, 40)]))
        self.assertAlmostEqual(out.iloc[-1], 100.0)

    def test_flat_series_reads_50(self):
        out = ind.rsi(pd.Series([10.0] * 40))
        self.assertAlmostEqual(out.iloc[-1], 50.0)

    def test_warm_up_is_empty_not_50(self):
        out = ind.rsi(pd.Series([float(x) for x in range(1, 40)]), period=14)
        self.assertTrue(out.iloc[:14].isna().all())
        self.assertFalse(np.isnan(out.iloc[14]))

    def test_short_series_has_no_value(self):
        self.assertTrue(ind.rsi(pd.Series([1.0, 2.0, 3.0])).isna().all())

    def test_wilder_seed_matches_reference(self):
        # Wilder's worked example; published tables round the running averages
        # (70.53, 66.32), the unrounded computation gives these values.
        closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
                  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64]
        out = ind.rsi(pd.Series(closes))
        self.assertAlmostEqual(out.iloc[14], 70.46, delta=0.01)
        self.assertAlmostEqual(out.iloc[15], 66.25, delta=0.01)

    def test_uptrend_signal_is_overbought(self):
        sig = ind.compute_signals(_frame([float(x) for x in range(100, 160)]))
        rsi = next(c for c in sig["components"] if c["name"] == "RSI")
        self.assertEqual(rsi["score"], -1)


class OtherIndicatorTest(unittest.TestCase):
    def test_bollinger_uses_population_deviation(self):
        series = pd.Series([float(x) for x in range(1, 21)])
        upper, mid, _ = ind.bollinger(series, period=20, mult=2.0)
        self.assertAlmostEqual(upper.iloc[-1] - mid.iloc[-1], 2 * np.std(range(1, 21)))

    def test_macd_has_no_value_during_warm_up(self):
        line, signal, _ = ind.macd(pd.Series([float(x) for x in range(60)]))
        self.assertTrue(line.iloc[:25].isna().all())
        self.assertFalse(np.isnan(line.iloc[25]))
        self.assertTrue(signal.iloc[:33].isna().all())

    def test_intraday_chart_time_is_jakarta_wall_clock(self):
        frame = _frame([100.0] * 3, start="2026-10-12 09:00", freq="5min", tz=WIB)
        out = ind.series_for_chart(frame, intraday=True)
        first = pd.Timestamp(out["candles"][0]["time"], unit="s")
        self.assertEqual((first.hour, first.minute), (9, 0))


class DividendYieldTest(unittest.TestCase):
    def test_prefers_dividend_rate_over_price(self):
        self.assertAlmostEqual(dashboard._dividend_yield({"dividendRate": 270, "dividendYield": 99}, 9000), 3.0)

    def test_dividend_yield_field_is_already_percent(self):
        self.assertAlmostEqual(dashboard._dividend_yield({"dividendYield": 0.45}, None), 0.45)
        self.assertAlmostEqual(dashboard._dividend_yield({"dividendYield": 3.1}, 0), 3.1)

    def test_trailing_yield_is_a_fraction(self):
        self.assertAlmostEqual(dashboard._dividend_yield({"trailingAnnualDividendYield": 0.031}, None), 3.1)

    def test_missing_is_none(self):
        self.assertIsNone(dashboard._dividend_yield({}, 9000))


class IntervalAwareTicker:
    """Returns intraday bars for intraday intervals and daily bars for 1d."""

    def __init__(self, intraday, daily, info=None):
        self.intraday, self.daily, self.info = intraday, daily, info or {}

    def history(self, **kwargs):
        return self.daily if kwargs.get("interval") == "1d" else self.intraday


class StockDayStatsTest(unittest.TestCase):
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
        self.client.post("/api/auth/login", json={"password": "pemilik-rahasia"})

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        dashboard._cache_clear()
        self.tmp.cleanup()

    def test_intraday_header_shows_the_daily_change(self):
        daily = _frame([1000.0] * 5 + [1100.0], start="2026-10-04", tz=WIB,
                       highs=[1010.0] * 5 + [1120.0], lows=[990.0] * 5 + [1080.0], volumes=[5000] * 5 + [7000])
        intraday = _frame([1090.0] * 10 + [1100.0], start="2026-10-09 09:00", freq="5min", tz=WIB)
        fake = IntervalAwareTicker(intraday, daily)
        now = pd.Timestamp("2026-10-09 20:00", tz=WIB).to_pydatetime()
        with patch.object(dashboard.yf, "Ticker", return_value=fake), patch.object(dashboard, "_now_wib", return_value=now):
            body = self.client.get("/api/stock/BBCA?range=1d&interval=5m").get_json()
        self.assertAlmostEqual(body["change"], 100.0)
        self.assertAlmostEqual(body["changePct"], 10.0)
        self.assertEqual((body["dayHigh"], body["dayLow"], body["volume"]), (1120.0, 1080.0, 7000.0))

    def test_daily_and_weekly_charts_are_as_of_the_last_session_date(self):
        # A weekly bar is dated at the week start, and a daily bar at midnight;
        # the header showed "Per 2026-10-05 00:00 WIB" for a price from 9 October.
        daily = _frame([1000.0] * 5 + [1100.0], start="2026-10-04", tz=WIB)
        weekly = _frame([990.0] * 29 + [1100.0], start="2026-03-16", freq="7D", tz=WIB)  # last bar: 5 Oct
        fake = IntervalAwareTicker(weekly, daily)
        with patch.object(dashboard.yf, "Ticker", return_value=fake):
            body = self.client.get("/api/stock/BBCA?range=1y&interval=1wk").get_json()
        self.assertEqual(body["asOf"], "2026-10-09")

    def test_intraday_charts_are_as_of_the_last_bar_time(self):
        daily = _frame([1000.0] * 5 + [1100.0], start="2026-10-04", tz=WIB)
        intraday = _frame([1090.0] * 10 + [1100.0], start="2026-10-09 09:00", freq="5min", tz=WIB)
        with patch.object(dashboard.yf, "Ticker", return_value=IntervalAwareTicker(intraday, daily)):
            body = self.client.get("/api/stock/BBCA?range=1d&interval=5m").get_json()
        self.assertEqual(body["asOf"], "2026-10-09 09:50 WIB")

    def test_pivots_use_the_last_completed_session(self):
        daily = _frame([1000.0] * 5 + [1100.0], start="2026-10-04", tz=WIB,
                       highs=[1010.0] * 5 + [1120.0], lows=[990.0] * 5 + [1080.0])
        fake = IntervalAwareTicker(daily, daily)
        during = pd.Timestamp("2026-10-09 10:00", tz=WIB).to_pydatetime()
        with patch.object(dashboard.yf, "Ticker", return_value=fake), patch.object(dashboard, "_now_wib", return_value=during):
            body = self.client.get("/api/stock/BBCA?range=1y&interval=1d").get_json()
        # Session still open: pivots come from the previous day (1010/990/1000).
        self.assertAlmostEqual(body["pivots"]["pivot"], 1000.0)


class YfinanceCacheTest(unittest.TestCase):
    def test_caches_exist_before_requests_run_in_parallel(self):
        # On a fresh data folder, worker threads opening yfinance's SQLite caches at
        # the same moment failed with "database is locked", so quotes showed n/a.
        from yfinance import cache as yf_cache
        import shutil
        folder = tempfile.mkdtemp()
        saved = yf_cache._TzCacheManager._tz_cache
        try:
            yf_cache.set_cache_location(folder)
            yf_cache._TzCacheManager._tz_cache = None  # a new process starts without one
            dashboard._warm_yfinance_caches()
            self.assertTrue(os.path.isfile(os.path.join(folder, "tkr-tz.db")))
        finally:
            yf_cache.set_cache_location(dashboard._YF_CACHE_DIR)
            yf_cache._TzCacheManager._tz_cache = saved
            shutil.rmtree(folder, ignore_errors=True)

    def test_the_server_warms_them_once_at_import(self):
        source = (Path(dashboard.__file__)).read_text(encoding="utf-8")
        located = source.index("yf.set_tz_cache_location(_YF_CACHE_DIR)")
        self.assertGreater(source.index("\n_warm_yfinance_caches()", located), located)


if __name__ == "__main__":
    unittest.main()
