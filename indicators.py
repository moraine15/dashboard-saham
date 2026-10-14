"""Technical indicators and the multi-perspective signal score.

Everything is computed with pandas and numpy.
"""
from __future__ import annotations

import logging
from typing import Optional, Tuple, Union

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


Numeric = Union[float, int, None]


# Indikator dasar
def sma(series: pd.Series, period: int) -> pd.Series:
    """Simple Moving Average."""
    if period <= 0:
        raise ValueError(f"Period must be positive, got {period}")
    return series.rolling(window=period, min_periods=period).mean()


def ema(series: pd.Series, period: int, min_periods: int = 0) -> pd.Series:
    """Exponential Moving Average; values before ``min_periods`` observations are NaN."""
    if period <= 0:
        raise ValueError(f"Period must be positive, got {period}")
    return series.ewm(span=period, adjust=False, min_periods=min_periods).mean()


def _wilder(values: pd.Series, period: int) -> pd.Series:
    """Wilder smoothing seeded with the simple average of the first ``period`` values."""
    data = values.to_numpy(dtype=float)
    out = np.full(len(data), np.nan)
    valid = np.flatnonzero(~np.isnan(data))
    if len(valid) < period:
        return pd.Series(out, index=values.index)
    start = valid[0]
    seed_end = start + period - 1
    out[seed_end] = np.mean(data[start:seed_end + 1])
    for i in range(seed_end + 1, len(data)):
        current = data[i] if not np.isnan(data[i]) else 0.0
        out[i] = (out[i - 1] * (period - 1) + current) / period
    return pd.Series(out, index=values.index)


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """
    RSI with Wilder smoothing, 0-100.

    The first ``period`` bars have no value. A run with no losses reads 100,
    a run with no movement at all reads 50.
    """
    if period <= 0:
        raise ValueError(f"Period must be positive, got {period}")
    delta = series.astype(float).diff()
    avg_gain = _wilder(delta.clip(lower=0.0), period)
    avg_loss = _wilder(-delta.clip(upper=0.0), period)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 100 - (100 / (1 + avg_gain / avg_loss))
    out = out.where(avg_loss != 0, np.where(avg_gain > 0, 100.0, 50.0))
    return out.where(avg_gain.notna())


def macd(
    series: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """
    MACD (Moving Average Convergence Divergence).
    Returns: (macd_line, signal_line, histogram)
    """
    if fast >= slow:
        raise ValueError(f"Fast period ({fast}) must be less than slow period ({slow})")
    if signal <= 0:
        raise ValueError(f"Signal period must be positive, got {signal}")

    macd_line = ema(series, fast, min_periods=fast) - ema(series, slow, min_periods=slow)
    signal_line = ema(macd_line, signal, min_periods=signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def bollinger(
    series: pd.Series,
    period: int = 20,
    mult: float = 2.0
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """
    Bollinger Bands.
    Returns: (upper_band, middle_band, lower_band)
    """
    if period <= 0:
        raise ValueError(f"Period must be positive, got {period}")
    if mult <= 0:
        raise ValueError(f"Multiplier must be positive, got {mult}")

    mid = sma(series, period)
    std = series.rolling(window=period, min_periods=period).std(ddof=0)
    upper = mid + mult * std
    lower = mid - mult * std
    return upper, mid, lower


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """
    Average True Range (volatility), used to size stop-loss distance.
    Requires High, Low, Close columns.
    """
    if period <= 0:
        raise ValueError(f"Period must be positive, got {period}")

    required_cols = {"High", "Low", "Close"}
    if not required_cols.issubset(df.columns):
        raise ValueError(f"DataFrame must contain columns: {required_cols}")

    high = df["High"]
    low = df["Low"]
    close = df["Close"]
    prev_close = close.shift(1)

    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)

    return _wilder(tr, period)


# Price levels
def pivot_points(df: pd.DataFrame) -> dict:
    """Classic pivot points from the last bar of ``df`` (pass completed daily sessions)."""
    if len(df) < 1:
        return {"pivot": None, "r1": None, "s1": None, "r2": None, "s2": None, "r3": None, "s3": None}

    last = df.iloc[-1]
    h = _safe_float(last.get("High"))
    l = _safe_float(last.get("Low"))
    c = _safe_float(last.get("Close"))

    if h is None or l is None or c is None:
        return {"pivot": None, "r1": None, "s1": None, "r2": None, "s2": None, "r3": None, "s3": None}

    p = (h + l + c) / 3
    return {
        "pivot": p,
        "r1": 2 * p - l,
        "s1": 2 * p - h,
        "r2": p + (h - l),
        "s2": p - (h - l),
        "r3": h + 2 * (p - l),
        "s3": l - 2 * (h - p),
    }


def support_resistance(df: pd.DataFrame) -> dict:
    """Support and resistance from highs and lows over several lookbacks."""
    if len(df) < 1:
        return {}

    res = {}
    for win, label in [(20, "20h"), (60, "60h"), (120, "120h")]:
        if len(df) >= win:
            res[f"high_{label}"] = _safe_float(df["High"].tail(win).max())
            res[f"low_{label}"] = _safe_float(df["Low"].tail(win).min())
    return res


def _safe_float(value: Numeric, default: Optional[float] = None) -> Optional[float]:
    """Safely convert to float, returning default for invalid values."""
    if value is None:
        return default
    try:
        f = float(value)
        if np.isnan(f) or np.isinf(f):
            return default
        return f
    except (TypeError, ValueError):
        return default


# Sinyal
def _label_from_score(score: float) -> str:
    """Convert numeric score to signal label."""
    if score >= 60:
        return "STRONG BUY"
    if score >= 20:
        return "BUY"
    if score > -20:
        return "NEUTRAL / HOLD"
    if score > -60:
        return "SELL"
    return "STRONG SELL"


def compute_signals(df: pd.DataFrame) -> dict:
    """
    Agregasi sinyal teknikal multi-indikator menjadi skor -100..+100.
    Each indicator contributes -1 to +1, final score is average * 100.
    """
    if len(df) < 5:
        return {
            "score": 0.0,
            "label": "NEUTRAL / HOLD",
            "components": [],
            "error": "Insufficient data for signal computation"
        }

    close = df["Close"]
    ma5 = sma(close, 5)
    ma20 = sma(close, 20)
    ma50 = sma(close, 50)
    ma200 = sma(close, 200) if len(df) >= 200 else pd.Series(np.nan, index=close.index)

    macd_line, signal_line, hist = macd(close)
    rsi14 = rsi(close)
    bb_u, bb_m, bb_l = bollinger(close)

    price = _safe_float(close.iloc[-1])
    if price is None:
        return {"score": 0.0, "label": "NEUTRAL / HOLD", "components": []}

    components = []

    def add(name: str, val: float, note: str) -> None:
        components.append({"name": name, "score": val, "note": note})

    # 1. Tren vs MA50
    ma50_val = _safe_float(ma50.iloc[-1])
    if ma50_val is not None:
        if price > ma50_val:
            add("Harga vs MA50", 1, "Harga di ATAS MA50 → tren naik")
        else:
            add("Harga vs MA50", -1, "Harga di BAWAH MA50 → tren turun")

    # 2. MA20 vs MA50 (golden/death cross)
    ma20_val = _safe_float(ma20.iloc[-1])
    if ma20_val is not None and ma50_val is not None:
        if ma20_val > ma50_val:
            add("MA20 vs MA50", 1, "MA20 > MA50 → momentum menengah bullish")
        else:
            add("MA20 vs MA50", -1, "MA20 < MA50 → momentum menengah bearish")

    # 3. MACD
    hist_val = _safe_float(hist.iloc[-1]) if len(hist) > 0 else None
    if hist_val is not None:
        prev_hist = _safe_float(hist.iloc[-2]) if len(hist) > 1 else None
        rising = prev_hist is not None and hist_val > prev_hist
        if hist_val > 0:
            add("MACD", 1 if rising else 0.5,
                "MACD > sinyal" + (" & menguat" if rising else ""))
        else:
            add("MACD", -1 if not rising else -0.5,
                "MACD < sinyal" + ("" if rising else " & melemah"))

    # 4. RSI
    rsi_val = _safe_float(rsi14.iloc[-1])
    if rsi_val is not None:
        if rsi_val < 30:
            add("RSI", 1, f"RSI {rsi_val:.0f} → jenuh jual (potensi rebound)")
        elif rsi_val > 70:
            add("RSI", -1, f"RSI {rsi_val:.0f} → jenuh beli (potensi koreksi)")
        elif rsi_val >= 50:
            add("RSI", 0.4, f"RSI {rsi_val:.0f} → momentum positif")
        else:
            add("RSI", -0.4, f"RSI {rsi_val:.0f} → momentum lemah")

    # 5. Posisi Bollinger
    bb_l_val = _safe_float(bb_l.iloc[-1])
    bb_u_val = _safe_float(bb_u.iloc[-1])
    if bb_l_val is not None and bb_u_val is not None:
        if price <= bb_l_val:
            add("Bollinger", 1, "Harga di band bawah → murah/jenuh jual")
        elif price >= bb_u_val:
            add("Bollinger", -1, "Harga di band atas → mahal/jenuh beli")
        else:
            add("Bollinger", 0, "Harga di tengah band")

    # 6. MA200 (tren jangka panjang)
    ma200_val = _safe_float(ma200.iloc[-1])
    if ma200_val is not None:
        if price > ma200_val:
            add("Harga vs MA200", 1, "Di atas MA200 → bull jangka panjang")
        else:
            add("Harga vs MA200", -1, "Di bawah MA200 → bear jangka panjang")

    # Calculate aggregate score
    if components:
        raw = np.mean([c["score"] for c in components])
    else:
        raw = 0
    score = round(float(raw) * 100, 1)

    return {
        "score": score,
        "label": _label_from_score(score),
        "components": components,
    }


def latest_values(df: pd.DataFrame) -> dict:
    """Calculate and return latest technical indicator values."""
    if len(df) < 1:
        return {}

    close = df["Close"]
    macd_line, signal_line, hist = macd(close)
    bb_u, bb_m, bb_l = bollinger(close)
    atr14 = atr(df)

    result = {
        "price": _safe_float(close.iloc[-1]),
        "ma5": _safe_float(sma(close, 5).iloc[-1]),
        "ma20": _safe_float(sma(close, 20).iloc[-1]),
        "ma50": _safe_float(sma(close, 50).iloc[-1]),
        "ma200": _safe_float(sma(close, 200).iloc[-1]) if len(df) >= 200 else None,
        "rsi14": _safe_float(rsi(close).iloc[-1]),
        "macd": _safe_float(macd_line.iloc[-1]),
        "macd_signal": _safe_float(signal_line.iloc[-1]),
        "macd_hist": _safe_float(hist.iloc[-1]),
        "bb_upper": _safe_float(bb_u.iloc[-1]),
        "bb_mid": _safe_float(bb_m.iloc[-1]),
        "bb_lower": _safe_float(bb_l.iloc[-1]),
        "atr14": _safe_float(atr14.iloc[-1]),
    }

    return result


def series_for_chart(df: pd.DataFrame, intraday: bool = False) -> dict:
    """Series for the charts (lightweight-charts).

    intraday=True gives times as Unix epoch seconds, so intraday bars stay unique
    and ordered; otherwise times are 'YYYY-MM-DD' strings (daily, weekly, monthly).
    """
    def tfn(idx) -> Union[int, str]:
        if not intraday:
            return idx.strftime("%Y-%m-%d")
        # The chart library shows epoch seconds as UTC; shift by the exchange
        # offset so bars read in Jakarta time (09:00 open, not 02:00).
        offset = idx.utcoffset()
        return int(idx.timestamp()) + (int(offset.total_seconds()) if offset else 0)

    # lightweight-charts needs strictly increasing times; yfinance bars sometimes
    # repeat an index (DST, pre/post market, or the same date in daily data).
    # Drop duplicates (keeping the last bar) and sort before computing indicators.
    if df.index.has_duplicates:
        df = df[~df.index.duplicated(keep="last")]
    if not df.index.is_monotonic_increasing:
        df = df.sort_index()

    close = df["Close"]
    macd_line, signal_line, hist = macd(close)
    bb_u, bb_m, bb_l = bollinger(close)
    rsi14 = rsi(close)
    ma20 = sma(close, 20)
    ma50 = sma(close, 50)

    out = {
        "candles": [],
        "ma20": [],
        "ma50": [],
        "bb_u": [],
        "bb_l": [],
        "rsi": [],
        "macd": [],
        "macd_signal": [],
        "macd_hist": [],
        "volume": []
    }

    for idx, row in df.iterrows():
        t = tfn(idx)
        o, h, l, c = (_safe_float(row.get(k)) for k in ("Open", "High", "Low", "Close"))
        if None in (o, h, l, c):
            continue  # the chart cannot draw a candle with a missing price
        out["candles"].append({"time": t, "open": o, "high": h, "low": l, "close": c})

        volume = _safe_float(row.get("Volume", 0))
        close_price = _safe_float(row.get("Close"))
        open_price = _safe_float(row.get("Open"))
        color = "#26a69a55" if (close_price is not None and open_price is not None and close_price >= open_price) else "#ef535055"
        out["volume"].append({"time": t, "value": volume, "color": color})

    for name, series in [
        ("ma20", ma20),
        ("ma50", ma50),
        ("bb_u", bb_u),
        ("bb_l", bb_l),
        ("rsi", rsi14),
        ("macd", macd_line),
        ("macd_signal", signal_line)
    ]:
        for idx, v in series.items():
            if not np.isnan(v) if isinstance(v, float) else False:
                out[name].append({"time": tfn(idx), "value": _round4(v)})

    for idx, v in hist.items():
        if not np.isnan(v) if isinstance(v, float) else False:
            out["macd_hist"].append({
                "time": tfn(idx),
                "value": _round4(v),
                "color": "#26a69a" if v >= 0 else "#ef5350"
            })

    return out


def _round4(x: Numeric) -> Optional[float]:
    """Round to 4 decimal places, handling NaN/None."""
    if x is None:
        return None
    try:
        f = float(x)
        if np.isnan(f):
            return None
        return round(f, 4)
    except (TypeError, ValueError):
        return None
