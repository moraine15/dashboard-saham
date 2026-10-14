import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class InvestmentCoreTest(unittest.TestCase):
    def test_node_investment_suite(self):
        result = subprocess.run(
            ["node", "--test", "tests/investments.test.js"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_investment_ui_and_script_wiring(self):
        html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        required_ids = (
            "investmentNav",
            "investmentSummary",
            "fundForm",
            "fundTable",
            "bondForm",
            "bondTable",
            "couponTable",
        )
        for element_id in required_ids:
            self.assertIn(f'id="{element_id}"', html)

        scripts = (
            "/static/investments-core.js",
            "/static/app.js",
            "/static/finance.js",
            "/static/investments.js",
            "/static/home.js",
        )
        positions = [html.index(script) for script in scripts]
        self.assertEqual(positions, sorted(positions))

    def test_investment_state_keys_are_synchronized(self):
        app_py = (ROOT / "app.py").read_text(encoding="utf-8")
        for key in ("mc_mutual_funds_v1", "mc_bonds_v1", "mc_investment_view_v1"):
            self.assertIn(f'"{key}"', app_py)

    def test_investment_module_exposes_integration_api(self):
        path = ROOT / "static" / "investments.js"
        self.assertTrue(path.exists(), "static/investments.js must exist")
        source = path.read_text(encoding="utf-8")
        for api in ("window.investmentTotals", "window.investmentRefreshStocks"):
            self.assertIn(api, source)

    def test_investment_layout_has_responsive_styles(self):
        css = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "static" / "css").glob("*.css"))
        for selector in (".investment-nav", ".investment-form", ".investment-allocation-row", ".form-error"):
            self.assertIn(selector, css)
        views = (ROOT / "static" / "css" / "views.css").read_text(encoding="utf-8")
        self.assertRegex(views, r"@media \(max-width: 1180px\)[^}]*\.investment-form")

    def test_coupon_posting_and_unified_wealth_are_wired(self):
        finance = (ROOT / "static" / "finance.js").read_text(encoding="utf-8")
        investments = (ROOT / "static" / "investments.js").read_text(encoding="utf-8")
        app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        home = (ROOT / "static" / "home.js").read_text(encoding="utf-8")
        html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")

        for api in ("window.financePostIncome", "window.financeReversePosting"):
            self.assertIn(api, finance)
        self.assertIn("inclInvestments", finance)
        self.assertIn("Nilai Investasi", finance)
        self.assertIn("Unrealized Investasi/IPO", finance)
        self.assertIn("window.investmentTotals", home)
        self.assertIn("window.investmentRefreshStocks", app_js)
        self.assertIn("sertakan nilai investasi", html)
        self.assertIn("data-coupon-pay", investments)
        self.assertIn("data-coupon-reverse", investments)


if __name__ == "__main__":
    unittest.main()
