"""Login and start pages share the design tokens; static files are cacheable and light."""
import hashlib
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates"
STATIC = ROOT / "static"


def _head(name):
    html = (TEMPLATES / name).read_text(encoding="utf-8")
    return html[: html.index("</head>")]


class PageTest(unittest.TestCase):
    def test_login_and_fresh_start_use_shared_tokens(self):
        for name, own in (("login.html", "login.css"), ("fresh-start.html", "fresh-start.css")):
            head = _head(name)
            with self.subTest(page=name):
                self.assertIn("/static/css/tokens.css", head)
                self.assertIn("/static/css/base.css", head)
                self.assertIn(f"/static/css/{own}", head)
        self.assertFalse((STATIC / "login.css").exists())
        self.assertFalse((STATIC / "fresh-start.css").exists())

    def test_theme_is_applied_before_first_paint(self):
        for name in ("login.html", "fresh-start.html", "index.html"):
            head = _head(name)
            with self.subTest(page=name):
                prefs = re.search(r'<script src="/static/ui-prefs\.js[^"]*"></script>', head)
                boot = re.search(r'<script src="/static/theme-boot\.js[^"]*"></script>', head)
                self.assertIsNotNone(prefs)
                self.assertIsNotNone(boot)
                self.assertLess(prefs.start(), boot.start())

    def test_icon_assets_are_small_and_neutral(self):
        for name in ("icon-32.png", "icon-192.png"):
            path = STATIC / name
            with self.subTest(file=name):
                self.assertTrue(path.exists())
                self.assertLess(path.stat().st_size, 20_000)
                self.assertEqual(path.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        svg = (STATIC / "icon.svg").read_text(encoding="utf-8")
        self.assertIn("<svg", svg)
        self.assertIn("prefers-color-scheme", svg)
        for name in ("index.html", "login.html", "fresh-start.html"):
            head = _head(name)
            with self.subTest(page=name):
                self.assertIn('href="/static/icon.svg"', head)
                self.assertIn('href="/static/icon-32.png"', head)

    def test_hidden_login_forms_stay_hidden(self):
        # An id rule that sets display beats [hidden], so both forms would show.
        css = (STATIC / "css" / "login.css").read_text(encoding="utf-8")
        for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
            if "display" not in body:
                continue
            for selector in selectors.split(","):
                if "#loginForm" in selector or "#setupForm" in selector:
                    with self.subTest(selector=selector.strip()):
                        self.assertIn(":not([hidden])", selector)

    def test_login_form_never_puts_the_password_in_the_url(self):
        # Without method="post" a submit before login.js runs sends ?password= in a GET.
        html = (TEMPLATES / "login.html").read_text(encoding="utf-8")
        for form in re.findall(r"<form[^>]*>", html):
            with self.subTest(form=form):
                self.assertIn('method="post"', form)

    def test_external_scripts_carry_integrity(self):
        for path in TEMPLATES.glob("*.html"):
            for tag in re.findall(r'<script[^>]*src="https?://[^"]+"[^>]*>', path.read_text(encoding="utf-8")):
                with self.subTest(page=path.name, tag=tag[:80]):
                    self.assertRegex(tag, r'integrity="sha384-[A-Za-z0-9+/=]{64}"')
                    self.assertIn('crossorigin="anonymous"', tag)

    def test_dashboard_starts_with_a_skip_link(self):
        html = (TEMPLATES / "index.html").read_text(encoding="utf-8")
        body = html[html.index("<body>") + len("<body>"):].lstrip()
        self.assertTrue(body.startswith('<a class="skip-link" href="#main">'), body[:80])
        self.assertIn('id="main"', html)

    def test_templates_version_local_assets_from_content(self):
        # A hand-written ?v= is easy to forget, and static files are cached for a week.
        for path in TEMPLATES.glob("*.html"):
            refs = re.findall(r'/static/([\w./-]+\.(?:js|css))(\?v=[^"]*)?"', path.read_text(encoding="utf-8"))
            with self.subTest(page=path.name):
                self.assertGreater(len(refs), 0)
                for name, query in refs:
                    self.assertEqual(query, "?v={{ asset_v('%s') }}" % name, name)

    def test_asset_version_changes_with_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "x.js"
            target.write_text("a", encoding="utf-8")
            with patch.object(dashboard, "_STATIC_DIR", tmp):
                first = dashboard._asset_version("x.js")
                target.write_text("b", encoding="utf-8")
                os.utime(target, (1, 1))
                second = dashboard._asset_version("x.js")
                missing = dashboard._asset_version("nope.js")
        self.assertNotEqual(first, second)
        self.assertEqual(missing, "0")


class CachingTest(unittest.TestCase):
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
        dashboard._set_owner_password("pemilik-rahasia")
        dashboard.app.config.update(TESTING=True)
        self.client = dashboard.app.test_client()
        self.client.post("/api/auth/login", json={"password": "pemilik-rahasia"})

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def test_static_assets_are_cacheable(self):
        # Pages link static files with a content-hash ?v=, and those are cached for a week.
        response = self.client.get("/static/css/tokens.css?v=abc123")
        self.assertIn("max-age=604800", response.headers.get("Cache-Control", ""))
        response.close()

    def test_rendered_page_carries_content_hash(self):
        html = self.client.get("/").get_data(as_text=True)
        digest = hashlib.sha256((STATIC / "app.js").read_bytes()).hexdigest()[:10]
        self.assertIn(f"/static/app.js?v={digest}", html)

    def test_pages_and_api_are_not_cached(self):
        self.assertIn("no-store", self.client.get("/").headers.get("Cache-Control", ""))
        self.assertIn("no-store", self.client.get("/api/state").headers.get("Cache-Control", ""))


if __name__ == "__main__":
    unittest.main()
