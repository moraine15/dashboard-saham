/* home.js - Dashboard ringkasan (net worth, ATH, P/L portofolio, IHSG, top mover watchlist).
   Memakai helper global: $, fmt, fmtRp, setMode, selectStock, showTab, window.finance* */
"use strict";
(function () {
  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch { return def; } };

  // SVG polyline points: x evenly spaced, the lowest value at the bottom.
  function sparkPoints(values, width, height) {
    if (!values || values.length < 2) return "";
    const min = Math.min(...values), max = Math.max(...values);
    const round = (n) => Math.round(n * 10) / 10;
    return values.map((v, i) => {
      const x = round((i / (values.length - 1)) * width);
      const y = max === min ? height / 2 : round(height - ((v - min) / (max - min)) * height);
      return `${x},${y}`;
    }).join(" ");
  }

  // Change from the earliest to the latest recorded net worth.
  function sinceChange(hist) {
    const dates = Object.keys(hist || {}).sort();
    if (dates.length < 2) return null;
    const first = Number(hist[dates[0]]), last = Number(hist[dates[dates.length - 1]]);
    if (!(first > 0)) return null;
    return { pct: Math.round(((last - first) / first) * 1000) / 10, since: dates[0] };
  }
  window.homeMath = { sparkPoints, sinceChange };

  function netWorthLine() {
    const hist = load("mc_fin_hist", {});
    const values = Object.keys(hist).sort().map((d) => Number(hist[d]) || 0);
    const points = sparkPoints(values, 300, 64);
    if (!points) return "";
    const change = sinceChange(hist);
    const since = change
      ? `<div class="hs-sub priv ${change.pct >= 0 ? "up" : "down"}">${change.pct >= 0 ? "+" : ""}${fmt(change.pct, 1)}% sejak ${escHtml(change.since)}</div>`
      : "";
    return `<div class="home-spark"><svg class="spark priv" viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg>${since}</div>`;
  }

  async function getQuote(tk) {
    try { const d = await (await fetch("/api/quote/" + encodeURIComponent(tk))).json(); return d && d.price != null ? d : null; }
    catch { return null; }
  }

  async function render() {
    // the stock portfolio feeds current prices to the investment totals
    let pl = null;
    const pf = load("saham_portfolio_v1", []);
    if (pf.length) {
      try { const d = await (await fetch("/api/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holdings: pf }) })).json(); pl = d.totals; if (window.investmentRefreshStocks) window.investmentRefreshStocks(pl || {}); } catch { /* */ }
    }
    const nw = window.financeNetWorth ? window.financeNetWorth() : 0;
    const cash = window.financeCash ? window.financeCash() : 0;
    // pasar
    let mkt = [], ihsg = null;
    try { const m = await (await fetch("/api/market")).json(); mkt = m.items || []; ihsg = mkt.find((x) => x.symbol === "^JKSE"); } catch { /* */ }

    const athRecord = window.financeAth ? window.financeAth() : null;
    const athAll = athRecord ? athRecord.val : nw;
    const pctAth = athAll ? nw / athAll * 100 : 100;
    const stat = (lbl, val, sub, priv) => `<div class="home-stat"><div class="hs-lbl">${lbl}</div><div class="hs-val${priv ? " priv" : ""}">${val}</div>${sub ? `<div class="hs-sub">${sub}</div>` : ""}</div>`;
    const investment = window.investmentTotals ? window.investmentTotals() : { value: pl ? pl.value : 0, pl: pl ? pl.pl : 0, returnPct: pl ? pl.plPct : null };
    // Nothing to compare with until a record above Rp0 exists (as in Keuangan).
    const athLine = athAll > 0
      ? `<span class="${nw >= athAll - 1 ? "up" : "muted"}">${fmt(pctAth, 0)}% dari ATH <span class="priv">${fmtRp(athAll)}</span></span>`
      : `<span class="muted">Belum ada rekor</span>`;
    const focal = stat("Kekayaan (Net Worth)", fmtRp(nw), athLine, true);
    $("homeStats").innerHTML =
      focal.replace(/<\/div>$/, netWorthLine() + "</div>") +
      stat("Kas / Tabungan", fmtRp(cash), "", true) +
      stat("Investasi", investment.value ? fmtRp(investment.value) : "-", investment.value ? `<span class="${investment.pl >= 0 ? "up" : "down"}">Unrealized <span class="priv">${investment.pl >= 0 ? "+" : ""}${fmtRp(investment.pl)} (${fmt(investment.returnPct, 1)}%)</span></span>` : "belum ada", true) +
      stat("IHSG", ihsg && !ihsg.error ? fmt(ihsg.price, 0) : "-", ihsg && !ihsg.error ? `<span class="${ihsg.changePct >= 0 ? "up" : "down"}">${ihsg.changePct >= 0 ? "▲" : "▼"} ${fmt(Math.abs(ihsg.changePct), 2)}%</span>` : "");

    renderMarket(mkt);
    renderMovers();
  }

  function renderMarket(mkt) {
    $("homeMarket").innerHTML = (mkt || []).map((q) => {
      const up = (q.changePct || 0) >= 0;
      return `<div class="mover"><span>${escHtml(q.name)}</span><span>${q.error ? "-" : fmt(q.price, 2)} <span class="tiny ${up ? "up" : "down"}">${q.error ? "" : (up ? "▲" : "▼") + " " + fmt(Math.abs(q.changePct || 0), 2) + "%"}</span></span></div>`;
    }).join("") || "<div class='error-row'>Data pasar tidak tersedia.</div>";
  }

  async function renderMovers() {
    const wl = window.getWatchlist ? window.getWatchlist() : [];
    if (!wl.length) { $("homeMovers").innerHTML = "<div class='empty-row'>Belum ada saham di watchlist.</div>"; return; }
    $("homeMovers").innerHTML = "<div class='loading'>Memuat…</div>";
    const qs = await Promise.all(wl.map((tk) => getQuote(tk).then((q) => q ? { tk, ...q } : null)));
    const rows = qs.filter(Boolean).sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
    if (!rows.length) { $("homeMovers").innerHTML = "<div class='error-row'>Data pasar tidak tersedia.</div>"; return; }
    $("homeMovers").innerHTML = rows.map((r) => {
      const up = (r.changePct || 0) >= 0;
      return `<div class="mover" data-tk="${escHtml(r.tk)}"><span><b>${escHtml(r.tk.replace(".JK", ""))}</b> <span class="tiny muted">${fmt(r.price, 0)}</span></span>
        <span class="${up ? "up" : "down"}">${up ? "▲" : "▼"} ${fmt(Math.abs(r.changePct || 0), 2)}%</span></div>`;
    }).join("");
    $("homeMovers").querySelectorAll(".mover[data-tk]").forEach((el) => el.onclick = () => {
      window.openStock(el.dataset.tk);
    });
  }

  window.homeRender = render;
})();
