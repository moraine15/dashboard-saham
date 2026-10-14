"""Headline impact/sentiment rules and news fetching."""
import time
import unittest
from unittest.mock import patch

import news


class ClassifyTest(unittest.TestCase):
    def check(self, title, impact=None, sentiment=None):
        got = news.classify(title)
        if impact:
            self.assertEqual(got["impact"], impact, title)
        if sentiment:
            self.assertEqual(got["sentiment"], sentiment, title)

    def test_rate_hike_and_rising_inflation_are_negative(self):
        self.check("BI naikkan suku bunga, inflasi melonjak", impact="HIGH", sentiment="NEGATIF")
        self.check("The Fed menaikkan suku bunga acuan", sentiment="NEGATIF")

    def test_rate_cut_is_positive(self):
        self.check("BI pangkas suku bunga 25 bps", impact="HIGH", sentiment="POSITIF")
        self.check("Inflasi melandai, suku bunga turun", sentiment="POSITIF")

    def test_stable_rupiah_is_not_high_impact(self):
        self.assertNotEqual(news.classify("Rupiah stabil di awal pekan")["impact"], "HIGH")
        self.check("Rupiah anjlok tembus 17.000 per dolar AS", impact="HIGH", sentiment="NEGATIF")

    def test_words_match_whole_words_only(self):
        # "tertekan" must not also count "tekan"; "naik" must not match "kenaikan" wrongly twice.
        self.assertEqual(news.classify("IHSG tertekan")["score"]["neg"], 1)

    def test_negation_flips_the_direction(self):
        self.check("Laba bank tidak turun meski kredit melambat", sentiment="POSITIF")
        self.check("Saham BBCA batal naik", sentiment="NEGATIF")

    def test_plain_headline_is_low_and_neutral(self):
        self.check("Jadwal libur bursa akhir tahun", impact="MED", sentiment="NETRAL")
        self.check("Peluncuran aplikasi baru", impact="LOW", sentiment="NETRAL")


class FetchTest(unittest.TestCase):
    def test_market_queries_run_in_parallel(self):
        def slow(query, limit):
            time.sleep(0.3)
            return [{"title": query, "credible": True, "impact": "LOW"}]

        with patch.object(news, "_google_news", side_effect=slow):
            started = time.monotonic()
            out = news.market_news(limit=10)
            elapsed = time.monotonic() - started
        self.assertEqual(out["count"], 4)
        self.assertLess(elapsed, 0.9)

    def test_feed_timeout_is_short(self):
        with patch.object(news.requests, "get", side_effect=news.requests.Timeout()) as get:
            self.assertEqual(news._google_news("x"), [])
        self.assertLessEqual(get.call_args.kwargs["timeout"], 8)


if __name__ == "__main__":
    unittest.main()
