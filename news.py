"""Finance news with rule-based impact and sentiment labels.

Source: Google News RSS (which aggregates established outlets), filtered and
marked by credibility. Impact (Low/Med/High) and sentiment need no AI, so they
always work. The optional AI briefing lives in ai.py.
"""
from __future__ import annotations

import logging
import re
import html
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote
from typing import Any, Dict, List

import requests

logger = logging.getLogger(__name__)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Dashboard/1.0"}

# Outlets with a long finance track record; listed first and marked in the UI.
CREDIBLE = {
    "bisnis.com": "Bisnis Indonesia",
    "bisnis indonesia": "Bisnis Indonesia",
    "kontan.co.id": "Kontan",
    "kontan": "Kontan",
    "cnbc indonesia": "CNBC Indonesia",
    "cnbcindonesia.com": "CNBC Indonesia",
    "bareksa": "Bareksa",
    "bareksa.com": "Bareksa",
    "kompas": "Kompas",
    "kompas.com": "Kompas",
    "investor.id": "Investor Daily",
    "investor daily": "Investor Daily",
    "idx channel": "IDX Channel",
    "idxchannel.com": "IDX Channel",
    "katadata": "Katadata",
    "katadata.co.id": "Katadata",
    "tempo": "Tempo",
    "tempo.co": "Tempo",
    "antara": "Antara",
    "antaranews.com": "Antara",
    "reuters": "Reuters",
    "bloomberg": "Bloomberg",
    "cnn indonesia": "CNN Indonesia",
    "detikfinance": "Detik Finance",
    "the jakarta post": "Jakarta Post",
    "financial times": "Financial Times",
}

# Impact keywords (Indonesian and English)
HIGH_KW = [
    "suku bunga", "bi rate", "the fed", "fomc", "inflasi", "resesi", "krisis",
    "perang", "konflik", "anjlok", "ambruk", "rontok", "gagal bayar",
    "default", "stock split", "right issue", "rights issue", "akuisisi", "merger",
    "dividen", "laba", "rugi", "stimulus", "phk", "bangkrut", "sanksi", "tarif",
    "devaluasi", "melonjak", "terjun bebas", "suspensi", "delisting", "rights",
]
MED_KW = [
    "kredit", "obligasi", "emiten", "ekspor", "impor", "neraca", "surplus",
    "defisit", "ekonomi", "investasi", "ojk", "bursa", "ipo", "buyback",
    "kuartal", "pendapatan", "kinerja", "proyeksi", "target harga", "rekomendasi",
]
POS_KW = [
    "naik", "melonjak", "untung", "tumbuh", "rekor", "surplus", "menguat",
    "positif", "optimis", "akumulasi", "cuan", "melesat", "hijau", "rebound", "rally"
]
NEG_KW = [
    "turun", "anjlok", "rugi", "rontok", "ambruk", "defisit", "melemah",
    "negatif", "pesimis", "koreksi", "krisis", "jeblok", "terjun", "bangkrut",
    "phk", "merah", "tekan", "tertekan"
]


def _clean(text: str) -> str:
    """Remove HTML tags and unescape HTML entities."""
    text = re.sub(r"<[^>]+>", " ", text or "")
    return html.unescape(text).strip()


# Any one of these keywords alone means HIGH impact.
HIGH_CORE = [
    "suku bunga", "bi rate", "the fed", "fomc", "inflasi", "resesi", "krisis",
    "perang", "gagal bayar", "default", "delisting", "suspensi",
]
# Rising interest rates or inflation are negative for stocks; falling ones are positive.
MACRO_TERMS = ["suku bunga", "bi rate", "bunga acuan", "fed rate", "inflasi"]
MACRO_UP = {"naik", "naikkan", "menaikkan", "dinaikkan", "kenaikan", "melonjak", "kerek", "mengerek", "tinggi", "hawkish"}
MACRO_DOWN = {"turun", "turunkan", "menurunkan", "diturunkan", "penurunan", "pangkas", "memangkas", "dipangkas", "melandai", "rendah", "dovish"}
RUPIAH_MOVES = {"anjlok", "melemah", "terjun", "tembus", "ambruk", "jeblok", "menguat", "melonjak"}
NEGATORS = {"tidak", "tak", "bukan", "batal", "belum", "gagal"}
_MACRO_WINDOW = 4


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _positions(words: list[str], phrase: str) -> list[int]:
    """Start indices where ``phrase`` occurs as whole words."""
    target = phrase.split()
    size = len(target)
    return [i for i in range(len(words) - size + 1) if words[i:i + size] == target]


def classify(title: str, summary: str = "") -> dict:
    """Rule-based impact and sentiment (deterministic, no AI).

    Returns: {impact, sentiment, score}
    """
    words = _words(f"{title} {summary}")
    high = sum(1 for k in HIGH_KW if _positions(words, k))
    med = sum(1 for k in MED_KW if _positions(words, k))
    rupiah_move = bool(_positions(words, "rupiah")) and any(w in RUPIAH_MOVES for w in words)

    if high >= 2 or rupiah_move or any(_positions(words, k) for k in HIGH_CORE):
        impact = "HIGH"
    elif high >= 1 or med >= 1:
        impact = "MED"
    else:
        impact = "LOW"

    pos = neg = 0
    used: set[int] = set()
    for term in MACRO_TERMS:
        for i in _positions(words, term):
            lo, hi = max(0, i - _MACRO_WINDOW), min(len(words), i + len(term.split()) + _MACRO_WINDOW)
            for j in range(lo, hi):
                if j in used:
                    continue
                if words[j] in MACRO_UP:
                    neg += 1
                    used.add(j)
                elif words[j] in MACRO_DOWN:
                    pos += 1
                    used.add(j)

    def count(keywords: list[str], positive: bool) -> None:
        nonlocal pos, neg
        for k in keywords:
            for i in _positions(words, k):
                if i in used:
                    continue
                used.add(i)
                negated = any(words[j] in NEGATORS for j in range(max(0, i - 2), i))
                if positive != negated:
                    pos += 1
                else:
                    neg += 1

    count(POS_KW, True)
    count(NEG_KW, False)

    if pos > neg:
        sentiment = "POSITIF"
    elif neg > pos:
        sentiment = "NEGATIF"
    else:
        sentiment = "NETRAL"

    return {
        "impact": impact,
        "sentiment": sentiment,
        "score": {"high": high, "med": med, "pos": pos, "neg": neg}
    }


def _credibility(source: str) -> dict:
    """Check if source is from a credible media outlet."""
    s = (source or "").lower()
    for key, name in CREDIBLE.items():
        if key in s:
            return {"credible": True, "name": name}
    return {"credible": False, "name": source or "Lainnya"}


def _parse_rss(xml_bytes: bytes, limit: int) -> List[Dict[str, Any]]:
    """Parse RSS XML feed into structured news items."""
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        logger.warning(f"Failed to parse RSS XML: {e}")
        return out
    except Exception as e:
        logger.error(f"Error parsing RSS: {e}")
        return out

    for it in root.findall(".//item"):
        title = _clean(it.findtext("title") or "")
        if not title:
            continue

        link = it.findtext("link") or ""
        pub = it.findtext("pubDate") or ""
        desc = _clean(it.findtext("description") or "")

        # Handle multiple namespace variations for <source>
        src_el = it.find("{*}source")
        if src_el is None:
            src_el = it.find("source")
        source = (src_el.text if src_el is not None else None) or it.findtext("source") or ""

        cls = classify(title, desc)
        cred = _credibility(source)
        out.append({
            "title": title,
            "link": link,
            "published": pub,
            "summary": desc[:300] if desc else "",
            "source": cred["name"],
            "credible": cred["credible"],
            "impact": cls["impact"],
            "sentiment": cls["sentiment"],
        })
        if len(out) >= limit:
            break

    return out


_FEED_TIMEOUT = 8


def _google_news(query: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Fetch news from Google News RSS for a given query."""
    try:
        url = f"https://news.google.com/rss/search?q={quote(query)}&hl=id&gl=ID&ceid=ID:id"
        r = requests.get(url, headers=UA, timeout=_FEED_TIMEOUT)
        if r.status_code != 200:
            logger.warning(f"Google News returned status {r.status_code} for query: {query}")
            return []
        return _parse_rss(r.content, limit)
    except requests.Timeout:
        logger.warning(f"Google News request timed out for query: {query}")
        return []
    except requests.RequestException as e:
        logger.error(f"Google News request failed for query '{query}': {e}")
        return []
    except Exception as e:
        logger.error(f"Unexpected error fetching news for query '{query}': {e}")
        return []


def _gather(queries: List[str], per_query: int) -> List[Dict[str, Any]]:
    """Fetch several feeds in parallel and drop repeated headlines, keeping query order."""
    with ThreadPoolExecutor(max_workers=len(queries)) as ex:
        results = list(ex.map(lambda q: _google_news(q, per_query), queries))
    seen, items = set(), []
    for batch in results:
        for it in batch:
            key = it["title"][:60].lower()
            if key in seen:
                continue
            seen.add(key)
            items.append(it)
    return items


def _rank(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Credible outlets first, then by impact: HIGH > MED > LOW."""
    order = {"HIGH": 0, "MED": 1, "LOW": 2}
    return sorted(
        items,
        key=lambda x: (0 if x["credible"] else 1, order.get(x["impact"], 3))
    )


def market_news(limit: int = 25) -> Dict[str, Any]:
    """Macro and finance news that moves the Indonesian market."""
    queries = [
        "IHSG saham",
        "BI rate suku bunga rupiah",
        "ekonomi indonesia bursa",
        "saham bank BBCA BBRI"
    ]
    items = _rank(_gather(queries, 15))[:limit]
    return {
        "query": "Pasar Indonesia",
        "count": len(items),
        "items": items,
        "note": "Media kredibel ditandai ✓. Dampak dan sentimen dinilai otomatis dari judul."
    }


def stock_news(ticker: str, limit: int = 15) -> Dict[str, Any]:
    """News about one stock."""
    root = ticker.replace(".JK", "").upper()
    items = _rank(_gather([f"saham {root}", f"{root} emiten dividen kinerja"], 12))[:limit]
    return {"query": root, "count": len(items), "items": items}
