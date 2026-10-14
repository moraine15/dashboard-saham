"""Markup, styling and admin-password contracts for the dashboard."""
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard

ROOT = Path(__file__).resolve().parent.parent
INDEX = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
APP_JS = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
# Functional glyphs stay: drag handle, credible-source mark, delete, play.
EMOJI = re.compile(r"(?![\u2630\u2713\u2715\u25B6])[\U0001F000-\U0001FAFF\u2600-\u26FF\u2700-\u27BF]\uFE0F?")


class MarkupContractTest(unittest.TestCase):
    def test_navigation_labels_live_in_html(self):
        for label in ("Ringkasan", "Analisis", "Portofolio", "Keuangan"):
            self.assertRegex(INDEX, rf'role="tab"[^>]*>{label}</button>')

    def test_every_tab_controls_an_existing_panel(self):
        for panel in re.findall(r'aria-controls="([^"]+)"', INDEX):
            self.assertIn(f'id="{panel}"', INDEX)

    def test_markup_has_no_decorative_emoji_or_inline_styles(self):
        self.assertEqual(EMOJI.findall(INDEX), [])
        self.assertNotIn('style="', INDEX)

    def test_toast_has_live_region_and_dialog_semantics(self):
        self.assertIn('id="toastLive"', INDEX)
        self.assertIn('role="status" aria-live="polite"', INDEX)
        self.assertIn('role="dialog" aria-modal="true" aria-labelledby="sellTitle"', INDEX)

    def test_money_charts_follow_privacy_mode_and_rupiah_format(self):
        # The net worth and portfolio value charts print the owner's money on their axes.
        self.assertRegex(INDEX, r'id="finChart" class="[^"]*\bpriv\b')
        self.assertRegex(INDEX, r'id="pvalChart" class="[^"]*\bpriv\b')
        finance = (ROOT / "static" / "finance.js").read_text(encoding="utf-8")
        value_chart = APP_JS[APP_JS.index("async function loadValueChart"):]
        for name, source in (("finance.js", finance), ("loadValueChart", value_chart[:value_chart.index("\n}\n")])):
            with self.subTest(chart=name):
                self.assertIn("priceFormatter", source)

    def test_admin_password_minimum_matches_the_server(self):
        # The server asks for 8 characters; the form must not promise 6.
        self.assertIn('id="adminPassSetting" type="password" minlength="8"', INDEX)
        self.assertIn('next.length < 8', APP_JS)
        self.assertNotIn("minimal 6 karakter", APP_JS)

    def test_no_background_grid_or_glow(self):
        paths = sorted((ROOT / "static" / "css").glob("*.css"))
        paths += [path for path in (ROOT / "static" / "login.css", ROOT / "static" / "fresh-start.css") if path.exists()]
        for path in paths:
            css = path.read_text(encoding="utf-8")
            with self.subTest(name=path.name):
                self.assertNotIn("body::before", css)
                self.assertNotIn("radial-gradient", css)


class BackendContractTest(unittest.TestCase):
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
        self.tmp.cleanup()

    def test_stock_rejects_unsupported_interval_for_range(self):
        self.assertEqual(self.client.get("/api/stock/BBCA?range=1y&interval=5m").status_code, 400)
        self.assertEqual(self.client.get("/api/stock/BBCA?range=1d&interval=1d").status_code, 400)

    def test_market_chart_only_serves_known_instruments(self):
        self.assertEqual(self.client.get("/api/marketchart/EVIL?range=1y&interval=1d").status_code, 400)

    def test_invalid_ticker_is_rejected_without_upstream_call(self):
        with patch.object(dashboard.yf, "Ticker", side_effect=AssertionError("no upstream call")):
            self.assertEqual(self.client.get("/api/quote/%3Cx%3E").status_code, 400)
            self.assertEqual(self.client.get("/api/financials/%3Cx%3E").status_code, 400)

    def test_owner_cannot_manage_admin_password(self):
        response = self.client.post("/api/admin/change", json={"current_password": "x", "new_password": "abcdefgh"}, headers=self.headers)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.post("/api/admin/set", json={"password": "abcdefgh"}, headers=self.headers).status_code, 404)

    def test_env_admin_password_wins_and_is_read_only(self):
        os.environ["MASTER_ADMIN_PASSWORD"] = "dari-env-123"
        dashboard._init_admin_password()
        self.assertTrue(dashboard.verify_admin_password("dari-env-123"))
        self.assertEqual(dashboard.admin_password_source(), "env")
        self.assertFalse(dashboard.change_admin_password("dari-env-123", "baru-123456")["success"])

    def test_file_admin_password_change_requires_current(self):
        self.assertFalse(dashboard.change_admin_password("apa-saja", "kedua-12")["success"])
        dashboard._write_admin_password("pertama-1", {})
        self.assertFalse(dashboard.change_admin_password("salah", "kedua-12")["success"])
        self.assertTrue(dashboard.change_admin_password("pertama-1", "kedua-12")["success"])
        self.assertTrue(dashboard.verify_admin_password("kedua-12"))


def _count_unlabelled_fields(html):
    """Count form fields in the markup that lack any associated label.

    A field counts as labelled when it is nested inside a <label>, when its id
    is referenced by a label[for], or when it carries aria-label/aria-labelledby.
    type=hidden fields and file inputs inside a visible label are not counted.
    """
    from html.parser import HTMLParser

    class FieldParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.label_depth = 0
            self.label_fors = set()
            self.fields = []

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if tag == "label":
                self.label_depth += 1
                if a.get("for"):
                    self.label_fors.add(a["for"])
            if tag in ("input", "select", "textarea"):
                self.fields.append((a, self.label_depth))

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)

        def handle_endtag(self, tag):
            if tag == "label" and self.label_depth > 0:
                self.label_depth -= 1

    parser = FieldParser()
    parser.feed(html)
    total = 0
    unlabelled = 0
    for a, inside_label in parser.fields:
        ftype = a.get("type", "").lower()
        if ftype == "hidden":
            continue
        if ftype == "file" and inside_label > 0:
            continue
        total += 1
        labelled = (
            inside_label > 0
            or (a.get("id") and a["id"] in parser.label_fors)
            or a.get("aria-label")
            or a.get("aria-labelledby")
        )
        if not labelled:
            unlabelled += 1
    return total, unlabelled


class AccessibilityAndLayoutTest(unittest.TestCase):
    STATIC = ROOT / "static"

    def _js_files(self):
        return sorted(self.STATIC.glob("*.js"))

    def test_no_native_confirm_or_prompt_outside_confirm_dialog(self):
        pattern = re.compile(r"\b(?:window\.)?(?:confirm|prompt)\s*\(")
        for path in self._js_files():
            source = path.read_text(encoding="utf-8")
            for match in pattern.finditer(source):
                line_start = source.rfind("\n", 0, match.start()) + 1
                line_end = source.find("\n", match.start())
                line = source[line_start:line_end if line_end != -1 else None]
                # The only allowed native call is the fallback inside confirmDialog.
                if "return Promise.resolve(window.confirm(" in line:
                    continue
                self.fail(f"native confirm/prompt in {path.name}: {line.strip()}")

    def test_zero_unlabelled_form_fields(self):
        total, unlabelled = _count_unlabelled_fields(INDEX)
        self.assertGreater(total, 0)
        self.assertEqual(unlabelled, 0)

    def test_idle_tooltip_is_hidden_from_assistive_tech(self):
        # An empty role="tooltip" left in the tree has no accessible name.
        css = (self.STATIC / "css" / "components.css").read_text(encoding="utf-8")
        idle = re.search(r"\n\s*#tip\s*\{([^}]*)\}", css).group(1)
        shown = re.search(r"\n\s*#tip\.show\s*\{([^}]*)\}", css).group(1)
        self.assertIn("visibility: hidden", idle)
        self.assertIn("visibility: visible", shown)

    def test_icon_button_names_start_with_their_visible_label(self):
        buttons = re.findall(r'<button[^>]*class="iconbtn"[^>]*aria-label="([^"]+)"[^>]*>.*?'
                             r'<span class="btn-label">([^<]+)</span>', INDEX)
        self.assertGreater(len(buttons), 0)
        for name, label in buttons:
            with self.subTest(label=label):
                self.assertTrue(name.lower().startswith(label.lower()), name)

    def test_dialog_actions_share_one_row(self):
        # A full-width primary wrapped below Batal; both dialogs use inline buttons.
        for button in ("sellConfirm", "confirmOk"):
            with self.subTest(button=button):
                tag = re.search(r'<button id="%s"[^>]*>' % button, INDEX).group(0)
                self.assertIn("btn-inline", tag)

    def _function(self, source, name):
        start = source.index(f"function {name}(")
        nxt = source.find("\nfunction ", start + 1)
        return source[start:nxt if nxt != -1 else None]

    def test_charts_in_hidden_panes_size_themselves(self):
        # Created while their sub-tab is hidden, these charts stayed 0px wide.
        for name in ("finance.js", "market.js", "app.js"):
            source = (self.STATIC / name).read_text(encoding="utf-8")
            calls = [m.start() for m in re.finditer(r"createChart\(el, \{", source)]
            self.assertTrue(calls, name)
            for at in calls:
                with self.subTest(file=name, at=at):
                    self.assertIn("autoSize: true", source[at:at + 400])

    def test_theme_change_redraws_every_chart(self):
        # The theme cards live in Pengaturan, so a currentTab guard never matched.
        body = self._function(APP_JS, "applyTheme")
        self.assertNotIn("currentTab ===", body)
        for call in ("renderCharts(lastChartData)", "financeRender()", "marketReload()", "loadValueChart()"):
            with self.subTest(call=call):
                self.assertIn(call, body)

    def test_boot_does_not_save_default_preferences(self):
        # Before sync has the server copy, a saved default overwrites other devices.
        self.assertIn('applyTheme(localStorage.getItem(THEME_KEY) || "default", false)', APP_JS)
        self.assertIn("!== null", self._function(APP_JS, "applyTheme"))
        self.assertIn("!== null", self._function(APP_JS, "setMode"))
        self.assertIn("applyAuto(true)", APP_JS)
        self.assertIn("if (!fromBoot) saveAuto()", self._function(APP_JS, "applyAuto"))

    def test_watchlist_defaults_are_shown_everywhere(self):
        # Ringkasan said "Belum ada saham" while the rail listed the default stocks.
        home = (self.STATIC / "home.js").read_text(encoding="utf-8")
        self.assertNotIn("saham_watchlist_v1", home)
        self.assertIn("window.getWatchlist", home)
        self.assertIn("window.getWatchlist = ", APP_JS)

    def test_escape_closes_only_the_topmost_layer(self):
        # Escape in the palette or the autocomplete also closed the drawer underneath.
        layout = (self.STATIC / "layout.js").read_text(encoding="utf-8")
        self.assertIn("!e.defaultPrevented", layout)
        # Picking a tab hands focus to the menu button, not to a rail button that turns inert.
        self.assertIn('e.target.closest(".tab, .modebtn")) close(true)', layout)
        auto = (self.STATIC / "autocomplete.js").read_text(encoding="utf-8")
        self.assertIn('e.key === "Escape") { e.preventDefault(); hide(); }', auto)
        self.assertIn('e.key === "Escape") { e.preventDefault(); closePalette(); }', APP_JS)

    def test_login_and_start_pages_tint_the_browser_bar_by_theme(self):
        boot = (self.STATIC / "theme-boot.js").read_text(encoding="utf-8")
        self.assertIn('meta[name="theme-color"]', boot)
        self.assertIn('getPropertyValue("--bg")', boot)

    def test_disclaimer_appears_once(self):
        # The footer carries it on every page; Pengaturan › Tentang states it in full.
        html = INDEX.lower()
        start = html.index('id="setpane-tentang"')
        outside = html[:start] + html[html.index("</section>", start):]
        self.assertEqual(outside.count("bukan rekomendasi"), 1)
        self.assertNotIn("delayed", html)

    def test_entry_forms_are_collapsible(self):
        for button in ("pfAddBtn", "jrAdd", "divAdd", "fundSave", "bondSave", "accAdd", "txAdd",
                       "recAdd", "debtAdd", "bgAddItem", "ipoAdd"):
            position = INDEX.index(f'id="{button}"')
            opened = INDEX.rfind('<details class="entry">', 0, position)
            closed = INDEX.rfind("</details>", 0, position)
            with self.subTest(button=button):
                self.assertGreater(opened, closed, f"{button} is not inside details.entry")

    def test_benchmark_editor_is_folded(self):
        position = INDEX.index('id="benchGrid"')
        self.assertGreater(INDEX.rfind('<details class="entry">', 0, position), INDEX.rfind("</details>", 0, position))

    def test_responsive_rail_hooks_present(self):
        self.assertIn('id="railToggle"', INDEX)
        self.assertIn('id="workspaceRail"', INDEX)
        self.assertIn('id="railScrim"', INDEX)
        self.assertIn("/static/layout.js", INDEX)
        self.assertTrue((self.STATIC / "layout.js").exists())

    def test_no_min_width_1024_on_html_or_body(self):
        pattern = re.compile(r"(?:html|body)\s*\{[^}]*min-width:\s*1024px", re.DOTALL)
        for path in sorted((self.STATIC / "css").glob("*.css")):
            css = path.read_text(encoding="utf-8")
            with self.subTest(name=path.name):
                self.assertIsNone(pattern.search(css), f"min-width:1024px still gates {path.name}")
                self.assertNotIn("memerlukan lebar desktop minimal 1024", css)

    def test_narrow_media_block_turns_rail_into_drawer(self):
        css = (self.STATIC / "css" / "shell.css").read_text(encoding="utf-8")
        match = re.search(r"@media\s*\(max-width:\s*1023px\)\s*\{", css)
        self.assertIsNotNone(match, "missing max-width:1023px media block")
        # Grab the body of that block (balanced to its closing brace).
        start = match.end()
        depth = 1
        i = start
        while i < len(css) and depth:
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        block = css[start:i]
        self.assertIn(".workspace-rail", block)
        self.assertIn("position: fixed", block)
        self.assertIn("body.rail-open .workspace-rail", block)

    def test_bench_and_badge_rules_use_tokens(self):
        css = (self.STATIC / "css" / "components.css").read_text(encoding="utf-8")
        for selector in (".bench.good", ".bench.mid", ".bench.bad", ".b-high", ".b-med", ".b-low"):
            match = re.search(re.escape(selector) + r"[^{]*\{([^}]*)\}", css)
            self.assertIsNotNone(match, f"{selector} rule missing from components.css")
            self.assertRegex(match.group(1), r"var\(--(up|down|warn)\)", f"{selector} does not use a gain/loss/warn token")


if __name__ == "__main__":
    unittest.main()
