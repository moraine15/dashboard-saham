"""Release contracts: nothing personal or development-only ships with the app."""
import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "data", "__pycache__", ".superpowers", "node_modules", "tests", ".venv", "venv"}
BINARY = {".png", ".woff2", ".ico", ".jpg", ".jpeg", ".gif", ".webp"}
# Personal names are checked by a scan kept outside the repository, so they never ship here.
FORBIDDEN = ("brand-32.png", "brand-96.png", "logo.png", "jalankan-")
SERVER_MODULES = ("app.py", "ai.py", "news.py", "indicators.py")
SETTING_READ = re.compile(r"""os\.environ\.get\(\s*["']([A-Z][A-Z0-9_]+)["']""")
TEST_ONLY_SETTINGS = {"SAHAM_DISABLE_DOTENV"}


def _read(name):
    return (ROOT / name).read_text(encoding="utf-8")


def _shipped_text_files():
    for folder, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]  # never descend into .git or data
        for name in files:
            path = Path(folder) / name
            if path.suffix.lower() in BINARY:
                continue
            try:
                yield path, path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue


class ReleaseContentTest(unittest.TestCase):
    def test_no_personal_branding_in_shipped_files(self):
        hits = [f"{path.relative_to(ROOT)}: {word}"
                for path, text in _shipped_text_files()
                for word in FORBIDDEN if word in text.lower()]
        self.assertEqual(hits, [])

    def test_development_only_files_are_not_shipped(self):
        for name in ("CLAUDE.md", "DESIGN.md", "docs", ".agents", ".kiro",
                     "static/brand-32.png", "static/brand-96.png"):
            with self.subTest(path=name):
                self.assertFalse((ROOT / name).exists())

    def test_hidden_branding_leftovers_are_gone(self):
        # The header logo, the hidden greeting and the splash logo were never visible.
        for path, text in _shipped_text_files():
            if path.suffix in {".html", ".js", ".css"}:
                for word in ("logo-img", "splash-logo", "brandHi"):
                    with self.subTest(file=path.name, word=word):
                        self.assertNotIn(word, text)

    def test_launchers_are_neutral(self):
        self.assertEqual(sorted(p.name for p in ROOT.glob("jalankan*")), [])
        for name in ("start.bat", "start.sh"):
            with self.subTest(launcher=name):
                text = (ROOT / name).read_text(encoding="utf-8")
                self.assertIn("requirements.txt", text)
                self.assertIn("app.py", text)
                self.assertIn(".venv", text)
                self.assertNotIn("gemma", text.lower())

    def test_windows_launcher_finds_python_and_keeps_errors_on_screen(self):
        text = (ROOT / "start.bat").read_text(encoding="utf-8")
        # python.org installs leave "Add to PATH" unticked, so only the py launcher may exist.
        self.assertIn("py -3", text)
        # A double-clicked window must stay open long enough to read a startup error.
        self.assertRegex(text, r"(?im)^if errorlevel 1 pause")

    def test_mdns_name_comes_from_the_environment(self):
        with patch.dict(os.environ, {"MDNS_NAME": ""}):
            self.assertEqual(dashboard._mdns_name(), "")
        with patch.dict(os.environ, {"MDNS_NAME": "dashboard-rumah"}):
            self.assertEqual(dashboard._mdns_name(), "dashboard-rumah")

    def test_server_log_messages_are_english(self):
        # Operator text (banner and logs) is English; what the browser shows stays Indonesian.
        call = re.compile(r"""logger\.(?:debug|info|warning|error|exception)\(\s*f?["']([^"']*)""")
        words = re.compile(r"\b(rusak|gagal|salinan|disimpan|dihapus|lama|tidak|mendukung|menyimpan|versi"
                           r"|pemilik|berhasil|dimigrasikan|sudah|belum|dari|untuk)\b", re.I)
        hits = [f"{name}: {message}" for name in SERVER_MODULES
                for message in call.findall(_read(name)) if words.search(message)]
        self.assertEqual(hits, [])


class ReleaseFilesTest(unittest.TestCase):
    def test_env_example_lists_every_setting_the_code_reads(self):
        read = set()
        for name in SERVER_MODULES:
            read |= set(SETTING_READ.findall(_read(name)))
        example = _read(".env.example")
        missing = sorted(key for key in read - TEST_ONLY_SETTINGS
                         if not re.search(rf"^#?\s*{key}=", example, re.M))
        self.assertEqual(missing, [])

    def test_env_example_holds_no_secret_values(self):
        for line in _read(".env.example").splitlines():
            match = re.match(r"^#?\s*([A-Z][A-Z0-9_]*)=(.*)$", line)
            if match and re.search(r"PASSWORD|SECRET|KEY", match.group(1)):
                with self.subTest(setting=match.group(1)):
                    self.assertEqual(match.group(2).strip(), "")

    def test_env_example_says_how_it_is_loaded(self):
        text = _read(".env.example")
        self.assertNotIn("does not load", text)
        self.assertIn("real environment variables win", text)

    def test_gitignore_keeps_secrets_data_and_tool_folders_out(self):
        rules = {line.strip() for line in _read(".gitignore").splitlines()}
        for rule in (".env", ".env.*", "!.env.example", "data/", "*.corrupt-*", "*.bak", "*.log",
                     "__pycache__/", "*.py[cod]", ".venv/", "venv/", "node_modules/",
                     ".superpowers/", ".claude/", ".kiro/", ".agents/"):
            with self.subTest(rule=rule):
                self.assertIn(rule, rules)

    def test_gitattributes_keeps_line_endings_stable(self):
        rules = {" ".join(line.split()) for line in _read(".gitattributes").splitlines()}
        for rule in ("* text=auto eol=lf", "*.bat text eol=crlf", "*.sh text eol=lf",
                     "*.png binary", "*.woff2 binary"):
            with self.subTest(rule=rule):
                self.assertIn(rule, rules)

    def test_requirements_are_bounded(self):
        lines = [line.split("#")[0].strip() for line in _read("requirements.txt").splitlines()]
        requirements = [line for line in lines if line]
        names = {re.split(r"[<>=!~ ]", line, maxsplit=1)[0].lower() for line in requirements}
        self.assertEqual(names, {"flask", "waitress", "yfinance", "pandas", "numpy", "requests"})
        for line in requirements:
            with self.subTest(requirement=line):
                self.assertRegex(line, r">=[\d.]+,<\d+$")

    def test_license_is_mit_from_moraine(self):
        text = _read("LICENSE")
        self.assertTrue(text.startswith("MIT License"))
        self.assertIn("Copyright (c) 2026 Moraine", text)

    def test_third_party_notices_cover_shipped_and_loaded_code(self):
        text = _read("THIRD_PARTY_NOTICES.md")
        for needle in ("IBM Plex Sans", "SIL Open Font License", "static/fonts/license.txt",
                       "TradingView Lightweight Charts", "Copyright (c) 2023 TradingView, Inc.",
                       "https://www.tradingview.com/", "Apache License 2.0", "yfinance"):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)


if __name__ == "__main__":
    unittest.main()
