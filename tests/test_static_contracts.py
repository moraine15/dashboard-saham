import re
import subprocess
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class IdParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids = []
    def handle_starttag(self, tag, attrs):
        element_id = dict(attrs).get("id")
        if element_id: self.ids.append(element_id)


class StaticContractTest(unittest.TestCase):
    def test_all_javascript_has_valid_syntax(self):
        for path in sorted((ROOT / "static").glob("*.js")):
            with self.subTest(path=path.name):
                result = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True, cwd=ROOT)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_html_ids_are_unique(self):
        parser = IdParser(); parser.feed((ROOT / "templates" / "index.html").read_text(encoding="utf-8"))
        self.assertEqual([key for key, count in Counter(parser.ids).items() if count > 1], [])

    def test_html_loads_modules_in_dependency_order(self):
        source = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        names = ("sync-merge", "sync", "money", "subtabs", "investments-core", "app", "finance", "screener", "journal",
                 "market", "investments", "home", "calc", "ara", "barang", "autocomplete", "ready")
        positions = []
        for name in names:
            marker = f'/static/{name}.js'
            self.assertIn(marker, source)
            positions.append(source.index(marker))
        self.assertEqual(positions, sorted(positions))

    def test_no_references_to_missing_endpoints_or_files(self):
        paths = [ROOT / "app.py", ROOT / "templates" / "index.html"]
        combined = "\n".join(path.read_text(encoding="utf-8") for path in paths)
        for value in ("/api/advanced", "/api/breadth", "journal_v2.js", "theme-builder.js", "manifest.json", "sw.js"):
            self.assertNotIn(value, combined)

    def test_private_html_is_not_embedded_in_login(self):
        login = (ROOT / "templates" / "login.html").read_text(encoding="utf-8")
        self.assertNotRegex(login, re.compile(r"portfolio|watchlist|keuangan", re.I))

    def test_workstation_shell_contract(self):
        html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('class="workspace-shell"', html)
        self.assertIn('class="workspace-rail"', html)
        self.assertIn('class="workspace-content"', html)
        self.assertIn('class="workspace-nav tabs"', html)
        names = ("home", "analisa", "pasar", "porto", "screener", "alat", "berita", "keuangan", "barang")
        for name in names:
            self.assertEqual(html.count(f'data-tab="{name}"'), 1)
        for gone in ("rupiah", "emas", "ara", "kalkulator"):
            self.assertNotIn(f'data-tab="{gone}"', html)
        self.assertIn('document.body.dataset.currentTab = name', app_js)
        self.assertIn('document.body.dataset.workspaceMode = currentMode', app_js)

    def test_keuangan_boxes_live_in_their_sub_tabs(self):
        expected = {
            "Ringkasan Keuangan": "ringkasan", "ATH Kekayaan": "ringkasan", "Pertumbuhan Kekayaan": "ringkasan",
            "Analisis AI Keuangan": "ringkasan", "Pemasukan & Pengeluaran": "transaksi", "Rutin Bulanan": "rutin",
            "Target Tabungan": "target", "Hutang": "target", "Akun / Tabungan": "akun", "Kalkulator Beli Barang": "akun",
        }

        class HeadingParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.stack, self.in_keuangan, self.in_h3, self.found = [], False, False, {}

            def handle_starttag(self, tag, attrs):
                values = dict(attrs)
                if tag in {"input", "img", "br", "meta", "link"}:
                    return
                self.stack.append((tag, values.get("id"), values.get("data-subpanel")))
                if tag == "h3":
                    self.in_h3, self.text = True, ""

            def handle_endtag(self, tag):
                if tag == "h3" and self.in_h3:
                    self.in_h3 = False
                    ids = [i for _, i, _ in self.stack]
                    if "tabKeuangan" in ids:
                        subs = [s for _, _, s in self.stack if s]
                        self.found[self.text.strip()] = subs[-1] if subs else None
                for index in range(len(self.stack) - 1, -1, -1):
                    if self.stack[index][0] == tag:
                        del self.stack[index:]
                        break

            def handle_data(self, data):
                if self.in_h3:
                    self.text += data

        parser = HeadingParser()
        parser.feed((ROOT / "templates" / "index.html").read_text(encoding="utf-8"))
        for heading, sub in expected.items():
            matches = [found for text, found in parser.found.items() if text.startswith(heading)]
            with self.subTest(heading=heading):
                self.assertEqual(matches, [sub])

    def test_every_kept_id_still_exists(self):
        html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        present = set(re.findall(r'\bid="([^"]+)"', html))
        kept = (ROOT / "tests" / "fixtures" / "ui_ids.txt").read_text(encoding="utf-8").split()
        self.assertEqual([i for i in kept if i not in present], [])

    def test_theme_choices_are_keyboard_controls(self):
        app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('<button type="button" class="theme-card', app_js)
        self.assertIn('aria-pressed=', app_js)

    def test_vertical_navigation_supports_vertical_arrow_keys(self):
        app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('list.setAttribute("aria-orientation", "vertical")', app_js)
        self.assertIn('"ArrowDown"', app_js)
        self.assertIn('"ArrowUp"', app_js)

    def test_visible_sources_avoid_long_dash_characters(self):
        paths = list((ROOT / "templates").glob("*.html")) + list((ROOT / "static").glob("*.js"))
        offenders = []
        for path in paths:
            source = path.read_text(encoding="utf-8")
            if "—" in source or "–" in source:
                offenders.append(path.name)
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
