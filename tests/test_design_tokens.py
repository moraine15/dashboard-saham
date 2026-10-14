"""Design tokens: both themes, contrast, type scale and the self-hosted font."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "static" / "css" / "tokens.css"
FONTS = ROOT / "static" / "fonts"

COLOUR_TOKENS = ("--bg", "--ink", "--muted", "--rule", "--rule-soft", "--raise", "--up", "--down", "--warn")
SPEC = {
    "hitam": {"--bg": "#000000", "--ink": "#ffffff", "--muted": "#a3a3a3", "--rule": "#333333", "--rule-soft": "#1c1c1c",
              "--raise": "#0d0d0d", "--up": "#4ade80", "--down": "#ff6b61", "--warn": "#f5c451"},
    "putih": {"--bg": "#ffffff", "--ink": "#000000", "--muted": "#5c5c5c", "--rule": "#d4d4d4", "--rule-soft": "#ececec",
              "--raise": "#f5f5f5", "--up": "#0a7a3d", "--down": "#c4221a", "--warn": "#8a5a00"},
}


def _css():
    return TOKENS.read_text(encoding="utf-8")


def _strip_comments(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def _block(css, selector):
    """Body of the first rule whose selector is exactly ``selector``."""
    match = re.search(re.escape(selector) + r"\s*\{([^{}]*)\}", _strip_comments(css))
    if not match:
        raise AssertionError(f"no rule for {selector}")
    return match.group(1)


def _props(block):
    return dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", block))


def _theme(name):
    css = _css()
    selector = ":root" if name == "hitam" else '[data-theme="light"]'
    props = _props(_block(css, selector))
    return {key: props[key].strip().lower() for key in COLOUR_TOKENS if key in props}


def relative_luminance(hex_colour):
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(a, b):
    la, lb = sorted((relative_luminance(a), relative_luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


class DesignTokenTest(unittest.TestCase):
    def test_layer_order_is_declared_first(self):
        first = _strip_comments(_css()).strip().split(";", 1)[0]
        self.assertEqual(re.sub(r"\s+", " ", first), "@layer tokens, base, layout, components, views, utilities")

    def test_both_themes_define_the_same_tokens(self):
        self.assertEqual(set(_theme("hitam")), set(COLOUR_TOKENS))
        self.assertEqual(set(_theme("putih")), set(COLOUR_TOKENS))

    def test_theme_values_match_the_spec(self):
        self.assertEqual(_theme("hitam"), SPEC["hitam"])
        self.assertEqual(_theme("putih"), SPEC["putih"])

    def test_text_pairs_meet_contrast(self):
        for name in ("hitam", "putih"):
            theme = _theme(name)
            for text in ("--ink", "--muted", "--up", "--down", "--warn"):
                for surface in ("--bg", "--raise"):
                    with self.subTest(theme=name, text=text, surface=surface):
                        self.assertGreaterEqual(contrast(theme[text], theme[surface]), 4.5)

    def test_fonts_are_local_woff2(self):
        css = _css()
        faces = re.findall(r"@font-face\s*\{([^}]*)\}", css)
        self.assertEqual(len(faces), 8)
        for face in faces:
            self.assertIn("font-display: swap", face)
            for url in re.findall(r'url\("?/static/fonts/([^")]+)"?\)', face):
                path = FONTS / url
                self.assertTrue(path.exists(), url)
                self.assertEqual(path.read_bytes()[:4], b"wOF2", url)
        self.assertTrue((FONTS / "license.txt").exists())

    def test_type_scale_follows_ui_scale(self):
        root = _props(_block(_css(), ":root"))
        for step in ("--fs-label", "--fs-body", "--fs-row", "--fs-heading", "--fs-kpi", "--fs-focal"):
            with self.subTest(step=step):
                self.assertIn("var(--ui-scale)", root[step])
        compact = _props(_block(_css(), '[data-density="compact"]'))
        self.assertIn("--space-1", compact)

    def test_type_scale_is_resolved_on_body(self):
        # var() inside a custom property resolves where it is declared, so the
        # steps must be declared on body, where data-font-size sets --ui-scale.
        body = _props(_block(_css(), "body"))
        for step in ("--fs-label", "--fs-body", "--fs-row", "--fs-heading", "--fs-kpi", "--fs-focal"):
            with self.subTest(step=step):
                self.assertIn("var(--ui-scale)", body.get(step, ""))


if __name__ == "__main__":
    unittest.main()
