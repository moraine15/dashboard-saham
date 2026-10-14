"""AI provider probing, timeouts and failure handling."""
import os
import unittest
from unittest.mock import MagicMock, patch

import requests

import ai


class ProbeTest(unittest.TestCase):
    def setUp(self):
        ai._probe_cache.clear()
        self.env = patch.dict(os.environ, {"STOCK_AI_PROVIDER": "ollama"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        ai._probe_cache.clear()

    def test_probe_result_is_reused_for_a_short_while(self):
        with patch.object(ai.requests, "get", return_value=MagicMock(ok=True, status_code=200)) as get:
            self.assertTrue(ai.is_enabled())
            ai.status()
            ai.is_enabled()
        self.assertEqual(get.call_count, 1)

    def test_not_found_means_the_server_is_not_ready(self):
        with patch.object(ai.requests, "get", return_value=MagicMock(ok=False, status_code=404)):
            self.assertFalse(ai.is_enabled())

    def test_local_calls_have_a_bounded_timeout(self):
        response = MagicMock()
        response.json.return_value = {"choices": [{"message": {"content": "ok"}}]}
        with patch.object(ai.requests, "post", return_value=response) as post:
            ai._call_openai_compatible("hai", 10)
        connect, read = post.call_args.kwargs["timeout"]
        self.assertLessEqual(connect, 5)
        self.assertLessEqual(read, 90)

    def test_local_hint_names_no_removed_launcher(self):
        # The jalankan-*.bat launchers are gone; the hint must not send people looking for them.
        with patch.object(ai.requests, "get", return_value=MagicMock(ok=False, status_code=404)):
            hint = ai.status()["hint"]
        self.assertNotIn(".bat", hint)
        self.assertIn("Ollama", hint)

    def test_off_hint_points_to_the_switch_in_settings(self):
        # The switch lives in Pengaturan › Tampilan; the Analisis AI card only links there.
        with patch.dict(os.environ, {"STOCK_AI_PROVIDER": "none"}):
            hint = ai.status()["hint"]
        self.assertIn("Pengaturan", hint)

    def test_failures_do_not_leak_exception_text(self):
        with patch.object(ai, "is_enabled", return_value=True), \
                patch.object(ai, "_call", side_effect=requests.ConnectionError("http://secret-host:11434 refused")):
            out = ai.analyze({"ticker": "BBCA.JK"})
        self.assertNotIn("secret-host", out["text"])
        self.assertIn("tidak merespons", out["text"])


class FallbackTest(unittest.TestCase):
    def test_personal_finance_review_without_ai_shows_no_stock_lines(self):
        # Keuangan and Barang send their own figures, not a stock.
        text = ai._fallback_analyze({"ticker": "KEUANGAN-PRIBADI", "kekayaan": 1000000})
        self.assertNotIn("None", text)
        self.assertNotIn("Harga", text)
        self.assertIn("butuh AI", text)

    def test_missing_stock_figures_show_a_dash(self):
        text = ai._fallback_analyze({"ticker": "GOTO.JK", "price": 50, "signals": {"label": "Netral", "score": 0},
                                     "fundamentals": {"per": None, "roe": None}})
        self.assertNotIn("None", text)
        self.assertIn("PER -", text)
        self.assertIn("ROE -", text)
        self.assertNotIn("-%", text)

    def test_a_failed_model_is_not_reported_as_switched_off(self):
        with patch.object(ai, "is_enabled", return_value=True), \
                patch.object(ai, "_call", side_effect=RuntimeError("boom")):
            analysis = ai.analyze({"ticker": "BBCA.JK", "price": 9000})["text"]
            brief = ai.news_brief([{"title": "Suku bunga naik", "impact": "HIGH"}])["text"]
        for text in (analysis, brief):
            with self.subTest(text=text):
                self.assertIn("tidak merespons", text)
                self.assertNotIn("tidak aktif", text)


if __name__ == "__main__":
    unittest.main()
