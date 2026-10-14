"""Optional AI layer.

Providers:
  • anthropic   : the Claude API (cloud; needs ANTHROPIC_API_KEY)
  • ollama      : a local model through Ollama (free, offline; http://localhost:11434/v1)
  • lmstudio    : a local model through LM Studio (http://localhost:1234/v1)
  • local/openai: any OpenAI-compatible server (set STOCK_AI_BASE_URL)

Pick one with STOCK_AI_PROVIDER (default: none, AI off). Without a ready
provider the rule-based summary still works.

Settings (environment variables):
  STOCK_AI_PROVIDER = anthropic | ollama | lmstudio | local
  STOCK_AI_MODEL    = model name ("llama3.1" or "qwen2.5:7b" locally; "haiku", "sonnet" or "opus" for Claude)
  STOCK_AI_BASE_URL = OpenAI-compatible endpoint override (optional)
  STOCK_AI_API_KEY  = key for a local server that needs one (optional; Ollama does not)
  ANTHROPIC_API_KEY = Claude key (anthropic provider only)

Features: analyze() (narrative analysis and questions), news_brief() (news impact summary).
"""
from __future__ import annotations
import os
import json
import logging
import time

import requests

logger = logging.getLogger(__name__)

# (connect, read) seconds. Bounded so a stalled model cannot hold a server thread.
_LOCAL_TIMEOUT = (3, 90)
_ANTHROPIC_TIMEOUT = 60
_PROBE_TTL = 30
_probe_cache: dict[str, tuple[float, bool]] = {}
_FAILED = "Model AI tidak merespons."

try:
    import anthropic
    _SDK = True
except ImportError:
    _SDK = False

_MODEL_ALIAS = {"haiku": "claude-haiku-4-5", "sonnet": "claude-sonnet-4-6", "opus": "claude-opus-4-8"}
_LOCAL_DEFAULTS = {  # base url default per provider lokal
    "ollama": "http://localhost:11434/v1",
    "lmstudio": "http://localhost:1234/v1",
}

_DISCLAIMER = (
    "PENTING: Anda alat edukasi/analisa, BUKAN penasihat keuangan. Jangan pernah menjamin "
    "keuntungan atau memberi 'pasti naik/turun'. Selalu sampaikan ketidakpastian, sebut risiko, "
    "dan ingatkan ini bukan rekomendasi jual/beli. Jawab ringkas, terstruktur, dalam Bahasa Indonesia."
)
_SYSTEM = (
    "Anda asisten analisa saham untuk pasar Indonesia (IDX). Anda menggabungkan analisa teknikal "
    "(MA, MACD, RSI, support/resistance), fundamental (PER, PBV, ROE, NIM, dividend yield, dsb.), "
    "dan sentimen berita untuk memberi gambaran seimbang. Jelaskan alasannya; sebut sisi bullish DAN "
    "bearish. " + _DISCLAIMER
)


# Configuration
# Runtime override from the web switch: None follows the env, "on"/"off" forces it.
_override: str | None = None


def set_mode(on: bool) -> None:
    """Called by the web on/off switch; takes effect without a restart."""
    global _override
    _override = "on" if on else "off"


def provider() -> str:
    # AI is off unless enabled through the env or the web switch.
    env = (os.environ.get("STOCK_AI_PROVIDER") or "none").strip().lower()
    if _override == "off":
        return "none"
    if _override == "on" and _is_off(env):
        return "ollama"  # web switch on → local AI (Ollama) by default
    return env


_OFF = ("none", "off", "mati", "tanpa", "no", "false", "0")


def _is_off(p: str) -> bool:
    return p in _OFF


def _is_local(p: str) -> bool:
    return p in ("ollama", "lmstudio", "local", "openai")


def resolve_model() -> str:
    raw = (os.environ.get("STOCK_AI_MODEL") or "").strip()
    if provider() == "anthropic":
        raw = raw.lower() or "haiku"
        return _MODEL_ALIAS.get(raw, raw)
    return raw or "gemma4:e4b"  # the lightest local default (free through Ollama)


def base_url() -> str:
    p = provider()
    return (os.environ.get("STOCK_AI_BASE_URL")
            or _LOCAL_DEFAULTS.get(p, "http://localhost:11434/v1")).rstrip("/")


# Status and readiness
def _anthropic_ready() -> bool:
    return _SDK and bool(os.environ.get("ANTHROPIC_API_KEY"))


def _local_ready() -> bool:
    """Quick check that the local server is up (GET /models); cached briefly."""
    url = base_url()
    cached = _probe_cache.get(url)
    if cached and time.monotonic() - cached[0] < _PROBE_TTL:
        return cached[1]
    try:
        ready = requests.get(f"{url}/models", timeout=2, headers=_local_headers()).ok
    except requests.RequestException:
        ready = False
    _probe_cache[url] = (time.monotonic(), ready)
    return ready


def is_enabled() -> bool:
    p = provider()
    if _is_off(p):
        return False
    return _anthropic_ready() if p == "anthropic" else _local_ready()


def status() -> dict:
    p = provider()
    enabled = is_enabled()
    if _is_off(p):
        return {"enabled": False, "provider": "none", "sdk_installed": _SDK, "model": None,
                "base_url": None,
                "hint": "AI mati. Analisis dan ringkasan berita memakai ringkasan otomatis. "
                        "Nyalakan lewat Pengaturan › Tampilan › AI."}
    if p == "anthropic":
        hint = None if enabled else "Kunci akses AI belum diatur di server."
    else:
        hint = None if enabled else (
            "Model AI lokal belum berjalan. Jalankan Ollama atau server AI lokal lain, lalu coba lagi.")
    return {
        "enabled": enabled, "provider": p, "sdk_installed": _SDK,
        "model": resolve_model() if enabled else None,
        "base_url": base_url() if _is_local(p) else None,
        "hint": hint,
    }


# Model calls
def _local_headers() -> dict:
    h = {"Content-Type": "application/json"}
    key = os.environ.get("STOCK_AI_API_KEY")
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _call(user_text: str, max_tokens: int = 1400) -> str:
    p = provider()
    if p == "anthropic":
        return _call_anthropic(user_text, max_tokens)
    return _call_openai_compatible(user_text, max_tokens)


def _call_anthropic(user_text: str, max_tokens: int) -> str:
    client = anthropic.Anthropic(timeout=_ANTHROPIC_TIMEOUT, max_retries=1)  # reads ANTHROPIC_API_KEY
    resp = client.messages.create(
        model=resolve_model(),
        max_tokens=max_tokens,
        system=[{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_text}],
    )
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def _call_openai_compatible(user_text: str, max_tokens: int) -> str:
    """For Ollama, LM Studio or another local OpenAI-compatible server."""
    payload = {
        "model": resolve_model(),
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user_text},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "stream": False,
    }
    r = requests.post(f"{base_url()}/chat/completions", headers=_local_headers(),
                      json=payload, timeout=_LOCAL_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    return (data["choices"][0]["message"]["content"] or "").strip()


# Stock analysis
def analyze(context: dict, question: str | None = None) -> dict:
    if not is_enabled():
        return {"enabled": False, "text": _fallback_analyze(context), **status()}
    ctx = json.dumps(context, ensure_ascii=False, indent=2)
    if question:
        task = (f"Pertanyaan pengguna tentang saham {context.get('ticker','?')}:\n\"{question}\"\n\n"
                "Jawab berdasarkan data di bawah. Jika data tak cukup, katakan terus terang.")
    else:
        task = (f"Buat analisa ringkas saham {context.get('ticker','?')} dengan struktur:\n"
                "1) Ringkasan 1 kalimat\n2) Sisi Teknikal (momentum, tren, level kunci)\n"
                "3) Sisi Fundamental (valuasi & kualitas)\n4) Sentimen Berita (jika ada)\n"
                "5) Bull vs Bear (poin singkat)\n6) Hal yang perlu dipantau\n"
                "Akhiri dengan pengingat singkat bahwa ini bukan rekomendasi.")
    try:
        text = _call(f"{task}\n\n=== DATA SAHAM (JSON) ===\n{ctx}", max_tokens=1600)
        return {"enabled": True, "provider": provider(), "model": resolve_model(), "text": text}
    except Exception:  # noqa: BLE001
        logger.exception("AI analyze failed (%s)", provider())
        return {"enabled": True, "provider": provider(), "model": resolve_model(),
                "text": _fallback_analyze(context, failed=True)}


# News briefing
def news_brief(items: list[dict], scope: str = "pasar") -> dict:
    if not is_enabled():
        return {"enabled": False, "text": _fallback_news(items, scope), **status()}
    if not items:
        return {"enabled": True, "provider": provider(), "model": resolve_model(),
                "text": "Tidak ada berita untuk diringkas."}
    compact = [{"judul": i.get("title"), "sumber": i.get("source"),
                "dampak": i.get("impact"), "sentimen": i.get("sentiment")} for i in items[:18]]
    data = json.dumps(compact, ensure_ascii=False, indent=2)
    task = (f"Berikut kumpulan berita finance ({scope}). Buat:\n"
            "1) Briefing 2-3 kalimat: tema utama & implikasi ke pasar/saham terkait.\n"
            "2) 3-5 berita PALING berdampak. Untuk tiap berita: judul singkat, label (LOW/MED/HIGH), "
            "dan SATU kalimat alasannya.\nObjektif & ringkas. Ingatkan singkat ini bukan rekomendasi.")
    try:
        text = _call(f"{task}\n\n=== BERITA (JSON) ===\n{data}", max_tokens=1300)
        return {"enabled": True, "provider": provider(), "model": resolve_model(), "text": text}
    except Exception:  # noqa: BLE001
        logger.exception("AI news brief failed (%s)", provider())
        return {"enabled": True, "provider": provider(), "model": resolve_model(),
                "text": _fallback_news(items, scope, failed=True)}


# Fallback (without AI)
def _val(value) -> str:
    return "-" if value is None or value == "" else str(value)


def _pct(value) -> str:
    return "-" if value is None or value == "" else f"{value}%"


def _is_stock(c: dict) -> bool:
    """Keuangan and Barang send their own figures; only a stock gets the rule-based summary."""
    return c.get("price") is not None or bool(c.get("signals")) or bool(c.get("fundamentals"))


def _fallback_analyze(c: dict, failed: bool = False) -> str:
    """Rule-based text for when the AI is off (the page adds how to turn it on) or did not answer."""
    if not _is_stock(c):
        return f"{_FAILED} Coba lagi nanti." if failed else \
            "Analisis ini butuh AI; ringkasan otomatis hanya tersedia untuk saham."
    f = c.get("fundamentals") or {}
    s = c.get("signals") or {}
    lines = [
        f"{_FAILED} Ringkasan otomatis:" if failed else "Ringkasan otomatis:",
        f"• Harga: {_val(c.get('price'))} | Sinyal teknikal: {_val(s.get('label'))} (skor {_val(s.get('score'))})",
        f"• Valuasi: PER {_val(f.get('per'))} · PBV {_val(f.get('pbv'))} · ROE {_pct(f.get('roe'))}"
        f" · Div Yield {_pct(f.get('dividendYield'))}",
    ]
    comps = s.get("components") or []
    if comps:
        lines.append("• Faktor teknikal: " + "; ".join(c2.get("note", "") for c2 in comps[:4]))
    lines.append("Ini bukan rekomendasi.")
    return "\n".join(lines)


def _fallback_news(items: list[dict], scope: str, failed: bool = False) -> str:
    """Rule-based news summary for when the AI is off or did not answer."""
    if not items:
        return "Tidak ada berita."
    hi = [i for i in items if i.get("impact") == "HIGH"][:5]
    head = f"{_FAILED} Ringkasan otomatis" if failed else "Ringkasan otomatis"
    out = [f"{head} ({scope}): {len(items)} berita, {len(hi)} berdampak tinggi."]
    for i in hi:
        source = f" ({i.get('source')})" if i.get("source") else ""
        out.append(f"• [HIGH/{_val(i.get('sentiment'))}] {_val(i.get('title'))}{source}")
    out.append("Ini bukan rekomendasi.")
    return "\n".join(out)
