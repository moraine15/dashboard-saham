"""The Hitam/Putih stylesheet set: coverage, colour discipline and structure."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS_DIR = ROOT / "static" / "css"
INDEX = ROOT / "templates" / "index.html"
LAYERED = ("base.css", "shell.css", "components.css", "views.css", "utilities.css")

# Classes from the old stylesheets that need no rule of their own.
HOOK_ONLY = {
    "grid": "word only (chart 'grid' option, CSS grid values); no element uses the class",
    "layout": "word only; the old .layout wrapper no longer exists",
    "logo": "word only (logo.png); the old .brand .logo badge no longer exists",
    "note": "word only; the old .note background class is unused",
    "view-enter": "still toggled by showTab; the view-change animation was removed (no keyframes)",
}


def _all_css():
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(CSS_DIR.glob("*.css"))}


def _strip_comments(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


class StylesheetTest(unittest.TestCase):
    def test_every_used_class_is_styled_or_listed(self):
        css = "\n".join(_strip_comments(text) for text in _all_css().values())
        names = (ROOT / "tests" / "fixtures" / "ui_classes.txt").read_text(encoding="utf-8").split()
        missing = [name for name in names
                   if name not in HOOK_ONLY and not re.search(r"\." + re.escape(name) + r"(?![\w-])", css)]
        self.assertEqual(missing, [])

    def test_no_hex_outside_tokens(self):
        for name, text in _all_css().items():
            if name == "tokens.css":
                continue
            with self.subTest(file=name):
                self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b", _strip_comments(text)), [])

    def test_important_only_in_utilities(self):
        for name, text in _all_css().items():
            if name == "utilities.css":
                continue
            with self.subTest(file=name):
                self.assertNotIn("!important", _strip_comments(text))

    def test_no_decorative_effects(self):
        for name, text in _all_css().items():
            css = _strip_comments(text)
            with self.subTest(file=name):
                self.assertNotIn("gradient(", css)
                self.assertNotIn("backdrop-filter", css)
                self.assertNotIn("@keyframes", css)
                self.assertNotRegex(css, r"\banimation\s*:")
                for shadow in re.findall(r"box-shadow\s*:\s*([^;]+);", css):
                    self.assertIn(shadow.strip(), ("none", "0 0 0 1px var(--rule)", "inset 3px 0 0 var(--ink)"))

    def test_reduced_motion_disables_transitions(self):
        utilities = _strip_comments(_all_css()["utilities.css"])
        block = re.search(r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(.*?)\}\s*\}", utilities, flags=re.S)
        self.assertIsNotNone(block)
        self.assertIn("transition", block.group(1))

    def test_index_links_new_stylesheets_in_layer_order(self):
        html = INDEX.read_text(encoding="utf-8")
        order = ["tokens.css", *LAYERED]
        positions = []
        for name in order:
            link = '<link rel="stylesheet" href="/static/css/%s?v={{ asset_v(\'css/%s\') }}">' % (name, name)
            match = re.search(re.escape(link), html)
            self.assertIsNotNone(match, name)
            positions.append(match.start())
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("/static/style.css", html)
        self.assertNotIn("/static/workstation.css", html)
        for weight in ("Regular", "SemiBold"):
            self.assertRegex(html, r'<link rel="preload" href="/static/fonts/IBMPlexSans-' + weight
                             + r'-Latin1\.woff2" as="font" type="font/woff2" crossorigin>')

    def test_each_layered_file_uses_its_layer(self):
        layers = {"base.css": "base", "shell.css": "layout", "components.css": "components",
                  "views.css": "views", "utilities.css": "utilities"}
        css = _all_css()
        for name, layer in layers.items():
            with self.subTest(file=name):
                self.assertRegex(_strip_comments(css[name]).strip(), r"^@layer " + layer + r"\s*\{")

    def test_chart_code_has_no_hue_literals(self):
        for path in sorted((ROOT / "static").glob("*.js")):
            with self.subTest(file=path.name):
                self.assertEqual(re.findall(r"#[0-9a-fA-F]{6}\b", path.read_text(encoding="utf-8")), [])

    def test_js_uses_only_current_tokens(self):
        current = {"--bg", "--ink", "--muted", "--rule", "--rule-soft", "--raise", "--up", "--down", "--warn",
                   "--swatch-hitam", "--swatch-putih"}
        for path in sorted((ROOT / "static").glob("*.js")):
            used = set(re.findall(r"var\((--[\w-]+)", path.read_text(encoding="utf-8")))
            with self.subTest(file=path.name):
                self.assertEqual(used - current, set())

    def test_closed_rail_is_inert(self):
        layout = (ROOT / "static" / "layout.js").read_text(encoding="utf-8")
        self.assertIn("rail.inert", layout)

    def _block(self, name, selector):
        css = _strip_comments((CSS_DIR / name).read_text(encoding="utf-8"))
        match = re.search(r"\n\s*" + re.escape(selector) + r"\s*\{([^}]*)\}", css)
        self.assertIsNotNone(match, selector)
        return match.group(1)

    def test_topbar_status_truncates_instead_of_spilling(self):
        # At xlarge the status text spilled over Cari, and the search group over the status.
        self.assertIn("overflow: hidden", self._block("shell.css", ".status-line,\n  .sync-chip"))
        self.assertIn("text-overflow: ellipsis", self._block("shell.css", ".status-line .sync-delay"))
        self.assertNotIn("min-width: 0", self._block("shell.css", ".search"))
        # The search group takes the free space and the input grows inside it, so the
        # input gives way before the status note does.
        self.assertIn("flex: 1 1 auto", self._block("shell.css", ".search"))
        ticker = self._block("shell.css", "#tickerInput")
        self.assertIn("flex: 1 1 auto", ticker)
        self.assertIn("min-width: 120px", ticker)
        self.assertIn("max-width: 320px", ticker)
        # Its intrinsic width (size="20") would otherwise floor it at ~180px.
        self.assertRegex(INDEX.read_text(encoding="utf-8"), r'<input[^>]*id="tickerInput"[^>]*size="\d"')
        # The status note shrinks only after the input has reached its minimum.
        self.assertIn("flex: 0 0.01 auto", self._block("shell.css", ".status-line,\n  .sync-chip"))

    def test_benchmark_rows_scale_with_text_size(self):
        # Fixed 280px columns squeezed the hint into five lines and pushed the reset button out.
        self.assertIn("var(--ui-scale)", self._block("views.css", ".bench-grid"))
        self.assertIn("var(--ui-scale)", self._block("views.css", ".bench-lbl"))
        self.assertIn("white-space: nowrap", self._block("views.css", ".bench-dir"))

    def test_focal_figure_beside_sparkline_stays_on_one_line(self):
        # "Rp-405.878" broke after the minus sign when the column was a fixed share.
        self.assertIn("white-space: nowrap", self._block("views.css", ".home-stat:has(.home-spark) .hs-val"))
        self.assertIn("fit-content(", self._block("views.css", ".home-stat:has(.home-spark)"))

    def test_summary_row_ending_a_section_has_no_second_rule(self):
        # Its bottom rule plus the next section's top rule read as an empty band.
        block = self._block("components.css", ".card > :is(.kpi-row, .porto-summary, .home-grid):last-child")
        self.assertIn("border-bottom: 0", block)
        self.assertIn("margin-bottom: 0", block)

    def test_last_row_of_a_list_drops_its_rule(self):
        # Otherwise it doubles up with the next section's top rule.
        css = _strip_comments("".join((CSS_DIR / n).read_text(encoding="utf-8") for n in ("components.css", "views.css")))
        rules = [sel for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css)
                 if "border-bottom: 0" in body and ":last-child" in sel]
        joined = " ".join(rules)
        for row in (".mover", ".fin-item", ".ath-row", ".newslist", "table.data"):
            with self.subTest(row=row):
                self.assertIn(row, joined)

    def test_secondary_buttons_in_form_rows_match_their_neighbours(self):
        # .ctool is the compact chart-toolbar size; beside a 36px form button it sat short.
        block = self._block("components.css", ":is(.porto-form, .fin-form, .modal-actions) .ctool")
        for prop in ("min-height", "padding", "font-size"):
            with self.subTest(prop=prop):
                self.assertIn(f"{prop}: revert-layer", block)

    def test_set_field_labels_flow_as_text(self):
        # A column-flex label stacked "Jumlah lot (maks", "2" and ")" on three lines.
        css = _strip_comments((CSS_DIR / "components.css").read_text(encoding="utf-8"))
        for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
            if ".set-field label" in sel:
                with self.subTest(selector=" ".join(sel.split())):
                    self.assertNotIn("flex-direction: column", body)

    def test_drawer_widths_give_search_its_own_row(self):
        # At 800px the one-row top bar crushed the refresh button to 16px.
        css = _strip_comments((CSS_DIR / "shell.css").read_text(encoding="utf-8"))
        start = css.index("@media (max-width: 1023px)")
        drawer = css[start:css.index("@media", start + 10)]
        search = re.search(r"\n\s*\.search\s*\{([^}]*)\}", drawer)
        self.assertIsNotNone(search)
        self.assertIn("width: 100%", search.group(1))
        self.assertIn("flex: none", self._block("shell.css", ".search > button,\n  .iconbtn"))
        # The search row must span the whole bar: a long app name once left it 391px of 800.
        right = re.search(r"\n\s*\.topbar-right\s*\{([^}]*)\}", drawer).group(1)
        self.assertIn("display: contents", right)
        brand = re.search(r"\n\s*\.brand\s*\{([^}]*)\}", drawer).group(1)
        self.assertIn("min-height: 36px", brand)
        self.assertIn("flex: 1 1 auto", brand)
        self.assertIn("min-width: 0", brand)

    def test_sparkline_stacks_under_the_figure_on_narrow_screens(self):
        # Beside the figure at 1024px the sparkline column was ~60px and its caption wrapped 4 times.
        css = _strip_comments((CSS_DIR / "views.css").read_text(encoding="utf-8"))
        start = css.index("@media (max-width: 1180px)")
        narrow = css[start:css.index("@media", start + 10)]
        spark = re.search(r"\n\s*\.home-spark\s*\{([^}]*)\}", narrow)
        self.assertIsNotNone(spark)
        self.assertIn("grid-column: 1", spark.group(1))

    def test_topbar_height_does_not_feed_on_its_own_measurement(self):
        # measureChrome writes the bar's height into --topbar-h; using it as the bar's
        # min-height kept the bar tall forever after it had wrapped once.
        self.assertNotIn("var(--topbar-h)", self._block("shell.css", ".topbar"))

    def test_figure_cells_fit_an_eight_digit_amount(self):
        # At 800 px the 150 px cells broke "Rp27.950.000" after "Rp27.950.00".
        block = self._block("components.css", ".kpi-row,\n  .porto-summary,\n  .home-grid")
        minimum = re.search(r"minmax\(calc\((\d+)px \* var\(--ui-scale\)\), 1fr\)", block)
        self.assertIsNotNone(minimum, block)
        self.assertGreaterEqual(int(minimum.group(1)), 170)

    def test_top_bar_controls_stay_right_without_the_search(self):
        # Pribadi hides the stock search; the remaining controls bunched up beside the name.
        self.assertIn("justify-content: flex-end", self._block("shell.css", ".topbar-right"))

    def test_mini_buttons_fit_their_text(self):
        # A fixed 28px width clipped "Tandai dibayar", "Catat masuk" and "Rencana".
        block = self._block("components.css", ".mini")
        self.assertNotRegex(block, r"(?<![\w-])width:\s*28px")
        self.assertIn("min-width: 28px", block)

    def test_skip_link_is_hidden_until_focused(self):
        css = _strip_comments((CSS_DIR / "components.css").read_text(encoding="utf-8"))
        self.assertRegex(css, r"\.skip-link:not\(:focus\)\s*\{[^}]*clip-path")

    def test_old_stylesheets_are_gone(self):
        self.assertFalse((ROOT / "static" / "style.css").exists())
        self.assertFalse((ROOT / "static" / "workstation.css").exists())


if __name__ == "__main__":
    unittest.main()
