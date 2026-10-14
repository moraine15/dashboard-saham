/* app.js - dashboard core: helpers, watchlist, analysis, charts, portfolio, settings */
"use strict";

const LS_KEY = "saham_watchlist_v1";
const DEFAULT_WL = ["BBCA.JK", "BBRI.JK", "BMRI.JK", "TLKM.JK", "ASII.JK"];
let watchlist = loadWL();
let current = null;       // active ticker
let lastData = null;      // last payload
let charts = {};          // instance lightweight-charts

/* Util */
const $ = (id) => document.getElementById(id);
function escHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
window.escHtml = escHtml;
/* A missing list shows the defaults without saving them (see applyTheme); a list
   the owner emptied stays empty. */
function loadWL() {
  const raw = localStorage.getItem(LS_KEY);
  if (raw === null) return [...DEFAULT_WL];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [...DEFAULT_WL]; }
  catch { return [...DEFAULT_WL]; }
}
function saveWL() { localStorage.setItem(LS_KEY, JSON.stringify(watchlist)); }
window.getWatchlist = () => watchlist.slice();
function normTicker(t) {
  t = (t || "").trim().toUpperCase();
  if (t && !t.includes(".") && /^[A-Z]{1,5}$/.test(t)) t += ".JK";
  return t;
}
function fmt(n, dec = 0) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  return Number(n).toLocaleString("id-ID", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtRp(n, dec = 0) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  const text = fmt(Math.abs(n), dec);
  // Sign first ("-Rp405.878"): "Rp-405.878" could wrap after the minus.
  return (n < 0 && /[1-9]/.test(text) ? "-" : "") + "Rp" + text;
}
function fmtPct(n, dec = 2) { return n === null || n === undefined || isNaN(n) ? "-" : fmt(n, dec) + "%"; }
function fmtBig(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e12) return "Rp" + (n / 1e12).toFixed(2) + " T";
  if (a >= 1e9) return "Rp" + (n / 1e9).toFixed(2) + " M";
  if (a >= 1e6) return "Rp" + (n / 1e6).toFixed(2) + " jt";
  return fmtRp(n);
}
// The visual toast toggles display:none, so screen readers skip it;
// #toastLive is an always-present screen-reader live region for announcements.
function announce(msg) {
  const live = $("toastLive"); if (!live) return;
  live.textContent = "";
  setTimeout(() => { live.textContent = msg; }, 30);
}
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  announce(msg);
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add("hidden"), 2500);
}
function toastUndo(msg, undoFn) {
  const t = $("toast"); t.classList.remove("hidden");
  announce(msg + " Tombol Urungkan tersedia selama 6 detik.");
  t.innerHTML = "<span class='toast-msg'></span><button class='toast-undo' type='button'>Urungkan</button>";
  t.querySelector(".toast-msg").textContent = msg + " ";
  const close = () => { t.classList.add("hidden"); t.textContent = ""; };
  clearTimeout(t._t);
  t.querySelector(".toast-undo").onclick = () => { clearTimeout(t._t); close(); try { undoFn(); } catch { /* */ } };
  t._t = setTimeout(close, 6000);
}
window.toastUndo = toastUndo;

/* Watchlist */
function renderWL() {
  const ul = $("watchlist"); ul.innerHTML = "";
  watchlist.forEach((tk) => {
    const li = document.createElement("li");
    li.dataset.tk = tk;
    if (tk === current) li.classList.add("active");
    li.innerHTML = `<span class="drag-handle" title="Geser untuk urutkan" aria-hidden="true">☰</span>
      <button type="button" class="wt" aria-label="Buka analisis ${escHtml(tk.replace(".JK", ""))}">${escHtml(tk.replace(".JK", ""))}</button>
      <span class="wp muted" data-q="${escHtml(tk)}">…</span>
      <button type="button" class="x" title="Hapus dari watchlist" aria-label="Hapus ${escHtml(tk.replace(".JK", ""))} dari watchlist">✕</button>`;
    if (tk === current) li.querySelector(".wt").setAttribute("aria-current", "true");
    li.querySelector(".wt").onclick = () => openStock(tk);
    li.querySelector(".wp").onclick = () => openStock(tk);
    li.querySelector(".x").onclick = (e) => { e.stopPropagation(); removeStock(tk); };
    ul.appendChild(li);
    fetchQuote(tk);
  });
  makeSortable(ul, "li", (els) => { watchlist = els.map((e) => e.dataset.tk).filter(Boolean); saveWL(); }, ".drag-handle");
}
async function fetchQuote(tk) {
  try {
    const r = await fetch(`/api/quote/${encodeURIComponent(tk)}`);
    const d = await r.json();
    const el = [...document.querySelectorAll("[data-q]")].find((node) => node.dataset.q === tk);
    if (!el) return;
    if (d.error || d.price == null) { el.textContent = "n/a"; return; }
    const up = d.changePct >= 0;
    el.innerHTML = `${fmt(d.price)}<br><span class="${up ? "up" : "down"}">${up ? "▲" : "▼"} ${fmtPct(Math.abs(d.changePct))}</span>`;
  } catch { /* ignore */ }
}
function addStock(tk) {
  tk = normTicker(tk);
  if (!tk) return;
  if (!watchlist.includes(tk)) { watchlist.push(tk); saveWL(); renderWL(); }
  openStock(tk);
}
function removeStock(tk) {
  const index = watchlist.indexOf(tk);
  watchlist = watchlist.filter((x) => x !== tk); saveWL();
  renderWL();
  if (current === tk) {
    const next = watchlist[Math.min(index, watchlist.length - 1)];
    if (next) selectStock(next);
    else { current = null; lastData = null; syncStockEmpty(); }
  }
  toastUndo(`${tk.replace(".JK", "")} dihapus dari watchlist.`, () => {
    if (!watchlist.includes(tk)) watchlist.splice(Math.min(index, watchlist.length), 0, tk);
    saveWL(); renderWL();
    if (!current) selectStock(tk);
  });
}
// Open a stock in the Analisis view from anywhere (watchlist, search, palette).
function openStock(tk) {
  if (currentMode !== "saham") setMode("saham");
  selectStock(tk);
  showTab("analisa");
}
window.openStock = openStock;
// The Analisis view needs a selected stock; other views never depend on it.
function syncStockEmpty() {
  const none = !current && currentTab === "analisa";
  $("emptyState").classList.toggle("hidden", !none);
  $("detail").classList.remove("hidden");
  if (currentTab === "analisa") $("tabAnalisa").classList.toggle("hidden", none);
  const quote = document.querySelector(".quote");
  if (quote) quote.classList.toggle("hidden", none);
}
function markActiveWL() {
  document.querySelectorAll("#watchlist li").forEach((li) => {
    const on = li.dataset.tk === current;
    li.classList.toggle("active", on);
    const btn = li.querySelector(".wt");
    if (on) btn.setAttribute("aria-current", "true"); else btn.removeAttribute("aria-current");
  });
}

// Wire the "Coba lagi" button inside an error row to the loader that failed.
function wireRetry(root, retry) {
  const button = root && root.querySelector("[data-retry]");
  if (button) button.onclick = retry;
}
window.wireRetry = wireRetry;

/* Load detail */
let stockRequest = 0;
async function selectStock(tk) {
  const ticket = ++stockRequest;
  current = tk; markActiveWL(); syncStockEmpty();
  $("qName").textContent = "Memuat…"; $("qPrice").textContent = "…";
  try {
    const tf = ($("rangeSel").value || "1y|1d").split("|");
    const rng = tf[0], interval = tf[1] || "1d";
    const r = await fetch(`/api/stock/${encodeURIComponent(tk)}?range=${rng}&interval=${interval}`);
    const d = await r.json();
    if (ticket !== stockRequest) return;   // a newer selection is already loading
    if (d.error) { toast(d.error); $("qName").textContent = d.error; return; }
    lastData = d;
    renderDetail(d);
  } catch {
    if (ticket !== stockRequest) return;
    $("qName").textContent = tk.replace(".JK", "");
    $("qMeta").innerHTML = `<span class='error-row'>Data saham gagal dimuat. <button type='button' class='btn-secondary' data-retry>Coba lagi</button></span>`;
    wireRetry($("qMeta"), () => selectStock(tk));
  }
}

function renderDetail(d) {
  const f = d.fundamentals;
  $("qName").textContent = f.longName;
  $("qTicker").textContent = d.ticker;
  $("qPrice").textContent = fmt(d.price);
  const chg = $("qChange");
  if (d.changePct == null) {  // the server had no daily bars for today's figures
    chg.textContent = "-";
    chg.className = "chg";
  } else {
    const up = d.changePct >= 0;
    chg.textContent = `${up ? "▲" : "▼"} ${fmt(Math.abs(d.change))} (${fmtPct(Math.abs(d.changePct))})`;
    chg.className = "chg " + (up ? "up" : "down");
  }
  $("qMeta").textContent = `Per ${d.asOf} · diambil ${d.fetchedAt} · ${d.delayedNote}`;

  renderSignals(d.signals);
  renderTech(d);
  renderFund(d);
  renderBenchGrid(d.ticker);
  loadFinancials(d.ticker);
  prefillCalculators(d);
  renderCharts(d.chart);
}

/* Signals */
function renderSignals(s) {
  $("signalScore").textContent = s.score > 0 ? "+" + s.score : s.score;
  $("signalLabel").textContent = s.label;
  const color = s.score >= 20 ? "var(--up)" : s.score <= -20 ? "var(--down)" : "var(--muted)";
  $("signalLabel").style.color = color;
  // gauge: map -100..100 → 0..360
  const deg = ((s.score + 100) / 200) * 360;
  $("gaugeFill").parentElement.style.background =
    `conic-gradient(${color} 0deg ${deg}deg, var(--rule) ${deg}deg 360deg)`;
  const ul = $("signalList"); ul.innerHTML = "";
  (s.components || []).forEach((c) => {
    const cls = c.score > 0.1 ? "pos" : c.score < -0.1 ? "neg" : "neu";
    const arrow = c.score > 0.1 ? "▲" : c.score < -0.1 ? "▼" : "■";
    const li = document.createElement("li");
    li.innerHTML = `<span class="${cls}">${arrow} ${escHtml(c.name)}</span><span class="muted">${escHtml(c.note)}</span>`;
    ul.appendChild(li);
  });
}

/* Tech table */
function renderTech(d) {
  const l = d.latest, p = d.pivots, lv = d.levels;
  const rows = [
    ["Harga", fmtRp(l.price)],
    [`MA 5 / 20${help("ma")}`, `${fmtRp(l.ma5)} / ${fmtRp(l.ma20)}`],
    ["MA 50 / 200", `${fmtRp(l.ma50)} / ${fmtRp(l.ma200)}`],
    [`RSI (14)${help("rsi")}`, l.rsi14 != null ? l.rsi14.toFixed(1) : "-"],
    [`MACD / Sinyal${help("macd")}`, `${num(l.macd)} / ${num(l.macd_signal)}`],
    ["MACD Histogram", num(l.macd_hist)],
    [`Bollinger (Atas/Bawah)${help("bollinger")}`, `${fmtRp(l.bb_upper)} / ${fmtRp(l.bb_lower)}`],
    [`ATR (14) - volatilitas${help("atr")}`, fmtRp(l.atr14)],
    [`Pivot${help("pivot")}`, fmtRp(p.pivot)],
    [`Resistance R1 / R2${help("sr")}`, `${fmtRp(p.r1)} / ${fmtRp(p.r2)}`],
    ["Support S1 / S2", `${fmtRp(p.s1)} / ${fmtRp(p.s2)}`],
    ["High/Low 20 hari", `${fmtRp(lv.high_20h)} / ${fmtRp(lv.low_20h)}`],
    ["High/Low 60 hari", `${fmtRp(lv.high_60h)} / ${fmtRp(lv.low_60h)}`],
  ];
  $("techTable").innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("");
}
function num(x) { return x === null || x === undefined ? "-" : Number(x).toFixed(2); }

/* Benchmarks */
const BENCH_CFG = {
  per: { label: "PER", def: 15, dir: "low", unit: "x" },
  pbv: { label: "PBV", def: 2, dir: "low", unit: "x" },
  roe: { label: "ROE", def: 15, dir: "high", unit: "%" },
  roa: { label: "ROA", def: 2, dir: "high", unit: "%" },
  npm: { label: "Margin Laba Bersih", def: 10, dir: "high", unit: "%" },
  dividendYield: { label: "Imbal Hasil Dividen", def: 4, dir: "high", unit: "%" },
  payoutRatio: { label: "Rasio Payout", def: 50, dir: "high", unit: "%" },
  beta: { label: "Beta", def: 1, dir: "low", unit: "" },
};
const BENCH_ORDER = ["per", "pbv", "roe", "roa", "npm", "dividendYield", "payoutRatio", "beta"];
const BG_KEY = "saham_bench_global", BS_KEY = "saham_bench_stock";
let benchScope = "all";
function benchGlobal() { try { return JSON.parse(localStorage.getItem(BG_KEY)) || {}; } catch { return {}; } }
function benchStockAll() { try { return JSON.parse(localStorage.getItem(BS_KEY)) || {}; } catch { return {}; } }
function saveBenchGlobal(o) { localStorage.setItem(BG_KEY, JSON.stringify(o)); }
function saveBenchStock(o) { localStorage.setItem(BS_KEY, JSON.stringify(o)); }
function effectiveBench(tk, m) {
  const s = benchStockAll()[tk] || {}, g = benchGlobal();
  if (s[m] != null) return s[m];
  if (g[m] != null) return g[m];
  return BENCH_CFG[m].def;
}
function judgeMetric(tk, m, value) {
  const cfg = BENCH_CFG[m];
  if (!cfg || value == null || isNaN(value)) return null;
  const bench = effectiveBench(tk, m);
  let verdict, cls;
  if (cfg.dir === "high") {
    if (value >= bench) { verdict = "Baik"; cls = "good"; }
    else if (value >= bench * 0.7) { verdict = "Cukup"; cls = "mid"; }
    else { verdict = "Kurang"; cls = "bad"; }
  } else {
    if (value <= bench) { verdict = "Baik"; cls = "good"; }
    else if (value <= bench * 1.5) { verdict = "Wajar"; cls = "mid"; }
    else { verdict = "Tinggi"; cls = "bad"; }
  }
  return { bench, verdict, cls, unit: cfg.unit };
}

function renderBenchGrid(tk) {
  $("benchTk").textContent = tk ? tk.replace(".JK", "") : "-";
  const g = benchGlobal(), s = benchStockAll()[tk] || {};
  $("benchGrid").innerHTML = BENCH_ORDER.map((m) => {
    const cfg = BENCH_CFG[m];
    const val = benchScope === "all" ? (g[m] ?? cfg.def) : (s[m] ?? g[m] ?? cfg.def);
    const isDef = benchScope === "all" ? (g[m] == null) : (s[m] == null);
    const dir = cfg.dir === "high" ? "↑ tinggi = baik" : "↓ rendah = baik";
    return `<div class="bench-row">
      <span class="bench-lbl">${cfg.label}</span>
      <input class="bench-inp" data-m="${m}" type="number" step="any" value="${val}" aria-label="Nilai acuan ${cfg.label}">
      <span class="bench-dir tiny muted">${cfg.unit ? cfg.unit + " · " : ""}${dir}${isDef ? "" : " · <b>diubah</b>"}</span>
      <button class="bench-reset" data-m="${m}" title="Reset metrik ini ke default">↺</button>
    </div>`;
  }).join("");
  $("benchGrid").querySelectorAll(".bench-inp").forEach((inp) => {
    inp.onchange = () => setBench(tk, inp.dataset.m, parseFloat(inp.value));
  });
  $("benchGrid").querySelectorAll(".bench-reset").forEach((b) => {
    b.onclick = () => resetBench(tk, b.dataset.m);
  });
}
function refreshBench(tk) { renderBenchGrid(tk); if (lastData) renderFund(lastData); }
function setBench(tk, m, val) {
  if (isNaN(val)) return;
  if (benchScope === "all") { const g = benchGlobal(); g[m] = val; saveBenchGlobal(g); }
  else { const all = benchStockAll(); (all[tk] = all[tk] || {})[m] = val; saveBenchStock(all); }
  refreshBench(tk);
}
function resetBench(tk, m) {
  if (benchScope === "all") { const g = benchGlobal(); delete g[m]; saveBenchGlobal(g); }
  else { const all = benchStockAll(); if (all[tk]) { delete all[tk][m]; if (!Object.keys(all[tk]).length) delete all[tk]; saveBenchStock(all); } }
  refreshBench(tk); toast(`Reset ${BENCH_CFG[m].label} ke default`);
}
function resetAllBench(tk) {
  if (benchScope === "all") { saveBenchGlobal({}); }
  else { const all = benchStockAll(); delete all[tk]; saveBenchStock(all); }
  refreshBench(tk); toast("Reset semua benchmark ke default");
}

/* Riwayat kinerja kuartalan */
function _shortNum(n) {
  if (n == null || isNaN(n)) return "";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e12) return s + (a / 1e12).toFixed(1) + "T";
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + "M";
  if (a >= 1e6) return s + (a / 1e6).toFixed(0) + "jt";
  return fmt(n);
}
function _miniBars(title, quarters, field) {
  const vals = quarters.map((q) => q[field]).filter((v) => v != null);
  if (!vals.length) return `<div class="qgroup"><div class="qtitle">${title}</div><span class="tiny muted">n/a</span></div>`;
  const maxAbs = Math.max(...vals.map(Math.abs)) || 1;
  const bars = quarters.map((q) => {
    const v = q[field];
    if (v == null) {
      return `<div class="qbar" title="${q.label}: n/a">
      <div class="qbar-val tiny muted">n/a</div>
      <div class="qbar-lbl tiny muted">${q.label}</div></div>`;
    }
    const h = Math.max(3, Math.abs(v) / maxAbs * 64);
    const pos = v >= 0;
    return `<div class="qbar" title="${q.label}: ${fmtBig(v)}">
      <div class="qbar-val tiny ${pos ? "up" : "down"}">${_shortNum(v)}</div>
      <div class="bar ${pos ? "pos" : "neg"}" style="height:${h}px"></div>
      <div class="qbar-lbl tiny muted">${q.label}</div></div>`;
  }).join("");
  return `<div class="qgroup"><div class="qtitle">${title}</div><div class="qbars">${bars}</div></div>`;
}
async function loadFinancials(tk) {
  const el = $("finHist"); el.innerHTML = "<span class='loading'>Memuat…</span>";
  try {
    const d = await (await fetch("/api/financials/" + encodeURIComponent(tk))).json();
    if (!d.quarters || !d.quarters.length) { el.textContent = d.note || "Data kuartalan tidak tersedia."; return; }
    el.innerHTML = _miniBars("Pendapatan", d.quarters, "revenue") + _miniBars("Laba Bersih", d.quarters, "netIncome");
  } catch { el.innerHTML = "<span class='error-row'>Gagal memuat data kuartalan.</span>"; }
}

/* Fundamentals */
function renderFund(d) {
  const f = d.fundamentals, tk = d.ticker;
  const chip = (m, raw) => {
    const j = judgeMetric(tk, m, raw);
    return j ? ` <span class="bench ${j.cls}" title="Nilai acuan: ${j.bench}${j.unit}">acuan ${fmt(j.bench)}${j.unit} · ${j.verdict}</span>` : "";
  };
  const rows = [
    `<tr><td>Nama / Sektor</td><td>${escHtml(f.longName)}${f.sector ? " · " + escHtml(f.sector) : ""}</td></tr>`,
    `<tr><td>Kapitalisasi Pasar</td><td>${fmtBig(f.marketCap)}</td></tr>`,
    `<tr><td>PER (trailing / forward)${help("per")}</td><td>${num(f.per)} / ${num(f.forwardPer)}${chip("per", f.per)}</td></tr>`,
    `<tr><td>PBV${help("pbv")}</td><td>${num(f.pbv)}${chip("pbv", f.pbv)}</td></tr>`,
    `<tr><td>EPS (Laba/Saham)${help("eps")}</td><td>${fmtRp(f.eps)}</td></tr>`,
    `<tr><td>BVPS (Nilai Buku/Saham)${help("bvps")}</td><td>${fmtRp(f.bvps)}</td></tr>`,
    `<tr><td>ROE${help("roe")}</td><td>${fmtPct(f.roe)}${chip("roe", f.roe)}</td></tr>`,
    `<tr><td>ROA${help("roa")}</td><td>${fmtPct(f.roa)}${chip("roa", f.roa)}</td></tr>`,
    `<tr><td>Margin Laba Bersih${help("npm")}</td><td>${fmtPct(f.npm)}${chip("npm", f.npm)}</td></tr>`,
    `<tr><td>Imbal Hasil Dividen${help("dividendYield")}</td><td>${fmtPct(f.dividendYield)}${chip("dividendYield", f.dividendYield)}</td></tr>`,
    `<tr><td>Dividen/Saham (DPS)</td><td>${fmtRp(f.dps)}</td></tr>`,
    `<tr><td>Rasio Payout${help("payoutRatio")}</td><td>${fmtPct(f.payoutRatio)}${chip("payoutRatio", f.payoutRatio)}</td></tr>`,
    `<tr><td>Beta${help("beta")}</td><td>${num(f.beta)}${chip("beta", f.beta)}</td></tr>`,
    `<tr><td>52-Week High / Low</td><td>${fmtRp(f.high52)} / ${fmtRp(f.low52)}</td></tr>`,
    `<tr><td>Target Analis (rata/tinggi/rendah)</td><td>${fmtRp(f.targetMean)} / ${fmtRp(f.targetHigh)} / ${fmtRp(f.targetLow)}</td></tr>`,
    `<tr><td>Rekomendasi Konsensus</td><td>${f.recommendation ? escHtml(String(f.recommendation).toUpperCase()) : "-"}</td></tr>`,
  ];
  $("fundTable").innerHTML = rows.join("");
}

/* Charts */
let lastChartData = null;
// One slot per candle: indicator values where they exist and blanks during the warm-up,
// so the RSI and MACD panes have the same bars as the price chart and stay lined up.
function alignToCandles(candles, points) {
  const byTime = new Map(points.map((p) => [p.time, p]));
  return candles.map((bar) => byTime.get(bar.time) || { time: bar.time });
}
// A chart built while its pane is hidden is fitted to 0 px; refit it once it
// gets its real width (and whenever the width changes), or its data piles up
// at the right edge.
function fitChartOnResize(chart, el) {
  if (el._fitObserver) el._fitObserver.disconnect();
  let width = el.clientWidth;
  el._fitObserver = new ResizeObserver(() => {
    const next = el.clientWidth;
    if (next > 0 && next !== width) {
      requestAnimationFrame(() => { try { chart.timeScale().fitContent(); } catch { /* chart was replaced */ } });
    }
    width = next;
  });
  el._fitObserver.observe(el);
}
window.fitChartOnResize = fitChartOnResize;
function renderCharts(c) {
  lastChartData = c;
  Object.values(charts).forEach((ch) => { try { ch.remove(); } catch {} });
  charts = {};
  if (!window.LightweightCharts) {
    $("chart").innerHTML = "<div class='error-row'>Library grafik gagal dimuat. Periksa koneksi internet lalu muat ulang.</div>";
    return;
  }
  $("chart").innerHTML = "";
  const cc = window.chartColors();
  const common = {
    layout: { background: { color: cc.bg }, textColor: cc.text },
    grid: { vertLines: { color: cc.grid }, horzLines: { color: cc.grid } },
    rightPriceScale: { borderColor: cc.grid, minimumWidth: 72 },
    timeScale: { borderColor: cc.grid },
  };
  const pc = LightweightCharts.createChart($("chart"), { ...common, height: 360 });
  const candle = pc.addCandlestickSeries({ upColor: cc.up, downColor: cc.down, borderVisible: false, wickUpColor: cc.up, wickDownColor: cc.down });
  candle.setData(c.candles);
  const ma = getMaSettings();
  const legend = [
    { type: "box", color: cc.up, label: "Candle naik" },
    { type: "box", color: cc.down, label: "Candle turun" },
  ];
  [5, 10, 20, 50, 100, 200].forEach((p) => {
    if (!ma.periods[p]) return;
    const data = ma.type === "EMA" ? emaSeries(c.candles, p) : smaSeries(c.candles, p);
    const style = MA_STYLES[p], col = cc[style.color];
    pc.addLineSeries({ color: col, lineWidth: 2, lineStyle: style.lineStyle, priceLineVisible: false, lastValueVisible: false }).setData(data);
    legend.push({ type: "line", color: col, dash: style.lineStyle, label: (ma.type === "EMA" ? "EMA" : "MA") + p });
  });
  if (ma.bb) {
    pc.addLineSeries({ color: cc.muted, lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false }).setData(c.bb_u);
    pc.addLineSeries({ color: cc.muted, lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false }).setData(c.bb_l);
    legend.push({ type: "line", color: cc.muted, dash: 1, label: "Bollinger (20, 2σ)" });
  }
  renderLegend(legend);
  charts.price = pc;
  charts.candle = candle;
  setupDrawing(pc, candle);

  const rc = LightweightCharts.createChart($("rsiChart"), { ...common, height: 130 });
  rc.addLineSeries({ color: cc.ink, lineWidth: 1 }).setData(alignToCandles(c.candles, c.rsi));
  const r70 = rc.addLineSeries({ color: cc.muted, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  const r30 = rc.addLineSeries({ color: cc.muted, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  if (c.rsi.length) {
    r70.setData(c.rsi.map((p) => ({ time: p.time, value: 70 })));
    r30.setData(c.rsi.map((p) => ({ time: p.time, value: 30 })));
  }
  charts.rsi = rc;

  const mc = LightweightCharts.createChart($("macdChart"), { ...common, height: 130 });
  mc.addHistogramSeries().setData(alignToCandles(c.candles, c.macd_hist.map((p) => ({ ...p, color: (p.value >= 0 ? cc.up : cc.down) + "aa" }))));
  mc.addLineSeries({ color: cc.ink, lineWidth: 1 }).setData(c.macd);
  mc.addLineSeries({ color: cc.muted, lineWidth: 1, lineStyle: 2 }).setData(c.macd_signal);
  charts.macd = mc;

  [rc, mc].forEach((sub) => {
    pc.timeScale().subscribeVisibleLogicalRangeChange((rng) => { if (rng) try { sub.timeScale().setVisibleLogicalRange(rng); } catch {} });
  });
  // The same price-scale width in every pane puts each bar at the same x.
  requestAnimationFrame(() => {
    try {
      const width = Math.max(...[pc, rc, mc].map((ch) => ch.priceScale("right").width()));
      if (width > 0) [pc, rc, mc].forEach((ch) => ch.applyOptions({ rightPriceScale: { minimumWidth: width } }));
    } catch { /* charts were replaced before this frame */ }
  });
  if (_subChartRO) _subChartRO.disconnect();
  _subChartRO = new ResizeObserver(() => {
    rc.applyOptions({ width: $("rsiChart").clientWidth });
    mc.applyOptions({ width: $("macdChart").clientWidth });
  });
  _subChartRO.observe($("rsiChart"));
  _subChartRO.observe($("macdChart"));
}
let _subChartRO = null;

/* DRAWING (ala TradingView, ringkas) */
let drawTool = "none";     // none | trend | hline
let drawings = [];         // {type:'trend', a:{time,price}, b:{time,price}} | {type:'hline', price}
let pendingPt = null;
let overlay = null, octx = null, _chartRO = null, _drawTicker = null;

function sizeOverlay(cont) {
  const w = cont.clientWidth, h = cont.clientHeight, dpr = window.devicePixelRatio || 1;
  overlay.width = w * dpr; overlay.height = h * dpr;
  overlay.style.width = w + "px"; overlay.style.height = h + "px";
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function setHint(t) { const el = $("ctoolHint"); if (el) el.textContent = t; }
function updateToolButtons() {
  document.querySelectorAll(".ctool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === drawTool));
}

function setupDrawing(chart, series) {
  const cont = $("chart");
  if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
  overlay = document.createElement("canvas");
  overlay.style.cssText = "position:absolute;left:0;top:0;z-index:3;pointer-events:none";
  cont.appendChild(overlay);
  octx = overlay.getContext("2d");
  if (_drawTicker !== current) { drawings = []; _drawTicker = current; }  // keep drawings when the indicators change
  pendingPt = null; drawTool = "none"; updateToolButtons(); setHint("");
  sizeOverlay(cont);
  const redraw = () => drawOverlay(chart, series, cont);
  chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
  chart.subscribeClick((param) => onChartClick(param, chart, series, cont));
  if (_chartRO) _chartRO.disconnect();
  _chartRO = new ResizeObserver(() => { chart.applyOptions({ width: cont.clientWidth }); sizeOverlay(cont); redraw(); });
  _chartRO.observe(cont);
  redraw();
}

function onChartClick(param, chart, series, cont) {
  if (drawTool === "none") return;
  const x = param.point && param.point.x, y = param.point && param.point.y;
  if (x == null || y == null) return;
  const price = series.coordinateToPrice(y);
  const time = param.time != null ? param.time : chart.timeScale().coordinateToTime(x);
  if (drawTool === "hline") {
    if (price != null) drawings.push({ type: "hline", price });
  } else if (drawTool === "trend") {
    if (time == null || price == null) return;
    if (!pendingPt) { pendingPt = { time, price }; setHint("Klik titik KEDUA untuk garis tren"); }
    else { drawings.push({ type: "trend", a: pendingPt, b: { time, price } }); pendingPt = null; setHint("Garis tren dibuat. Klik lagi untuk garis baru."); }
  }
  drawOverlay(chart, series, cont);
}

function drawOverlay(chart, series, cont) {
  if (!octx) return;
  const w = cont.clientWidth, h = cont.clientHeight, ts = chart.timeScale();
  octx.clearRect(0, 0, w, h);
  const cc = window.chartColors();
  octx.lineWidth = 1.6; octx.font = "11px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
  drawings.forEach((d) => {
    if (d.type === "hline") {
      const yy = series.priceToCoordinate(d.price); if (yy == null) return;
      octx.strokeStyle = cc.ink; octx.setLineDash([5, 3]);
      octx.beginPath(); octx.moveTo(0, yy); octx.lineTo(w, yy); octx.stroke(); octx.setLineDash([]);
      octx.fillStyle = cc.ink; octx.fillText(fmt(d.price), 6, yy - 4);
    } else if (d.type === "trend") {
      const x1 = ts.timeToCoordinate(d.a.time), y1 = series.priceToCoordinate(d.a.price);
      const x2 = ts.timeToCoordinate(d.b.time), y2 = series.priceToCoordinate(d.b.price);
      if ([x1, y1, x2, y2].some((v) => v == null)) return;
      octx.strokeStyle = cc.ink; octx.beginPath(); octx.moveTo(x1, y1); octx.lineTo(x2, y2); octx.stroke();
      octx.fillStyle = cc.ink;
      [[x1, y1], [x2, y2]].forEach(([px, py]) => { octx.beginPath(); octx.arc(px, py, 3, 0, 7); octx.fill(); });
    }
  });
  if (pendingPt) {
    const px = ts.timeToCoordinate(pendingPt.time), py = series.priceToCoordinate(pendingPt.price);
    if (px != null && py != null) { octx.fillStyle = cc.ink; octx.beginPath(); octx.arc(px, py, 4, 0, 7); octx.fill(); }
  }
}

document.querySelectorAll(".ctool[data-tool]").forEach((b) => {
  b.onclick = () => {
    drawTool = b.dataset.tool; pendingPt = null; updateToolButtons();
    setHint(drawTool === "trend" ? "Klik titik PERTAMA garis tren"
      : drawTool === "hline" ? "Klik untuk menaruh garis horizontal" : "");
    if (charts.price && charts.candle) drawOverlay(charts.price, charts.candle, $("chart"));
  };
});
$("ctoolClear").onclick = () => {
  drawings = []; pendingPt = null; setHint("");
  if (charts.price && charts.candle) drawOverlay(charts.price, charts.candle, $("chart"));
};

/* benchmark scope + reset all */
document.querySelectorAll(".segbtn[data-scope]").forEach((b) => {
  b.onclick = () => {
    benchScope = b.dataset.scope;
    document.querySelectorAll(".segbtn[data-scope]").forEach((x) => x.classList.toggle("active", x === b));
    renderBenchGrid(lastData ? lastData.ticker : null);
  };
});
$("benchResetAll").onclick = () => resetAllBench(lastData ? lastData.ticker : null);

/* Calculators */
function prefillCalculators(d) {
  // Only when another stock opens: auto-refresh must not overwrite typed values.
  if (d.ticker === prefillCalculators.ticker) return;
  prefillCalculators.ticker = d.ticker;
  const f = d.fundamentals;
  if ($("calcSource")) $("calcSource").textContent = `Diisi dari ${d.ticker.replace(".JK", "")}, saham terakhir dibuka.`;
  if (f.bvps != null) $("fvBvps").value = round2(f.bvps);
  if (f.pbv != null) $("fvPbv").value = round2(f.pbv);
  if (f.eps != null) $("fvEps").value = round2(f.eps);
  if (f.per != null) $("fvPer").value = round2(f.per);
  if (f.dps != null) $("dvDps").value = round2(f.dps);
  [$("dvPrice"), $("poBuy"), $("riBuy")].forEach((el) => { el.value = round2(d.price); });
}
function round2(x) { return Math.round(x * 100) / 100; }
function val(id) { const v = parseFloat($(id).value); return isNaN(v) ? null : v; }

function calcFairValue() {
  const bvps = val("fvBvps"), pbv = val("fvPbv"), eps = val("fvEps"), per = val("fvPer");
  const price = lastData ? lastData.price : null;
  let html = "";
  if (bvps != null && pbv != null) {
    const fair = bvps * pbv;
    html += line("Harga wajar (PBV)", fmtRp(fair), upside(fair, price));
  }
  if (eps != null && per != null) {
    const fair = eps * per;
    html += line("Harga wajar (PER)", fmtRp(fair), upside(fair, price));
  }
  if (!html) html = "<span class='muted'>Isi BVPS+PBV atau EPS+PER.</span>";
  $("fvResult").innerHTML = html;
}
function upside(fair, price) {
  if (!price) return "";
  const u = (fair - price) / price * 100;
  const cls = u >= 0 ? "up" : "down";
  return ` <span class="${cls}">(${u >= 0 ? "+" : ""}${u.toFixed(1)}% vs harga)</span>`;
}
function line(label, big, extra = "") { return `<div>${label}: <span class="big">${big}</span>${extra}</div>`; }

function calcDividend() {
  const lot = val("dvLot"), dps = val("dvDps"), price = val("dvPrice"), tax = $("dvTax").checked;
  if (lot == null || dps == null) { $("dvResult").innerHTML = "<span class='muted'>Isi lot & DPS.</span>"; return; }
  const shares = lot * 100;
  let gross = shares * dps;
  let net = tax ? gross * 0.9 : gross;
  let html = line("Dividen kotor", fmtRp(gross));
  if (tax) html += line("Dividen bersih (−10%)", fmtRp(net));
  if (price) {
    const invest = shares * price;
    const yld = dps / price * 100;
    html += `<div class="tiny muted">Modal: ${fmtRp(invest)} · Yield: ${yld.toFixed(2)}% (bersih ${(yld * (tax ? 0.9 : 1)).toFixed(2)}%)</div>`;
  }
  $("dvResult").innerHTML = html;
}

function calcPosition() {
  const lot = val("poLot"), buy = val("poBuy"), fb = val("poFeeBuy") || 0, fs = val("poFeeSell") || 0;
  if (lot == null || buy == null) { $("poResult").innerHTML = "<span class='muted'>Isi lot & harga.</span>"; return; }
  const shares = lot * 100;
  const gross = shares * buy;
  const feeBuy = gross * fb / 100;
  const totalCost = gross + feeBuy;
  // Sell price that breaks even after both fees; a 100% sell fee has none.
  const breakeven = fs < 100 ? buy * (1 + fb / 100) / (1 - fs / 100) : null;
  $("poResult").innerHTML =
    line("Nilai beli", fmtRp(gross)) +
    line("Fee beli", fmtRp(feeBuy)) +
    line("Total modal", fmtRp(totalCost)) +
    `<div>Harga break-even (incl. fee jual): <span class="big">${fmtRp(breakeven, 2)}</span></div>` +
    `<div class="tiny muted">${fmt(shares)} lembar (${lot} lot)</div>`;
}

function calcRisk() {
  const lot = val("riLot"), buy = val("riBuy"), tgt = val("riTarget"), stop = val("riStop");
  if (lot == null || buy == null || buy <= 0) { $("riResult").innerHTML = "<span class='muted'>Isi lot & harga beli (lebih dari 0).</span>"; return; }
  const shares = lot * 100;
  let html = "";
  if (tgt != null) {
    const profit = (tgt - buy) * shares;
    const pct = (tgt - buy) / buy * 100;
    html += line("Potensi profit", fmtRp(profit), ` <span class="${profit >= 0 ? "up" : "down"}">(${pct.toFixed(1)}%)</span>`);
  }
  if (stop != null) {
    const loss = (stop - buy) * shares;
    const pct = (stop - buy) / buy * 100;
    html += line("Potensi rugi (stop)", fmtRp(loss), ` <span class="down">(${pct.toFixed(1)}%)</span>`);
  }
  if (tgt != null && stop != null && stop !== buy) {
    const rr = Math.abs((tgt - buy) / (buy - stop));
    html += `<div>Risk/Reward: <span class="big">1 : ${rr.toFixed(2)}</span> ${rr >= 2 ? '<span class="up">(baik)</span>' : '<span class="warn">(pertimbangkan)</span>'}</div>`;
  }
  $("riResult").innerHTML = html || "<span class='muted'>Isi target &/atau stop loss.</span>";
}

/* Events */
$("addBtn").onclick = () => { addStock($("tickerInput").value); $("tickerInput").value = ""; };
$("tickerInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { addStock($("tickerInput").value); $("tickerInput").value = ""; } });
$("refreshBtn").onclick = () => { if (current) selectStock(current); renderWL(); };
$("rangeSel").onchange = () => { if (current) selectStock(current); };
document.querySelectorAll(".calcBtn[data-calc]").forEach((b) => {
  b.onclick = () => ({ fv: calcFairValue, dv: calcDividend, po: calcPosition, ri: calcRisk }[b.dataset.calc]());
});

/* TABS */
let currentTab = "analisa";
const newsState = { ticker: null, market: [], stock: [] };

const TAB_PANELS = { home: "tabHome", analisa: "tabAnalisa", pasar: "tabPasar", porto: "tabPorto", keuangan: "tabKeuangan", barang: "tabBarang", alat: "tabAlat", screener: "tabScreener", berita: "tabBerita", profil: "tabProfil" };

// Sub-tab controls per view; each renders its data when it becomes visible.
window.subtabsFor = {};
function initSubtabs(view, navId, renders) {
  const nav = $(navId); if (!nav || !window.Subtabs) return;
  const handle = window.Subtabs.init(nav, { onChange: (sub) => { if (currentTab === view && renders[sub]) renders[sub](); } });
  handle.renders = renders;
  window.subtabsFor[view] = handle;
}
initSubtabs("pasar", "pasarTabs", {
  ihsg: () => window.marketRender && window.marketRender(),
  rupiah: () => window.rupiahRender && window.rupiahRender(),
  emas: () => window.emasRender && window.emasRender(),
});
initSubtabs("alat", "alatTabs", { ara: () => window.araRender && window.araRender() });
// Keuangan renders every section at once, so switching sub-tabs needs no fetch.
initSubtabs("keuangan", "keuanganTabs", {});

function showTab(name, sub) {
  // Old names (rupiah, emas, ara, kalkulator) now live as sub-tabs.
  const route = window.UiPrefs.canonicalTab(name);
  name = route.tab;
  sub = sub || route.sub;
  const changed = currentTab !== name;
  currentTab = name;
  document.body.dataset.currentTab = name;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });
  Object.entries(TAB_PANELS).forEach(([key, id]) => {
    const panel = $(id); if (!panel) return;
    const on = key === name;
    panel.classList.toggle("hidden", !on);
    if (on && changed) { panel.classList.remove("view-enter"); void panel.offsetWidth; panel.classList.add("view-enter"); }
  });
  syncStockEmpty();
  if (name === "berita") ensureNews();
  if (name === "analisa") renderCompare();
  if (name === "porto") { loadPortfolio(); renderRdn(); if (window.journalRender) window.journalRender(); }
  if (name === "keuangan" && window.financeRender) window.financeRender();
  if (name === "barang" && window.barangRender) window.barangRender();
  const subtabs = window.subtabsFor[name];
  if (subtabs) {
    if (sub) subtabs.select(sub);
    else if (subtabs.renders[subtabs.current()]) subtabs.renders[subtabs.current()]();
  }
  if (name === "home" && window.homeRender) window.homeRender();
  if (typeof a11yLabel === "function") setTimeout(a11yLabel, 0);
  setTimeout(() => { if (window.formatMoneyAll) window.formatMoneyAll(); }, 0);
}
document.querySelectorAll(".tab").forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });

/* Tablist vertikal: panah memindah fokus, Home/End ke ujung (roving tabindex). */
function wireTablistKeys(list, itemSel, activate) {
  if (!list) return;
  list.addEventListener("keydown", (e) => {
    const keys = { "ArrowDown": 1, "ArrowRight": 1, "ArrowUp": -1, "ArrowLeft": -1, "Home": "first", "End": "last" };
    if (!(e.key in keys)) return;
    const items = [...list.querySelectorAll(itemSel)].filter((t) => t.style.display !== "none");
    if (!items.length) return;
    let i = items.indexOf(document.activeElement);
    if (i < 0) i = items.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const k = keys[e.key];
    i = k === "first" ? 0 : k === "last" ? items.length - 1 : (i + k + items.length) % items.length;
    items[i].focus(); activate(items[i]); e.preventDefault();
  });
}
function setupTabsAria() {
  const list = document.querySelector(".tabs");
  if (list) list.setAttribute("aria-orientation", "vertical");
  wireTablistKeys(list, ".tab", (t) => showTab(t.dataset.tab));
  wireTablistKeys($("setNav"), ".set-navbtn", (b) => setSettingsPane(b.dataset.pane));
}

/* Measure the header (top bar + mode bar) into CSS vars so sticky parts never overlap */
function measureChrome() {
  const tb = document.querySelector(".topbar"), mb = document.querySelector(".modebar");
  const th = tb ? tb.offsetHeight : 57, mh = (mb && mb.offsetHeight) ? mb.offsetHeight : 56;
  const r = document.documentElement.style;
  r.setProperty("--topbar-h", th + "px");
  r.setProperty("--stack-h", (th + mh) + "px");
}
window.addEventListener("resize", measureChrome);
window.addEventListener("load", measureChrome);

/* Workspace: Investasi vs Pribadi */
let currentMode = "saham";
function setMode(m, keepTab, fromBoot) {
  currentMode = m === "private" ? "private" : "saham";
  document.body.dataset.workspaceMode = currentMode;
  if (!fromBoot || localStorage.getItem("mc_mode") !== null) localStorage.setItem("mc_mode", currentMode);
  const stock = currentMode === "saham";
  document.querySelectorAll(".modebtn").forEach((b) => {
    const on = b.dataset.mode === currentMode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  // stock-only chrome
  const search = document.querySelector(".search"); if (search) search.style.display = stock ? "" : "none";
  $("autoInfo").style.display = stock ? "" : "none";
  // show the workspace's tab buttons, minus the ones the owner hid
  const hid = tabHiddenSet();
  document.querySelectorAll(".tab").forEach((b) => {
    const g = b.dataset.group;
    const byGroup = (g === "both" || (stock ? g === "saham" : g === "private"));
    b.style.display = (byGroup && !hid.has(b.dataset.tab)) ? "" : "none";
  });
  let target = stock ? "home" : "keuangan";
  if (hid.has(target)) { const fv = [...document.querySelectorAll(".tab")].find((b) => b.style.display !== "none"); if (fv) target = fv.dataset.tab; }
  // When only tab visibility changes (e.g. a layout change), keep the open tab or
  // Pengaturan if it is still shown instead of jumping to Ringkasan.
  if (keepTab) {
    if (currentTab === "profil") target = "profil";
    else { const curBtn = document.querySelector(`.tab[data-tab="${currentTab}"]`); if (curBtn && curBtn.style.display !== "none") target = currentTab; }
  }
  showTab(target);
  measureChrome(); setTimeout(measureChrome, 60);   // the header height changes when the search shows or hides
}
document.querySelectorAll(".modebtn").forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

/* NEWS */
function impactBadge(i) {
  const cls = i === "HIGH" ? "b-high" : i === "MED" ? "b-med" : "b-low";
  const label = i === "HIGH" ? "Dampak Tinggi" : i === "MED" ? "Dampak Sedang" : "Dampak Rendah";
  return `<span class="badge ${cls}">${label}</span>`;
}
function sentBadge(s) {
  const cls = s === "POSITIF" ? "b-pos" : s === "NEGATIF" ? "b-neg" : "b-neu";
  const ar = s === "POSITIF" ? "▲" : s === "NEGATIF" ? "▼" : "■";
  return `<span class="${cls}">${ar} ${escHtml(s)}</span>`;
}
function fmtNewsDate(s) {
  if (!s) return "";
  const d = new Date(s); if (isNaN(d.getTime())) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 0) return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
  if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + " mnt lalu";
  if (diff < 86400) return Math.round(diff / 3600) + " jam lalu";
  if (diff < 604800) return Math.round(diff / 86400) + " hari lalu";
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}
function safeHttpUrl(value) {
  try { const u = new URL(String(value || ""), location.href); return /^https?:$/.test(u.protocol) ? u.href : "#"; }
  catch { return "#"; }
}
function renderNews(el, items) {
  if (!items || !items.length) { el.innerHTML = "<li class='tiny muted'>Tidak ada berita.</li>"; return; }
  el.innerHTML = items.map((n) => {
    const dt = fmtNewsDate(n.published);
    return `
    <li>
      <a href="${escHtml(safeHttpUrl(n.link))}" target="_blank" rel="noopener noreferrer">${escHtml(n.title)}</a>
      <div class="news-meta">
        ${impactBadge(n.impact)} ${sentBadge(n.sentiment)}
        <span class="src ${n.credible ? "cred" : ""}">${n.credible ? "✓ " : ""}${escHtml(n.source)}</span>
        ${dt ? `<span class="news-date tiny muted">· ${dt}</span>` : ""}
      </div>
    </li>`;
  }).join("");
}
function setNewsUpdated() {
  const el = $("newsUpdated"); if (el) el.textContent = "Terakhir diperbarui: " + new Date().toLocaleString("id-ID");
}
async function ensureNews(fresh) {
  const q = fresh ? "?fresh=1" : "";
  if (fresh || !newsState.market.length) {
    if (fresh) $("newsMarketList").innerHTML = "<li class='loading'>Memuat…</li>";
    try {
      const d = await (await fetch("/api/news/market" + q)).json();
      newsState.market = d.items || [];
      renderNews($("newsMarketList"), newsState.market);
    } catch {
      $("newsMarketList").innerHTML = `<li class='error-row'>Berita pasar gagal dimuat. <button type='button' class='btn-secondary' data-retry>Coba lagi</button></li>`;
      wireRetry($("newsMarketList"), () => ensureNews(true));
    }
  }
  // per stock (when the ticker changes or on a forced refresh)
  if (current && (fresh || newsState.ticker !== current)) {
    newsState.ticker = current;
    $("newsStockTicker").textContent = current.replace(".JK", "");
    $("newsStockList").innerHTML = "<li class='loading'>Memuat…</li>";
    try {
      const d = await (await fetch(`/api/news/stock/${encodeURIComponent(current)}${q}`)).json();
      newsState.stock = d.items || [];
      renderNews($("newsStockList"), newsState.stock);
    } catch {
      $("newsStockList").innerHTML = `<li class='error-row'>Berita saham gagal dimuat. <button type='button' class='btn-secondary' data-retry>Coba lagi</button></li>`;
      wireRetry($("newsStockList"), () => ensureNews(true));
    }
  }
  setNewsUpdated();
}
if ($("newsRefresh")) $("newsRefresh").onclick = () => ensureNews(true);

/* AI */
function renderAiStatus(s) {
  const el = $("aiStatus");
  const on = s.provider !== "none";          // AI di-niatkan menyala?
  $("aiToggle").checked = on;
  if (!on) el.textContent = "· Mati (ringkasan otomatis)";
  else if (s.enabled) el.textContent = "· Aktif";
  else el.textContent = "· Aktif, model belum siap (ringkasan otomatis)";
  el.title = s.hint || "";
}
async function loadAiStatus() {
  try { renderAiStatus(await (await fetch("/api/ai/status")).json()); } catch { /* ignore */ }
}
async function toggleAi(on) {
  $("aiStatus").textContent = "· …";
  try {
    const s = await (await fetch("/api/ai/toggle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    })).json();
    renderAiStatus(s);
    toast(on ? "AI dinyalakan" : "AI dimatikan");
  } catch (e) { toast("Gagal mengubah mode AI"); loadAiStatus(); }
}
$("aiToggle").onchange = (e) => toggleAi(e.target.checked);
$("aiSettingsLink").onclick = (e) => { e.preventDefault(); gotoTab("profil"); setSettingsPane("tampilan"); };
function aiContext() {
  if (!lastData) return null;
  const d = lastData;
  return {
    ticker: d.ticker, price: d.price, change: d.change, changePct: d.changePct, asOf: d.asOf,
    fundamentals: d.fundamentals, signals: d.signals, latest: d.latest, levels: d.levels, pivots: d.pivots,
    news: (newsState.ticker === d.ticker ? newsState.stock : []).slice(0, 8)
      .map((n) => ({ title: n.title, impact: n.impact, sentiment: n.sentiment, source: n.source })),
  };
}
async function aiAnalyze(question) {
  const ctx = aiContext();
  const out = $("aiOutput");
  if (!ctx) { out.textContent = "Pilih saham dulu."; return; }
  out.classList.remove("muted"); out.textContent = "Menganalisis…";
  try {
    const r = await fetch("/api/ai/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: ctx, question }),
    });
    const d = await r.json();
    out.textContent = d.text || d.error || "Tidak ada jawaban.";
    if (d.enabled === false && d.hint) out.textContent += "\n\n" + d.hint;
  } catch (e) { out.textContent = "Gagal: " + e.message; }
}
async function aiNewsBrief(scope, items, outEl) {
  outEl.classList.remove("hidden", "muted"); outEl.textContent = "Meringkas…";
  try {
    const r = await fetch("/api/ai/news", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, items }),
    });
    const d = await r.json();
    outEl.textContent = d.text || d.error || "Tidak ada ringkasan.";
    if (d.enabled === false && d.hint) outEl.textContent += "\n\n" + d.hint;
  } catch (e) { outEl.textContent = "Gagal: " + e.message; }
}

$("aiAnalyzeBtn").onclick = () => aiAnalyze(null);
$("aiAskBtn").onclick = () => { const q = $("aiQuestion").value.trim(); if (q) aiAnalyze(q); };
$("aiQuestion").addEventListener("keydown", (e) => { if (e.key === "Enter") { const q = e.target.value.trim(); if (q) aiAnalyze(q); } });
$("aiNewsMarketBtn").onclick = () => aiNewsBrief("pasar Indonesia", newsState.market, $("aiNewsMarketOut"));
$("aiNewsStockBtn").onclick = () => aiNewsBrief(current ? current.replace(".JK", "") : "saham", newsState.stock, $("aiNewsStockOut"));

/* refresh the news when the stock changes while Berita is open */
const _origSelect = selectStock;
selectStock = async function (tk) {
  await _origSelect(tk);
  if (currentTab === "berita") { newsState.ticker = null; ensureNews(); }
};

/* AUTO-REFRESH */
const AUTO_KEY = "saham_autorefresh_v1";
let autoEnabled = false, autoMin = 5, nextAt = 0, lastRefresh = null;

function loadAuto() {
  try {
    const v = JSON.parse(localStorage.getItem(AUTO_KEY)) || {};
    autoEnabled = !!v.enabled;
    autoMin = Number(v.min) > 0 ? Number(v.min) : 5;
  } catch { autoEnabled = false; autoMin = 5; }
  $("autoChk").checked = autoEnabled;
  $("autoMin").value = autoMin;
}
function saveAuto() { localStorage.setItem(AUTO_KEY, JSON.stringify({ enabled: autoEnabled, min: autoMin })); }

function applyAuto(fromBoot) {
  autoEnabled = $("autoChk").checked;
  const m = parseFloat($("autoMin").value);
  autoMin = (!isNaN(m) && m >= 0.5) ? m : 5;
  $("autoMin").value = autoMin;
  $("autoMin").disabled = !autoEnabled;
  if (autoEnabled) nextAt = Date.now() + autoMin * 60000;
  if (!fromBoot) saveAuto();
  renderAutoInfo();
}

async function doAutoRefresh() {
  if (current) await selectStock(current);
  renderWL();
  if (currentTab === "berita") { newsState.market = []; newsState.ticker = null; ensureNews(); }
  if (currentTab === "porto") loadPortfolio();
  lastRefresh = new Date();
}

function renderAutoInfo() {
  const el = $("autoInfo");
  el.classList.toggle("on", autoEnabled);
  if (!autoEnabled) {
    el.textContent = "Auto-refresh nonaktif" + (lastRefresh ? ` · terakhir ${lastRefresh.toLocaleTimeString("id-ID")}` : "");
    return;
  }
  const secs = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, "0");
  el.textContent = `Auto-refresh tiap ${autoMin} mnt · berikutnya ${mm}:${ss}`
    + (lastRefresh ? ` · terakhir ${lastRefresh.toLocaleTimeString("id-ID")}` : "");
}

/* one tick per second: countdown + trigger */
setInterval(() => {
  if (autoEnabled && Date.now() >= nextAt) {
    nextAt = Date.now() + autoMin * 60000;   // schedule first so it never runs twice
    doAutoRefresh();
  }
  renderAutoInfo();
}, 1000);

$("autoChk").onchange = () => applyAuto();
$("autoMin").onchange = () => applyAuto();

/* PORTOFOLIO */
const PF_KEY = "saham_portfolio_v1";
let pfState = loadPf();      // [{ticker, avg, lots}]
let pfData = null;           // last server response
let pfSelected = null;

function loadPf() {
  try { const v = JSON.parse(localStorage.getItem(PF_KEY)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function savePf() { localStorage.setItem(PF_KEY, JSON.stringify(pfState)); }
window.setPortfolio = (arr) => { pfState = Array.isArray(arr) ? arr : []; savePf(); loadPortfolio(); };

/* RDN cash (money left at the broker) → feeds Pribadi */
const RDN_KEY = "mc_rdn_cash";
window.rdnCash = () => { const v = parseFloat(localStorage.getItem(RDN_KEY)); return isNaN(v) ? 0 : v; };
function setRdn(val) {
  const nv = Math.round((+val) * 100) / 100;
  if (!nv) localStorage.removeItem(RDN_KEY); else localStorage.setItem(RDN_KEY, nv);
  renderRdn();
}
// used by journal.js: a sell (+) or buy (−) updates RDN
window.addRdn = (delta) => { setRdn(window.rdnCash() + (+delta || 0)); return window.rdnCash(); };
function renderRdn() {
  const v = window.rdnCash();
  const inp = $("rdnInput"); if (inp && document.activeElement !== inp) inp.value = v ? toMoneyField(v) : "";
  // fill the transfer targets from the Keuangan accounts
  const sel = $("rdnAcc");
  if (sel) {
    const accs = window.financeAccounts ? window.financeAccounts() : [];
    const prev = sel.value;
    sel.innerHTML = accs.length ? accs.map((a) => `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`).join("") : `<option value="">(buat akun di tab Keuangan)</option>`;
    if (prev && accs.some((a) => a.id === prev)) sel.value = prev;
  }
  const info = $("rdnInfo");
  if (info) info.innerHTML = (v
    ? `Saldo RDN <b class="priv ${v < 0 ? "down" : ""}">${fmtRp(v)}</b> dihitung sebagai <b>kas</b> di <b>Kekayaan</b> (Pribadi).`
    : `Isi sisa uang tunai di RDN (Rekening Dana Nasabah). Otomatis masuk hitungan <b>Kekayaan</b> di Pribadi sebagai kas.`)
    + ` Di <b>Jurnal Transaksi</b>: <b>Jual</b> otomatis menambah RDN, <b>Beli</b> mengurangi.`;
}
function saveRdn(clear) {
  if (clear) { localStorage.removeItem(RDN_KEY); $("rdnInput").value = ""; }
  else {
    const v = window.parseRp($("rdnInput").value);
    if (isNaN(v)) { localStorage.removeItem(RDN_KEY); } else localStorage.setItem(RDN_KEY, Math.round(v * 100) / 100);
  }
  renderRdn();
  if (window.financeRender) { try { window.financeRender(); } catch { /* */ } }  // perbarui net worth Pribadi
  toast(clear ? "Saldo RDN dikosongkan" : "Saldo RDN disimpan");
}
function transferRdn() {
  const amt = window.parseRp($("rdnAmt").value);
  const accId = $("rdnAcc") ? $("rdnAcc").value : "";
  if (isNaN(amt) || amt <= 0) { toast("Isi jumlah transfer"); return; }
  if (!accId) { toast("Buat akun dulu di tab Keuangan"); return; }
  if (amt > window.rdnCash()) { toast("Saldo RDN tidak cukup"); return; }
  if (!window.financeAddIncome || !window.financeAddIncome(amt, accId, "Transfer dari RDN", { transfer: true })) { toast("Gagal transfer ke rekening"); return; }
  window.addRdn(-amt);
  $("rdnAmt").value = "";
  toast(`Transfer ${fmtRp(amt)} ke rekening berhasil`);
}

function addHolding() {
  const tk = normTicker($("pfTicker").value);
  const avg = window.parseRp($("pfAvg").value);
  const lots = parseFloat($("pfLots").value);
  if (!tk || isNaN(avg) || avg <= 0 || isNaN(lots) || lots <= 0) { toast("Isi kode, harga rata-rata, & lot dengan benar."); return; }
  const ex = pfState.find((h) => h.ticker === tk);
  if (ex) {  // merge: weighted average
    const totLot = ex.lots + lots;
    ex.avg = (ex.avg * ex.lots + avg * lots) / totLot;
    ex.lots = totLot;
  } else { pfState.push({ ticker: tk, avg, lots }); }
  savePf();
  $("pfTicker").value = $("pfAvg").value = $("pfLots").value = "";
  loadPortfolio();
}
function removeHolding(tk) {
  const prev = pfState.slice();
  pfState = pfState.filter((h) => h.ticker !== tk); savePf();
  if (pfSelected === tk) { pfSelected = null; $("pfDetailCard").classList.add("hidden"); }
  loadPortfolio();
  toastUndo("Saham dihapus dari portofolio.", () => { pfState = prev; savePf(); loadPortfolio(); });
}

async function loadPortfolio() {
  if (!pfState.length) {
    if (window.investmentRefreshStocks) window.investmentRefreshStocks({});
    $("pfSummary").innerHTML = "";
    $("pfTable").innerHTML = "<tbody><tr><td class='empty-row'>Belum ada saham. Tambahkan di atas (kode, harga rata-rata, lot).</td></tr></tbody>";
    $("pfAllocCard").classList.add("hidden");
    $("pfDivCard").classList.add("hidden");
    $("pfDetailCard").classList.add("hidden");
    if ($("perfSummary")) loadPerformance();
    if ($("pvalChart")) loadValueChart();
    if ($("divRecvSummary")) renderDivRecv();
    return;
  }
  $("pfTable").innerHTML = "<tbody><tr><td class='loading'>Memuat & menganalisis…</td></tr></tbody>";
  try {
    const r = await fetch("/api/portfolio", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdings: pfState }),
    });
    pfData = await r.json();
    if (window.investmentRefreshStocks) window.investmentRefreshStocks(pfData.totals || {});
    renderPfSummary(pfData.totals);
    renderPfTable(pfData.holdings);
    renderAllocation(pfData.allocation, pfData.totals.value);
    renderWeightBars(pfData.holdings);
    loadDividends();
    if (pfSelected) showHoldingDetail(pfSelected);
    loadPerformance();
    loadValueChart();
    renderDivRecv();
  } catch {
    $("pfTable").innerHTML = `<tbody><tr><td class='error-row'>Portofolio gagal dimuat. <button type='button' class='btn-secondary' data-retry>Coba lagi</button></td></tr></tbody>`;
    wireRetry($("pfTable"), () => loadPortfolio());
  }
}

function renderPfSummary(t) {
  const plCls = t.pl >= 0 ? "up" : "down";
  const rdn = window.rdnCash ? window.rdnCash() : 0;
  const rdnCards = rdn ? `
    <div class="pf-card"><div class="lbl">Kas RDN</div><div class="val priv">${fmtRp(rdn)}</div></div>
    <div class="pf-card"><div class="lbl">Nilai + Kas RDN</div><div class="val priv">${fmtRp(t.value + rdn)}</div></div>` : "";
  $("pfSummary").innerHTML = `
    <div class="pf-card"><div class="lbl">Nilai Sekarang</div><div class="val priv">${fmtRp(t.value)}</div></div>
    <div class="pf-card"><div class="lbl">Total Modal</div><div class="val priv">${fmtRp(t.cost)}</div></div>
    <div class="pf-card"><div class="lbl">Untung/Rugi</div><div class="val priv ${plCls}">${t.pl >= 0 ? "+" : ""}${fmtRp(t.pl)}<br><span class="tiny">(${fmtPct(t.plPct)})</span></div></div>
    <div class="pf-card"><div class="lbl">Hari Ini</div><div class="val priv ${(t.dayChange || 0) >= 0 ? "up" : "down"}">${(t.dayChange || 0) >= 0 ? "+" : ""}${fmtRp(t.dayChange || 0)}<br><span class="tiny">(${fmtPct(t.dayChangePct || 0)})</span></div></div>
    <div class="pf-card"><div class="lbl">Est. Dividen/Thn</div><div class="val priv">${fmtRp(t.annualDividend)}<br><span class="lbl">yield on cost ${fmtPct(t.divYieldOnCost)}</span></div></div>
    <div class="pf-card"><div class="lbl">Jumlah Saham</div><div class="val">${t.count}</div></div>
    ${rdnCards}`;
}

function renderPfTable(rows) {
  const head = `<thead><tr>
    <th>Saham</th><th>Lot</th><th>Avg</th><th>Harga</th><th>Hari Ini</th><th>Modal</th><th>Nilai</th>
    <th>P/L</th><th>P/L%</th><th>Bobot</th><th>Sinyal</th><th></th></tr></thead>`;
  const body = rows.map((h) => {
    if (h.error) return `<tr data-tk="${escHtml(h.ticker)}"><td>${escHtml(h.ticker.replace(".JK",""))}</td><td>${h.lots}</td><td>${fmt(h.avg)}</td><td colspan="8" class="muted tiny">${escHtml(h.error)}</td><td><button type="button" class="del" data-del="${escHtml(h.ticker)}" aria-label="Hapus ${escHtml(h.ticker)} dari portofolio">✕</button></td></tr>`;
    const plCls = h.pl >= 0 ? "up" : "down";
    const dc = (h.dayChange || 0) >= 0 ? "up" : "down";
    const sig = h.score >= 20 ? "up" : h.score <= -20 ? "down" : "muted";
    const code = escHtml(h.ticker.replace(".JK",""));
    return `<tr data-tk="${escHtml(h.ticker)}">
      <td><span class="drag-handle" title="Geser untuk urutkan" aria-hidden="true">☰</span> <button type="button" class="link-btn pf-open" aria-label="Detail posisi ${code}"><b>${code}</b></button></td>
      <td>${h.lots}</td><td class="priv">${fmt(h.avg)}</td>
      <td>${fmt(h.price)} <span class="tiny ${h.changePct>=0?"up":"down"}">${h.changePct>=0?"+":""}${fmt(h.changePct,2)}%</span></td>
      <td class="priv ${dc}">${(h.dayChange||0)>=0?"+":""}${fmt(h.dayChange||0)}</td>
      <td class="priv">${fmtRp(h.cost)}</td><td class="priv">${fmtRp(h.value)}</td>
      <td class="priv ${plCls}">${h.pl>=0?"+":""}${fmt(h.pl)}</td>
      <td class="${plCls}">${fmt(h.plPct,1)}%</td>
      <td>${fmt(h.weight,1)}%</td>
      <td class="${sig}">${escHtml(h.signal||"-")}</td>
      <td class="pf-act"><button type="button" class="pf-sell" data-sell="${escHtml(h.ticker)}">Jual</button><button type="button" class="del" data-del="${escHtml(h.ticker)}" aria-label="Hapus ${code} dari portofolio">✕</button></td></tr>`;
  }).join("");
  const el = $("pfTable");
  el.innerHTML = head + "<tbody>" + body + "</tbody>";
  el.querySelectorAll("tbody tr").forEach((tr) => {
    tr.onclick = (e) => { if (e.target.closest && e.target.closest(".del, .pf-sell, .drag-handle")) return; showHoldingDetail(tr.dataset.tk); };
  });
  el.querySelectorAll(".del").forEach((x) => { x.onclick = (e) => { e.stopPropagation(); removeHolding(x.dataset.del); }; });
  el.querySelectorAll(".pf-sell").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openSellModal(b.dataset.sell); }; });
  const tb = el.querySelector("tbody");
  if (tb) makeSortable(tb, "tr", (rows) => {
    const order = rows.map((r) => r.dataset.tk);
    const idx = (t) => { const i = order.indexOf(t); return i < 0 ? 999 : i; };
    pfState.sort((a, b) => idx(a.ticker) - idx(b.ticker)); savePf();
    if (pfData && pfData.holdings) pfData.holdings.sort((a, b) => idx(a.ticker) - idx(b.ticker));
  }, ".drag-handle");
}

/* Sell from a Portofolio row (dialog) */
let sellTk = null, sellReturnFocus = null;
function openSellModal(tk) {
  const pos = pfState.find((x) => x.ticker === tk);
  if (!pos) { toast("Saham tidak ditemukan"); return; }
  const h = (pfData && pfData.holdings || []).find((x) => x.ticker === tk);
  sellTk = tk;
  $("sellName").textContent = tk.replace(".JK", "");
  $("sellMax").textContent = pos.lots;
  $("sellLots").value = pos.lots; $("sellLots").max = pos.lots;
  $("sellPrice").value = toMoneyField((h && h.price != null) ? h.price : pos.avg);
  $("sellFee").value = "";
  updateSellEst();
  sellReturnFocus = document.activeElement;
  $("sellModal").hidden = false;
  setTimeout(() => { try { $("sellLots").focus(); $("sellLots").select(); } catch { /* */ } }, 40);
}
function updateSellEst() {
  const lots = parseInt($("sellLots").value, 10), price = window.parseRp($("sellPrice").value), fee = window.parseRp($("sellFee").value) || 0;
  if (isNaN(lots) || isNaN(price)) { $("sellEst").innerHTML = ""; return; }
  const proceeds = lots * 100 * price - fee;
  $("sellEst").innerHTML = `Diterima ke RDN: <b>${fmtRp(proceeds)}</b> · ${lots} lot × ${fmtRp(price)}${fee ? ` − fee ${fmtRp(fee)}` : ""}`;
}
function closeSellModal() {
  $("sellModal").hidden = true; sellTk = null;
  if (sellReturnFocus && sellReturnFocus.isConnected) { try { sellReturnFocus.focus(); } catch { /* */ } }
  sellReturnFocus = null;
}
// Tab stays inside the open dialog; Escape closes it.
function trapDialogKeys(e, box, onClose) {
  if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
  if (e.key !== "Tab") return;
  const items = [...box.querySelectorAll("button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])")]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// Shared accessible confirm dialog: resolves to a boolean.
let confirmReturnFocus = null;
let confirmActive = null;
window.confirmDialog = ({ title = "", text = "", okLabel = "Lanjutkan", danger = false } = {}) => {
  const modal = $("confirmModal");
  if (!modal) return Promise.resolve(window.confirm(text || title));
  const box = modal.querySelector(".modal-box");
  const okBtn = $("confirmOk"), cancelBtn = $("confirmCancel");
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  okBtn.textContent = okLabel;
  okBtn.classList.toggle("is-danger", !!danger);
  confirmReturnFocus = document.activeElement;
  modal.hidden = false;
  return new Promise((resolve) => {
    const finish = (result) => {
      if (confirmActive !== handlers) return;
      confirmActive = null;
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      modal.removeEventListener("keydown", onKey);
      okBtn.classList.remove("is-danger");
      if (confirmReturnFocus && confirmReturnFocus.isConnected) { try { confirmReturnFocus.focus(); } catch { /* */ } }
      confirmReturnFocus = null;
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => { if (e.target === modal) finish(false); };
    const onKey = (e) => trapDialogKeys(e, box, () => finish(false));
    const handlers = { onOk, onCancel, onBackdrop, onKey };
    confirmActive = handlers;
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    modal.addEventListener("keydown", onKey);
    // Focus the safe button (Batal) for destructive actions, otherwise OK.
    setTimeout(() => { try { (danger ? cancelBtn : okBtn).focus(); } catch { /* */ } }, 40);
  });
};
function confirmSell() {
  const pos = pfState.find((x) => x.ticker === sellTk); if (!pos) { closeSellModal(); return; }
  const lots = parseInt($("sellLots").value, 10), price = window.parseRp($("sellPrice").value), fee = window.parseRp($("sellFee").value) || 0;
  if (isNaN(lots) || lots <= 0 || lots > pos.lots) { toast(`Jumlah lot harus 1-${pos.lots}`); return; }
  if (isNaN(price) || price <= 0) { toast("Harga jual tidak valid"); return; }
  // The journal records realized P/L and credits RDN. A position entered by hand in
  // Portofolio may be missing from the journal; then the sale goes straight to RDN.
  const journaled = window.journalAdd ? window.journalAdd("sell", sellTk, lots, price, fee, { skipPortoSync: true, quiet: true }) : false;
  if (!journaled) {
    window.addRdn(lots * 100 * price - fee);
    toast(`Jual ${lots} lot dicatat, ${fmtRp(lots * 100 * price - fee)} masuk RDN. Jurnal tidak diubah karena posisi ini belum tercatat di sana.`);
  }
  pos.lots -= lots;
  if (pos.lots <= 0) pfState = pfState.filter((x) => x.ticker !== sellTk);
  savePf();
  closeSellModal();
  loadPortfolio();
}

/* Kinerja vs IHSG */
async function loadPerformance() {
  const sum = $("perfSummary"); if (!sum) return;
  if (!pfState.length) { sum.innerHTML = ""; $("perfTable").innerHTML = "<tbody><tr><td class='empty-row'>Belum ada saham.</td></tr></tbody>"; return; }
  const rng = $("perfRange").value;
  sum.innerHTML = "<span class='tiny muted'>Menghitung kinerja…</span>";
  try {
    const r = await fetch("/api/portfolio/performance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holdings: pfState, range: rng }) });
    const d = await r.json();
    const sign = (v) => (v >= 0 ? "+" : "");
    const pc = (d.portfolio || 0) >= 0 ? "up" : "down", ic = (d.ihsg || 0) >= 0 ? "up" : "down", dc = (d.delta || 0) >= 0 ? "up" : "down";
    sum.innerHTML = `
      <div class="pf-card"><div class="lbl">Portofolio</div><div class="val ${pc}">${d.portfolio == null ? "-" : sign(d.portfolio) + fmt(d.portfolio, 2) + "%"}</div></div>
      <div class="pf-card"><div class="lbl">IHSG</div><div class="val ${ic}">${d.ihsg == null ? "-" : sign(d.ihsg) + fmt(d.ihsg, 2) + "%"}</div></div>
      <div class="pf-card"><div class="lbl">Selisih</div><div class="val ${dc}">${d.delta == null ? "-" : sign(d.delta) + fmt(d.delta, 2) + "%"}<br><span class="lbl">${(d.delta || 0) >= 0 ? "outperform" : "underperform"}</span></div></div>`;
    const th = `<thead><tr><th>Saham</th><th>Return</th><th>Bobot</th></tr></thead>`;
    const tb = (d.holdings || []).map((h) => `<tr><td><b>${escHtml(h.ticker.replace(".JK", ""))}</b></td>
      <td class="${(h.ret || 0) >= 0 ? "up" : "down"}">${h.ret == null ? "-" : sign(h.ret) + fmt(h.ret, 2) + "%"}</td>
      <td>${fmt(h.weight, 1)}%</td></tr>`).join("");
    $("perfTable").innerHTML = th + "<tbody>" + tb + "</tbody>";
  } catch { sum.innerHTML = "<span class='error-row'>Gagal memuat kinerja.</span>"; }
}

/* Portfolio value chart + invested line */
let pvalChartObj = null;
async function loadValueChart() {
  const el = $("pvalChart"); if (!el) return;
  if (!pfState.length) { if (pvalChartObj) { try { pvalChartObj.remove(); } catch { /* */ } pvalChartObj = null; } el.innerHTML = "<div class='empty-row'>Belum ada saham.</div>"; return; }
  const rng = $("pvalRange") ? $("pvalRange").value : "3mo";
  el.innerHTML = "<div class='skel skel-chart'></div>";
  try {
    const d = await (await fetch("/api/portfolio/valueseries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holdings: pfState, range: rng }) })).json();
    if (!window.LightweightCharts) { el.innerHTML = "<div class='error-row'>Library grafik gagal dimuat (perlu internet).</div>"; return; }
    if (!d.series || !d.series.length) { el.innerHTML = "<div class='empty-row'>Data grafik tak tersedia.</div>"; return; }
    el.innerHTML = "";
    const cc = window.chartColors();
    if (pvalChartObj) { try { pvalChartObj.remove(); } catch { /* */ } pvalChartObj = null; }
    const ch = LightweightCharts.createChart(el, {
      layout: { background: { color: cc.bg }, textColor: cc.text },
      grid: { vertLines: { color: cc.grid }, horzLines: { color: cc.grid } },
      rightPriceScale: { borderColor: cc.grid }, timeScale: { borderColor: cc.grid }, autoSize: true, height: 340,
      localization: { priceFormatter: (p) => fmt(p) },
    });
    const last = d.series[d.series.length - 1].value;
    const up = last >= d.invested;
    const tone = up ? cc.up : cc.down;
    const area = ch.addAreaSeries({ lineColor: tone, topColor: tone + "44", bottomColor: tone + "00", lineWidth: 2, priceLineVisible: false });
    area.setData(d.series);
    if (d.invested > 0) area.createPriceLine({ price: d.invested, color: cc.text, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Modal" });
    ch.timeScale().fitContent();
    fitChartOnResize(ch, el);
    pvalChartObj = ch;
  } catch { el.innerHTML = "<div class='error-row'>Gagal memuat grafik.</div>"; }
}

/* Dividen diterima (aktual) */
const DIV_KEY = "mc_dividends";
const divUid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const loadDiv = () => { try { return JSON.parse(localStorage.getItem(DIV_KEY)) || []; } catch { return []; } };
const saveDivList = (a) => localStorage.setItem(DIV_KEY, JSON.stringify(a));
function todayStr() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function renderDivRecv() {
  const sel = $("divDest");
  if (sel) {
    const accs = window.financeAccounts ? window.financeAccounts() : [];
    const prev = sel.value;
    sel.innerHTML = `<option value="rdn">Kas RDN</option>` + accs.map((a) => `<option value="acc:${escHtml(a.id)}">${escHtml(a.name)}</option>`).join("");
    if (prev) sel.value = prev;
  }
  if ($("divDate") && !$("divDate").value) $("divDate").value = todayStr();
  const list = loadDiv(), yr = String(new Date().getFullYear());
  const totalYear = list.filter((d) => (d.date || "").startsWith(yr)).reduce((s, d) => s + (+d.amount || 0), 0);
  const totalAll = list.reduce((s, d) => s + (+d.amount || 0), 0);
  const modal = (pfData && pfData.totals) ? pfData.totals.cost : 0;
  const yieldReal = modal ? totalYear / modal * 100 : 0;
  $("divRecvSummary").innerHTML = `
    <div class="pf-card"><div class="lbl">Dividen ${yr}</div><div class="val priv">${fmtRp(totalYear)}</div></div>
    <div class="pf-card"><div class="lbl">Total Diterima</div><div class="val priv">${fmtRp(totalAll)}</div></div>
    <div class="pf-card"><div class="lbl">Yield Riil (${yr})</div><div class="val">${fmt(yieldReal, 2)}%<br><span class="lbl">÷ modal portofolio</span></div></div>`;
  const rows = list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const th = `<thead><tr><th>Tgl</th><th>Saham</th><th>Jumlah</th><th>Masuk ke</th><th></th></tr></thead>`;
  const tb = rows.length ? rows.map((d) => `<tr><td>${escHtml(d.date)}</td><td>${escHtml((d.ticker || "-").replace(".JK", ""))}</td><td>${fmtRp(d.amount)}</td><td>${escHtml(d.destName || "RDN")}</td><td><button type="button" class="del div-del" data-id="${escHtml(d.id)}" aria-label="Hapus catatan dividen">✕</button></td></tr>`).join("")
    : "<tr><td colspan='5' class='empty-row'>Belum ada catatan dividen.</td></tr>";
  $("divRecvTable").innerHTML = th + "<tbody>" + tb + "</tbody>";
  $("divRecvTable").querySelectorAll(".div-del").forEach((b) => b.onclick = () => { const prev = loadDiv(); saveDivList(prev.filter((x) => x.id !== b.dataset.id)); renderDivRecv(); toastUndo("Catatan dividen dihapus.", () => { saveDivList(prev); renderDivRecv(); }); });
}
function addDivRecv() {
  const tk = normTicker($("divTicker").value);
  const amount = window.parseRp($("divAmount").value);
  const dest = $("divDest").value, date = $("divDate").value || todayStr();
  if (isNaN(amount) || amount <= 0) { toast("Isi jumlah dividen diterima"); return; }
  let destName = "Kas RDN";
  if (dest === "rdn") { if (window.addRdn) window.addRdn(amount); }
  else if (dest && dest.indexOf("acc:") === 0) {
    const id = dest.slice(4); const accs = window.financeAccounts ? window.financeAccounts() : [];
    const a = accs.find((x) => x.id === id); destName = a ? a.name : "Rekening";
    if (window.financeAddIncome) window.financeAddIncome(amount, id, "Dividen" + (tk ? " " + tk.replace(".JK", "") : ""));
  }
  const list = loadDiv(); list.push({ id: divUid(), date, ticker: tk, amount, dest, destName });
  saveDivList(list);
  $("divTicker").value = ""; $("divAmount").value = "";
  renderDivRecv();
  if (window.financeRender) { try { window.financeRender(); } catch { /* */ } }
  toast(`Dividen ${fmtRp(amount)} dicatat`);
}

// Allocation shades: ink mixed into the page colour, 100% down to 25%.
function pfShade(i, n) {
  const pct = n > 1 ? Math.round(100 - (75 * i) / (n - 1)) : 100;
  return `color-mix(in srgb, var(--ink) ${pct}%, var(--bg))`;
}

function renderAllocation(alloc, totalValue) {
  const card = $("pfAllocCard");
  if (!alloc || !alloc.length) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  let acc = 0; const segs = [];
  alloc.forEach((a, i) => {
    const c = pfShade(i, alloc.length);
    const start = acc; acc += a.weight;
    segs.push(`${c} ${start}% ${acc}%`);
  });
  $("pfDonut").style.background = `conic-gradient(${segs.join(",")})`;
  $("pfDonutTotal").textContent = fmtBig(totalValue);
  $("pfAllocLegend").innerHTML = alloc.map((a, i) => {
    const c = pfShade(i, alloc.length);
    return `<div class="legend-item"><span class="dot" style="background:${c}"></span>
      <span class="nm">${escHtml(a.name)}</span><span class="pc">${fmt(a.weight, 1)}%</span>
      <span class="vl priv">${fmtRp(a.value)}</span></div>`;
  }).join("");
}

function renderWeightBars(holdings) {
  const rows = holdings.filter((h) => !h.error && h.value).sort((a, b) => b.weight - a.weight);
  $("pfWeightBars").innerHTML = rows.map((h, i) => {
    const c = pfShade(i, rows.length);
    return `<div class="wbar"><span class="wbar-label">${escHtml(h.ticker.replace(".JK", ""))}</span>
      <span class="wbar-track"><span class="wbar-fill" style="width:${Math.max(2, h.weight)}%;background:${c}"></span></span>
      <span class="wbar-val">${fmt(h.weight, 1)}%</span></div>`;
  }).join("");
}

let pfDivData = null;
async function loadDividends() {
  if (!pfState.length) { $("pfDivCard").classList.add("hidden"); return; }
  try {
    const r = await fetch("/api/dividends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holdings: pfState }) });
    pfDivData = await r.json();
    renderDividends(pfDivData);
  } catch { $("pfDivCard").classList.add("hidden"); }
}
function renderDividends(d) {
  if (!d || !d.rows || !d.rows.length) { $("pfDivCard").classList.add("hidden"); return; }
  $("pfDivCard").classList.remove("hidden");
  $("pfDivTotals").innerHTML = `
    <div class="pf-card"><div class="lbl">Estimasi Dividen/Tahun</div><div class="val priv up">${fmtRp(d.totalAnnual)}</div></div>
    <div class="pf-card"><div class="lbl">Rata-rata/Bulan</div><div class="val priv">${fmtRp(d.monthlyAvg)}</div></div>
    <div class="pf-card"><div class="lbl">Ex-date Mendatang</div><div class="val">${d.upcoming.length}</div></div>`;
  const head = `<thead><tr><th>Saham</th><th>Lot</th><th>DPS/thn</th><th>Dividen/thn</th><th>YoC</th><th>Ex-date</th></tr></thead>`;
  const body = d.rows.map((r) => `<tr>
    <td><b>${escHtml(r.ticker.replace(".JK", ""))}</b></td><td>${r.lots}</td>
    <td>${fmtRp(r.dps)}</td><td class="up priv">${fmtRp(r.annual)}</td>
    <td>${r.yieldOnCost != null ? fmt(r.yieldOnCost, 1) + "%" : "-"}</td>
    <td>${r.exDate ? `${escHtml(r.exDate)} ${r.exFuture ? '<span class="badge b-low">mendatang</span>' : '<span class="tiny muted">terakhir</span>'}` : "-"}</td></tr>`).join("");
  $("pfDivTable").innerHTML = head + "<tbody>" + body + "</tbody>";
  const accs = window.financeAccounts ? window.financeAccounts() : [];
  $("pfDivAcc").innerHTML = accs.length ? accs.map((a) => `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`).join("") : "<option value=''>(buat akun di Keuangan)</option>";
  renderAgenda(d.rows);
}
function renderAgenda(rows) {
  const card = $("pfAgendaCard"); if (!card) return;
  const ag = (rows || []).filter((r) => r.exDate).slice().sort((a, b) => (a.exDate || "").localeCompare(b.exDate || ""));
  if (!ag.length) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const today = todayStr();
  $("pfAgenda").innerHTML = ag.map((r) => {
    const fut = r.exFuture || (r.exDate >= today);
    const days = Math.round((new Date(r.exDate) - new Date(today)) / 86400000);
    const when = fut ? (days <= 0 ? "hari ini" : `dalam ${days} hari`) : "sudah lewat";
    return `<div class="agenda-item">
      <span><b>${escHtml(r.ticker.replace(".JK", ""))}</b> <span class="tiny muted">${escHtml(r.exDate)}</span></span>
      <span class="ag-when ${fut ? "up" : "muted"}">${when}${fut ? ' · <span class="badge b-low">ex-div</span>' : ""}</span></div>`;
  }).join("");
}

/* Compare stocks */
const CMP_KEY = "mc_compare";
function cmpList() { try { return JSON.parse(localStorage.getItem(CMP_KEY)) || []; } catch { return []; } }
function cmpSave(a) { localStorage.setItem(CMP_KEY, JSON.stringify(a)); }
function cmpAdd() {
  const tk = normTicker($("cmpInput").value); if (!tk) { toast("Isi kode saham"); return; }
  const l = cmpList();
  if (l.includes(tk)) { toast("Sudah ada di perbandingan"); return; }
  if (l.length >= 4) { toast("Maksimal 4 saham"); return; }
  l.push(tk); cmpSave(l); $("cmpInput").value = ""; renderCompare();
}
async function renderCompare() {
  const tbl = $("cmpTable"); if (!tbl) return;
  const tks = cmpList();
  if (!tks.length) { tbl.innerHTML = "<tbody><tr><td class='tiny muted'>Tambahkan kode saham untuk membandingkan berdampingan.</td></tr></tbody>"; return; }
  tbl.innerHTML = "<tbody><tr><td class='loading'>Memuat…</td></tr></tbody>";
  try {
    const d = await (await fetch("/api/compare?tickers=" + encodeURIComponent(tks.join(",")))).json();
    const items = d.items || [];
    const rows = [
      ["Harga", (it) => it.error ? "-" : fmt(it.price)],
      ["Hari ini", (it) => it.error ? "-" : `<span class="${it.changePct >= 0 ? "up" : "down"}">${it.changePct >= 0 ? "+" : ""}${fmt(it.changePct, 2)}%</span>`],
      ["PER", (it) => it.per != null ? fmt(it.per, 1) : "-"],
      ["PBV", (it) => it.pbv != null ? fmt(it.pbv, 2) : "-"],
      ["ROE", (it) => it.roe != null ? fmt(it.roe, 1) + "%" : "-"],
      ["Div Yield", (it) => it.dividendYield != null ? fmt(it.dividendYield, 2) + "%" : "-"],
      ["Target analis", (it) => it.targetMean != null ? fmt(it.targetMean) : "-"],
      ["Sinyal", (it) => escHtml(it.signal || "-")],
      ["Sektor", (it) => escHtml(it.sector || "-")],
    ];
    const head = `<thead><tr><th>Metrik</th>${items.map((it) => `<th>${escHtml((it.ticker || "").replace(".JK", ""))} <button type="button" class="del cmp-del" data-tk="${escHtml(it.ticker)}" title="Hapus dari perbandingan" aria-label="Hapus ${escHtml(it.ticker)} dari perbandingan">✕</button></th>`).join("")}</tr></thead>`;
    const body = rows.map(([lbl, fn]) => `<tr><td><b>${lbl}</b></td>${items.map((it) => `<td>${fn(it)}</td>`).join("")}</tr>`).join("");
    tbl.innerHTML = head + "<tbody>" + body + "</tbody>";
    tbl.querySelectorAll(".cmp-del").forEach((b) => b.onclick = () => { cmpSave(cmpList().filter((t) => t !== b.dataset.tk)); renderCompare(); });
  } catch { tbl.innerHTML = "<tbody><tr><td class='error-row'>Gagal memuat perbandingan.</td></tr></tbody>"; }
}
$("pfDivAddBtn").onclick = () => {
  if (!pfDivData || !pfDivData.totalAnnual) { toast("Belum ada estimasi dividen"); return; }
  const acc = $("pfDivAcc").value; if (!acc) { toast("Buat akun di tab Keuangan dulu"); return; }
  const monthly = Math.round(pfDivData.monthlyAvg);
  if (window.financeAddRecurring && window.financeAddRecurring("in", monthly, acc, "Dividen (estimasi)")) {
    toast(`Pemasukan rutin dividen ${fmtRp(monthly)}/bln ditambahkan ke Keuangan`);
  } else toast("Gagal menambah ke Keuangan");
};

function showHoldingDetail(tk) {
  if (!pfData) return;
  const h = pfData.holdings.find((x) => x.ticker === tk);
  if (!h) return;
  pfSelected = tk;
  document.querySelectorAll("#pfTable tbody tr").forEach((tr) => tr.classList.toggle("active", tr.dataset.tk === tk));
  $("pfDetailCard").classList.remove("hidden");
  $("pfDetailName").textContent = `${h.name} (${tk.replace(".JK","")})`;
  if (h.error) { $("pfDetail").textContent = `Data tidak tersedia: ${h.error}`; return; }
  const box = (l, v, priv) => `<div class="box"><div class="lbl">${l}</div><div class="v${priv ? " priv" : ""}">${v}</div></div>`;
  const plCls = h.pl >= 0 ? "up" : "down";
  $("pfDetail").innerHTML = `
    <div class="pf-detail-grid">
      ${box("Posisi", `${h.lots} lot (${fmt(h.shares)} lembar)`)}
      ${box("Harga rata-rata", fmtRp(h.avg), true)}
      ${box("Harga sekarang", fmtRp(h.price))}
      ${box("Modal", fmtRp(h.cost), true)}
      ${box("Nilai sekarang", fmtRp(h.value), true)}
      ${box("Untung/Rugi", `<span class="${plCls}">${h.pl>=0?"+":""}${fmtRp(h.pl)} (${fmtPct(h.plPct)})</span>`, true)}
      ${box("Bobot portofolio", fmtPct(h.weight))}
      ${box("Sinyal teknikal", `${escHtml(h.signal)} (skor ${escHtml(h.score)})`)}
      ${box("PER / PBV", `${num(h.per)} / ${num(h.pbv)}`)}
      ${box("ROE", fmtPct(h.roe))}
      ${box("Div/saham (DPS)", fmtRp(h.dps))}
      ${box("Est. dividen/thn", `${fmtRp(h.annualDividend)} ${h.yieldOnCost!=null?`(yoC ${fmtPct(h.yieldOnCost)})`:""}`, true)}
      ${box("Target analis", h.targetMean?`${fmtRp(h.targetMean)} (${h.targetUpside>=0?"+":""}${fmt(h.targetUpside,1)}%)`:"-")}
    </div>
    ${pfNotes(h)}`;
  $("pfAiOut").classList.add("hidden");
}

function pfNotes(h) {
  const n = [];
  n.push(h.pl >= 0
    ? `Posisi <span class="up">untung ${fmtPct(h.plPct)}</span> (<span class="priv">${fmtRp(h.pl)}</span>).`
    : `Posisi <span class="down">rugi ${fmtPct(h.plPct)}</span> (<span class="priv">${fmtRp(h.pl)}</span>).`);
  n.push(`Sinyal teknikal saat ini: <b>${escHtml(h.signal)}</b> (skor ${escHtml(h.score)}). ${h.score>=20?"momentum cenderung positif":h.score<=-20?"momentum cenderung negatif":"momentum netral"}.`);
  if (h.targetMean) n.push(h.targetUpside >= 0
    ? `Harga (${fmtRp(h.price)}) masih <b>di bawah</b> rata-rata target analis ${fmtRp(h.targetMean)} (potensi upside ${fmt(h.targetUpside,1)}% menurut konsensus).`
    : `Harga sudah <b>di atas</b> rata-rata target analis ${fmtRp(h.targetMean)} (${fmt(h.targetUpside,1)}%).`);
  if (h.yieldOnCost != null) n.push(`Yield dividen atas modal Anda (yield on cost): <b>${fmtPct(h.yieldOnCost)}</b>.`);
  if (h.pbv != null && h.roe != null) n.push(`Valuasi PBV ${num(h.pbv)} dengan ROE ${fmtPct(h.roe)} - bandingkan dengan rata-rata historis/peers.`);
  return `<div class="pf-notes"><b>Catatan otomatis:</b><ul>${n.map(x=>`<li>${x}</li>`).join("")}</ul>
    <span class="tiny warn">Observasi, BUKAN rekomendasi. Keputusan & risiko di tangan Anda.</span></div>`;
}

async function pfAiAnalyze() {
  if (!pfSelected || !pfData) return;
  const h = pfData.holdings.find((x) => x.ticker === pfSelected);
  if (!h || h.error) return;
  const out = $("pfAiOut"); out.classList.remove("hidden", "muted"); out.textContent = "Menganalisis posisi…";
  const ctx = {
    ticker: h.ticker,
    holding: { lots: h.lots, shares: h.shares, avg: h.avg, cost: h.cost, value: h.value, pl: h.pl, plPct: h.plPct, weight: h.weight },
    price: h.price,
    signals: { label: h.signal, score: h.score },
    fundamentals: { per: h.per, pbv: h.pbv, roe: h.roe, dividendYield: h.dividendYield, dps: h.dps, targetMean: h.targetMean },
  };
  const q = `Saya memegang ${h.lots} lot ${h.ticker.replace(".JK","")} di harga rata-rata ${h.avg} (modal ${Math.round(h.cost)}). `
    + `Harga sekarang ${h.price} → posisi ${h.pl>=0?"untung":"rugi"} ${(h.plPct ?? 0).toFixed(1)}%. `
    + `Berdasarkan teknikal, fundamental, dan posisi saya, beri analisis & hal yang perlu dipertimbangkan (objektif, sebutkan sisi positif & risiko). Ini bukan rekomendasi.`;
  try {
    const d = await (await fetch("/api/ai/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: ctx, question: q }),
    })).json();
    out.textContent = d.text || d.error || "Tidak ada jawaban.";
    if (d.enabled === false && d.hint) out.textContent += "\n\n" + d.hint;
  } catch (e) { out.textContent = "Gagal: " + e.message; }
}

$("pfAddBtn").onclick = addHolding;
$("pfRefreshBtn").onclick = loadPortfolio;
$("pfAiBtn").onclick = pfAiAnalyze;
["pfTicker", "pfAvg", "pfLots"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") addHolding(); }));
if ($("rdnSave")) $("rdnSave").onclick = () => saveRdn(false);
if ($("rdnClear")) $("rdnClear").onclick = () => saveRdn(true);
if ($("rdnInput")) $("rdnInput").addEventListener("keydown", (e) => { if (e.key === "Enter") saveRdn(false); });
if ($("rdnTransfer")) $("rdnTransfer").onclick = transferRdn;
if ($("rdnAmt")) $("rdnAmt").addEventListener("keydown", (e) => { if (e.key === "Enter") transferRdn(); });
if ($("sellConfirm")) $("sellConfirm").onclick = confirmSell;
if ($("sellCancel")) $("sellCancel").onclick = closeSellModal;
["sellLots", "sellPrice", "sellFee"].forEach((id) => { if ($(id)) $(id).addEventListener("input", updateSellEst); });
if ($("sellModal")) $("sellModal").addEventListener("click", (e) => { if (e.target.id === "sellModal") closeSellModal(); });
if ($("sellModal")) $("sellModal").addEventListener("keydown", (e) => trapDialogKeys(e, $("sellModal"), closeSellModal));
["sellLots", "sellPrice", "sellFee"].forEach((id) => { if ($(id)) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") confirmSell(); }); });
if ($("perfRange")) $("perfRange").onchange = loadPerformance;
if ($("pvalRange")) $("pvalRange").onchange = loadValueChart;
if ($("divAdd")) $("divAdd").onclick = addDivRecv;
if ($("divAmount")) $("divAmount").addEventListener("keydown", (e) => { if (e.key === "Enter") addDivRecv(); });
if ($("cmpAdd")) $("cmpAdd").onclick = cmpAdd;
if ($("cmpClear")) $("cmpClear").onclick = () => { cmpSave([]); renderCompare(); };
if ($("cmpInput")) $("cmpInput").addEventListener("keydown", (e) => { if (e.key === "Enter") cmpAdd(); });
window.__syncStatus = function (s) {
  const c = $("syncChip"); if (!c) return;
  c.classList.remove("saving", "offline", "error");
  const txt = c.querySelector(".sync-txt");
  const label = {
    saving: "Menyimpan…", offline: "Offline, dicoba lagi", error: "Gagal tersimpan",
    unavailable: "Server bermasalah", stale: "Data baru, memuat ulang…",
  }[s] || "Tersimpan";
  if (s === "saving" || s === "stale") c.classList.add("saving");
  if (s === "offline" || s === "error" || s === "unavailable") c.classList.add(s === "unavailable" ? "error" : s);
  if (txt) txt.textContent = label;
  c.title = s === "error" ? "Server menolak perubahan terakhir. Data tetap tersimpan di perangkat ini."
    : s === "unavailable" ? "Data di server tidak dapat dibaca. Perubahan disimpan di perangkat ini sampai server pulih."
    : `Status sinkronisasi: ${label}`;
  if (s === "error") toast("Perubahan terakhir ditolak server. Data tetap tersimpan di perangkat ini.");
};
if (!navigator.onLine) window.__syncStatus("offline");

/* MA / INDIKATOR */
// lightweight-charts lineStyle: 0 solid, 1 dotted, 2 dashed, 3 large dashed.
const MA_STYLES = {
  5: { color: "ink", lineStyle: 0 }, 10: { color: "muted", lineStyle: 0 }, 20: { color: "ink", lineStyle: 2 },
  50: { color: "muted", lineStyle: 2 }, 100: { color: "ink", lineStyle: 3 }, 200: { color: "muted", lineStyle: 1 },
};
const LEGEND_DASH = ["solid", "dotted", "dashed", "dashed"];
const MA_KEY = "saham_ma_v1";
function getMaSettings() {
  let s = null; try { s = JSON.parse(localStorage.getItem(MA_KEY)); } catch { /* */ }
  if (!s || typeof s !== "object") s = {};
  const periods = {};
  [5, 10, 20, 50, 100, 200].forEach((p) => { periods[p] = !!(s.periods && s.periods[p]); });
  if (!s.periods) { periods[20] = true; periods[50] = true; }   // default MA20 + MA50
  return { periods, type: s.type === "EMA" ? "EMA" : "SMA", bb: s.bb !== false };
}
function saveMaSettings(s) { localStorage.setItem(MA_KEY, JSON.stringify(s)); }
function smaSeries(candles, period) {
  const out = [], q = []; let sum = 0;
  for (const c of candles) { q.push(c.close); sum += c.close; if (q.length > period) sum -= q.shift(); if (q.length === period) out.push({ time: c.time, value: +(sum / period).toFixed(4) }); }
  return out;
}
function emaSeries(candles, period) {
  const out = [], k = 2 / (period + 1); let ema = null;
  candles.forEach((c, i) => { ema = i === 0 ? c.close : c.close * k + ema * (1 - k); if (i >= period - 1) out.push({ time: c.time, value: +ema.toFixed(4) }); });
  return out;
}
function renderLegend(items) {
  const el = $("chartLegend"); if (!el) return;
  el.innerHTML = items.map((it) => {
    const sw = it.type === "box" ? `<span class="leg-box" style="background:${it.color}"></span>`
      : `<span class="leg-line" style="border-top:2px ${LEGEND_DASH[it.dash || 0]} ${it.color}"></span>`;
    return `<span class="leg-item">${sw}${it.label}</span>`;
  }).join("");
}
function onMaChange() {
  const periods = {};
  document.querySelectorAll(".ma-settings input[data-ma]").forEach((inp) => { periods[inp.dataset.ma] = inp.checked; });
  saveMaSettings({ periods, type: $("emaChk").checked ? "EMA" : "SMA", bb: $("bbChk").checked });
  if (lastChartData) renderCharts(lastChartData);
}
function initMaControls() {
  const s = getMaSettings();
  document.querySelectorAll(".ma-settings input[data-ma]").forEach((inp) => { inp.checked = s.periods[inp.dataset.ma]; inp.onchange = onMaChange; });
  $("bbChk").checked = s.bb; $("bbChk").onchange = onMaChange;
  $("emaChk").checked = s.type === "EMA"; $("emaChk").onchange = onMaChange;
}

/* Admin password, session, splash */
let adminStatus = { configured: false, source: null, is_admin: false };

async function loadAdminStatus() {
  try {
    const r = await fetch("/api/admin/status", { cache: "no-store" });
    if (!r.ok) throw new Error();
    adminStatus = await r.json();
  } catch { adminStatus = { configured: false, source: null, is_admin: window.__authRole === "admin" }; }
  updateAdminSettings();
}
function updateAdminSettings() {
  const isAdmin = adminStatus.is_admin || window.__authRole === "admin";
  const status = $("adminStatus");
  if (status) {
    status.textContent = !adminStatus.configured
      ? "Belum diatur. Tambahkan password administrator di file .env server, lalu jalankan ulang server."
      : adminStatus.source === "env"
        ? "Aktif, diatur di file .env server. Ubah di sana bila ingin mengganti."
        : isAdmin ? "Aktif. Anda masuk sebagai administrator." : "Aktif. Hanya sesi administrator yang dapat mengubahnya.";
  }
  const form = $("adminPassForm");
  if (form) form.hidden = !(isAdmin && adminStatus.configured && adminStatus.source !== "env");
  // An administrator may reset the owner password without the old one.
  const cur = $("ownerCurrentField"); if (cur) cur.hidden = isAdmin;
  const info = $("sessionInfo");
  if (info) info.textContent = `Masuk sebagai ${isAdmin ? "administrator" : "pemilik"}. Sesi berlaku 12 jam di browser ini.`;
}
function setFormMsg(id, text, ok) {
  const el = $(id); if (!el) return;
  el.textContent = text; el.classList.toggle("is-error", !ok); el.classList.toggle("is-ok", !!ok);
}
if ($("adminPassForm")) $("adminPassForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const current = $("adminPassCurrent").value, next = $("adminPassSetting").value;
  if (next.length < 8) { setFormMsg("adminPassMsg", "Password baru minimal 8 karakter.", false); return; }
  try {
    const r = await fetch("/api/admin/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: current, new_password: next }) });
    const d = await r.json();
    setFormMsg("adminPassMsg", d.message || d.error || (r.ok ? "Tersimpan." : "Gagal menyimpan."), r.ok && d.success);
    if (r.ok && d.success) { $("adminPassCurrent").value = ""; $("adminPassSetting").value = ""; loadAdminStatus(); }
  } catch { setFormMsg("adminPassMsg", "Server tidak dapat dihubungi.", false); }
});
if ($("logoutBtn")) $("logoutBtn").onclick = async () => {
  try { if (window.__syncFlush) await window.__syncFlush(); } catch { /* */ }
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* */ }
  location.replace("/");
};
function hideSplash() { const s = $("splash"); if (!s) return; s.classList.add("hide"); setTimeout(() => { try { s.remove(); } catch { /* */ } }, 450); }

/* PROFIL + BRANDING + PASSWORD */
const PROF_KEY = "saham_profile";
const DEFAULT_LOGO = "/static/icon-192.png";
function getProfile() { try { return JSON.parse(localStorage.getItem(PROF_KEY)) || {}; } catch { return {}; } }
function saveProfile(patch) { const p = { ...getProfile(), ...patch }; localStorage.setItem(PROF_KEY, JSON.stringify(p)); return p; }
/* The app name is a server setting (data/app.json), rendered into the page head. */
function brandName() {
  const meta = document.querySelector('meta[name="application-name"]');
  return (meta && meta.content) || "Dashboard Saham";
}
function profileLogo() { return getProfile().logo || DEFAULT_LOGO; }
function profileAvatar() { return getProfile().avatar || ""; }
/* Logo and profile photo are shrunk because they sync through the state. */
function compressImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error("no file")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxSize / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const type = file.type === "image/png" ? "image/png" : "image/jpeg";  // keep PNG transparency
        try { resolve(c.toDataURL(type, quality || 0.85)); } catch (e) { reject(e); }
      };
      img.onerror = reject; img.src = reader.result;
    };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}
function applyBrand(name) {
  const b = name || brandName();
  const meta = document.querySelector('meta[name="application-name"]'); if (meta) meta.content = b;
  document.title = b;
  document.querySelectorAll(".brand-title").forEach((e) => e.textContent = b);
  const ab = $("aboutBrand"); if (ab) ab.textContent = b;
}
/* sub-menu Pengaturan */
function setSettingsPane(name) {
  document.querySelectorAll(".set-navbtn").forEach((b) => {
    const on = b.dataset.pane === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".set-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== name));
  if (name === "tataletak" && typeof renderLayoutSettings === "function") renderLayoutSettings();
  if (name === "keamanan") loadAdminStatus();
}
document.querySelectorAll(".set-navbtn").forEach((b) => { b.onclick = () => setSettingsPane(b.dataset.pane); });
function applyAvatar() {
  const btn = $("avatarBtn"); if (!btn) return;
  const av = profileAvatar(); const initial = (getProfile().name || brandName()).trim().charAt(0).toUpperCase() || "?";
  if (av) { btn.innerHTML = `<img src="${escHtml(av)}" alt="">`; btn.classList.remove("noimg"); }
  else { btn.innerHTML = `<span aria-hidden="true">${escHtml(initial)}</span>`; btn.classList.add("noimg"); }
  btn.setAttribute("aria-label", "Profil dan pengaturan");
}
/* An uploaded logo becomes the tab icon; without one the page's own icons stay. */
function applyFavicon(logo) {
  document.querySelectorAll('link[rel~="icon"]').forEach((link) => {
    if (!link.dataset.defaultHref) {
      link.dataset.defaultHref = link.getAttribute("href");
      link.dataset.defaultType = link.getAttribute("type") || "";
    }
    if (logo) { link.href = logo; link.removeAttribute("type"); }
    else {
      link.href = link.dataset.defaultHref;
      if (link.dataset.defaultType) link.setAttribute("type", link.dataset.defaultType);
    }
  });
}
function applyProfile() {
  const p = getProfile();
  if ($("profName")) $("profName").value = p.name || "";
  if ($("brandName")) $("brandName").value = brandName();
  const logo = profileLogo();
  applyFavicon(p.logo);
  if ($("logoPreview")) $("logoPreview").src = logo;
  const ap = $("avatarPreview"); if (ap) { const av = profileAvatar(); if (av) ap.src = av; ap.hidden = !av; }
  applyAvatar();
  applyBrand();
}
$("profSave").onclick = async () => {
  // The display name stays in the synced profile; the app name is saved on the server.
  saveProfile({ name: $("profName").value.trim().slice(0, 40), brand: undefined });
  try {
    const response = await fetch("/api/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("brandName").value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Gagal menyimpan nama aplikasi.");
    applyBrand(data.name);
    applyProfile(); toast("Profil & nama aplikasi disimpan");
  } catch (error) { applyProfile(); toast(error.message || "Gagal menyimpan nama aplikasi."); }
};
/* upload logo / foto profil di Pengaturan */
function wireImageUpload(inputId, key, maxSize) {
  const inp = $(inputId); if (!inp) return;
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    try { saveProfile({ [key]: await compressImage(f, maxSize, 0.85) }); applyProfile(); toast("Gambar disimpan & tersinkron"); }
    catch { toast("Gagal memproses gambar"); }
    inp.value = "";
  };
}
wireImageUpload("logoFile", "logo", 256);
wireImageUpload("avatarFile", "avatar", 256);
if ($("logoRemove")) $("logoRemove").onclick = () => { saveProfile({ logo: "" }); applyProfile(); toast("Logo dikembalikan ke default"); };
if ($("avatarRemove")) $("avatarRemove").onclick = () => { saveProfile({ avatar: "" }); applyProfile(); toast("Foto profil dihapus"); };
if ($("avatarBtn")) $("avatarBtn").onclick = () => gotoTab("profil");
$("ownerPassForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = $("newPass").value, p2 = $("newPass2").value;
  const current = $("ownerPassCurrent") ? $("ownerPassCurrent").value : "";
  if (p1.length < 8) { setFormMsg("passMsg", "Password baru minimal 8 karakter.", false); return; }
  if (p1 !== p2) { setFormMsg("passMsg", "Kedua password baru tidak sama.", false); return; }
  try {
    const response = await fetch("/api/auth/owner/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: current, new_password: p1 }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Gagal mengubah password.");
    ["ownerPassCurrent", "newPass", "newPass2"].forEach((id) => { if ($(id)) $(id).value = ""; });
    setFormMsg("passMsg", "Password pemilik diubah.", true);
  } catch (error) { setFormMsg("passMsg", error.message || "Gagal mengubah password.", false); }
});

/* TEMA */
const THEMES = [
  { k: "default", n: "Hitam", c: ["var(--swatch-hitam)", "var(--swatch-putih)"] },
  { k: "light", n: "Putih", c: ["var(--swatch-putih)", "var(--swatch-hitam)"] },
];
const THEME_KEY = "mc_theme";
function applyTheme(k, fromUser) {
  k = window.UiPrefs.normalizeTheme(k);
  // The theme lives on <html> (set before first paint by theme-boot.js) and on body.
  [document.documentElement, document.body].forEach((el) => {
    if (k === "light") el.dataset.theme = k; else delete el.dataset.theme;
  });
  // At boot only an old saved value is converted: before sync has the server copy,
  // saving the default would overwrite the theme chosen on another device.
  const stored = localStorage.getItem(THEME_KEY);
  if (fromUser || (stored !== null && stored !== k)) localStorage.setItem(THEME_KEY, k);
  document.querySelectorAll(".theme-card").forEach((c) => {
    const active = c.dataset.k === (k || "default");
    c.classList.toggle("active", active);
    c.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const tm = document.querySelector('meta[name="theme-color"]'); if (tm) tm.setAttribute("content", getComputedStyle(document.body).getPropertyValue("--bg").trim());
  if (fromUser) {  // charts take their colours when built, so rebuild every live one
    if (lastChartData) renderCharts(lastChartData);
    if (window.financeRender) window.financeRender();
    if (window.marketReload) window.marketReload();
    if (pvalChartObj) loadValueChart();
  }
}
function renderThemeGrid() {
  const cur = localStorage.getItem(THEME_KEY) || "default";
  $("themeGrid").innerHTML = THEMES.map((t) => `
    <button type="button" class="theme-card${t.k === cur ? " active" : ""}" data-k="${t.k}" aria-pressed="${t.k === cur ? "true" : "false"}">
      <div class="sw"><i style="background:${t.c[0]}"></i><i style="background:${t.c[1]}"></i></div>
      <div class="tn">${t.n}</div></button>`).join("");
  $("themeGrid").querySelectorAll(".theme-card").forEach((c) => c.onclick = () => applyTheme(c.dataset.k, true));
}
// Chart colours follow the active theme tokens. Tokens are 6-digit hex, so
// callers may append an alpha pair (cc.up + "44").
window.chartColors = () => {
  const s = getComputedStyle(document.body);
  const g = (name) => s.getPropertyValue(name).trim();
  return {
    bg: g("--bg"), grid: g("--rule-soft"), text: g("--muted"), up: g("--up"), down: g("--down"),
    ink: g("--ink"), muted: g("--muted"), warn: g("--warn"),
  };
};

/* Ukuran teks */
const FONT_SIZE_KEY = "mc_font_size";
const FONT_SIZES = new Set(["small", "normal", "large", "xlarge"]);
function applyFontSize(value, persist) {
  const size = FONT_SIZES.has(value) ? value : "normal";
  document.body.dataset.fontSize = size;
  if ($("fontSizeSel")) $("fontSizeSel").value = size;
  if (persist !== false) localStorage.setItem(FONT_SIZE_KEY, size);
  return size;
}

/* DECORATIVE PHOTO CARDS */
const PHOTOCARD_KEY = "mc_photocards";
const PHOTOCARD_SIZES = new Set(["small", "medium", "large"]);
const PHOTOCARD_SIDES = {
  left: {
    enabled: "photoLeftEnabled", size: "photoLeftSize", file: "photoLeftFile",
    remove: "photoLeftRemove", status: "photoLeftStatus", preview: "photoLeftPreview",
    empty: "photoLeftEmpty", card: "photoCardLeft", image: "photoCardLeftImg",
  },
  right: {
    enabled: "photoRightEnabled", size: "photoRightSize", file: "photoRightFile",
    remove: "photoRightRemove", status: "photoRightStatus", preview: "photoRightPreview",
    empty: "photoRightEmpty", card: "photoCardRight", image: "photoCardRightImg",
  },
};
let photoCardMeta = {
  left: { available: false, revision: "0" },
  right: { available: false, revision: "0" },
};
let photoCardMetaError = false;

function normalizePhotoCardPrefs(value) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = {};
  Object.keys(PHOTOCARD_SIDES).forEach((side) => {
    const item = source[side] && typeof source[side] === "object" ? source[side] : {};
    normalized[side] = {
      enabled: item.enabled === true,
      size: PHOTOCARD_SIZES.has(item.size) ? item.size : "medium",
    };
  });
  return normalized;
}

function getPhotoCardPrefs() {
  try { return normalizePhotoCardPrefs(JSON.parse(localStorage.getItem(PHOTOCARD_KEY) || "{}")); }
  catch { return normalizePhotoCardPrefs({}); }
}

function savePhotoCardPrefs(prefs) {
  const normalized = normalizePhotoCardPrefs(prefs);
  localStorage.setItem(PHOTOCARD_KEY, JSON.stringify(normalized));
  return normalized;
}

function photoCardUrl(side, revision) {
  return `/api/photocards/${side}?v=${encodeURIComponent(revision || "0")}`;
}

function setPhotoImage(element, side, meta) {
  if (!element) return;
  if (!meta.available) {
    element.removeAttribute("src");
    delete element.dataset.revision;
    return;
  }
  const revision = String(meta.revision || "0");
  if (element.dataset.revision !== revision) {
    element.dataset.revision = revision;
    element.src = photoCardUrl(side, revision);
  }
}

function applyPhotoCards() {
  const prefs = getPhotoCardPrefs();
  let anyVisible = false;
  Object.entries(PHOTOCARD_SIDES).forEach(([side, ids]) => {
    const meta = photoCardMeta[side] || { available: false, revision: "0" };
    const pref = prefs[side];
    const visible = meta.available && pref.enabled;
    const enabled = $(ids.enabled); const size = $(ids.size); const remove = $(ids.remove);
    const preview = $(ids.preview); const empty = $(ids.empty); const status = $(ids.status);
    const card = $(ids.card); const image = $(ids.image);
    if (enabled) { enabled.checked = pref.enabled; enabled.disabled = !meta.available; }
    if (size) size.value = pref.size;
    if (remove) remove.disabled = !meta.available;
    if (status) status.textContent = photoCardMetaError
      ? "Penyimpanan tidak tersedia"
      : (meta.available ? (visible ? "Aktif" : "Tersimpan") : "Belum ada gambar");
    if (empty) empty.hidden = meta.available;
    if (preview) { preview.hidden = !meta.available; setPhotoImage(preview, side, meta); }
    const panel = document.querySelector(`[data-photo-setting="${side}"]`);
    if (panel) panel.classList.toggle("is-missing", !meta.available);
    if (card) {
      card.dataset.size = pref.size;
      card.classList.toggle("is-visible", visible);
      card.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    setPhotoImage(image, side, meta);
    anyVisible = anyVisible || visible;
  });
  if ($("main")) $("main").dataset.photoLayout = anyVisible ? "on" : "off";
}

async function loadPhotoCardMeta() {
  try {
    const response = await fetch("/api/photocards", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Metadata tidak tersedia");
    photoCardMeta = {
      left: { available: data.left?.available === true, revision: String(data.left?.revision || "0") },
      right: { available: data.right?.available === true, revision: String(data.right?.revision || "0") },
    };
    photoCardMetaError = false;
  } catch {
    photoCardMetaError = true;
  }
  applyPhotoCards();
}

function wirePhotoCards() {
  Object.entries(PHOTOCARD_SIDES).forEach(([side, ids]) => {
    const enabled = $(ids.enabled); const size = $(ids.size); const file = $(ids.file); const remove = $(ids.remove);
    [$(ids.preview), $(ids.image)].forEach((image) => {
      if (image) image.onerror = () => {
        photoCardMeta[side] = { available: false, revision: "0" };
        applyPhotoCards();
      };
    });
    if (enabled) enabled.onchange = () => {
      const prefs = getPhotoCardPrefs(); prefs[side].enabled = enabled.checked;
      savePhotoCardPrefs(prefs); applyPhotoCards();
    };
    if (size) size.onchange = () => {
      const prefs = getPhotoCardPrefs(); prefs[side].size = PHOTOCARD_SIZES.has(size.value) ? size.value : "medium";
      savePhotoCardPrefs(prefs); applyPhotoCards();
    };
    if (file) file.onchange = async () => {
      const selected = file.files && file.files[0];
      if (!selected) return;
      if (selected.size > 7 * 1024 * 1024) { toast("Ukuran gambar maksimal 7 MB"); file.value = ""; return; }
      const body = new FormData(); body.append("image", selected);
      try {
        const response = await fetch(`/api/photocards/${side}`, { method: "POST", body });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Gambar gagal disimpan");
        const prefs = getPhotoCardPrefs(); prefs[side].enabled = true; savePhotoCardPrefs(prefs);
        toast(`Photo card ${side === "left" ? "kiri" : "kanan"} disimpan tanpa kompresi`);
        await loadPhotoCardMeta();
      } catch (error) { toast(error.message || "Gambar gagal disimpan"); }
      file.value = "";
    };
    if (remove) remove.onclick = async () => {
      if (!(await window.confirmDialog({ title: "Hapus photo card", text: `Hapus photo card ${side === "left" ? "kiri" : "kanan"}?`, okLabel: "Hapus", danger: true }))) return;
      try {
        const response = await fetch(`/api/photocards/${side}`, { method: "DELETE" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Gambar gagal dihapus");
        const prefs = getPhotoCardPrefs(); prefs[side].enabled = false; savePhotoCardPrefs(prefs);
        toast("Photo card dihapus"); await loadPhotoCardMeta();
      } catch (error) { toast(error.message || "Gambar gagal dihapus"); }
    };
  });
  applyPhotoCards();
}

/* EXPORT / IMPORT */
function appData() {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^(saham_|mc_)/.test(k)) o[k] = localStorage.getItem(k); }
  return o;
}
$("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(appData(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${brandName()}-backup.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast("Data di-export");
};
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = "";  // so the same file can be picked again
  const rd = new FileReader();
  rd.onload = async () => {
    try {
      const obj = JSON.parse(rd.result);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("format salah");
      const keys = Object.keys(obj).filter((k) => /^(saham_|mc_)/.test(k) && typeof obj[k] === "string");
      if (!keys.length) throw new Error("tidak ada data dashboard di file ini");
      if (!(await window.confirmDialog({ title: "Pulihkan data", text: `Pulihkan ${keys.length} bagian data dari file ini? Data saat ini akan ditimpa.`, okLabel: "Pulihkan", danger: true }))) return;
      if (window.__syncForce) window.__syncForce(keys);
      keys.forEach((k) => localStorage.setItem(k, obj[k]));
      toast("Data dipulihkan. Menyimpan ke server…");
      if (window.__syncFlush) await window.__syncFlush();
      location.reload();
    } catch (err) { toast("File tidak valid: " + err.message); }
  };
  rd.readAsText(f);
};

/* COMMAND PALETTE (Ctrl+K) */
const TAB_LABELS = { home: "Ringkasan", analisa: "Analisis", pasar: "Pasar", porto: "Portofolio", screener: "Screener", alat: "Alat", berita: "Berita", keuangan: "Keuangan", barang: "Barang", profil: "Pengaturan" };
const TAB_MODE = { analisa: "saham", pasar: "saham", porto: "saham", alat: "saham", screener: "saham", berita: "saham", keuangan: "private", barang: "private" };
// Sub-tabs reachable from the palette.
const SUB_LABELS = [
  { label: "Pasar · IHSG", tab: "pasar", sub: "ihsg" }, { label: "Pasar · Rupiah", tab: "pasar", sub: "rupiah" },
  { label: "Pasar · Emas", tab: "pasar", sub: "emas" }, { label: "Alat · ARA / ARB", tab: "alat", sub: "ara" },
  { label: "Alat · Average down", tab: "alat", sub: "avgdown" }, { label: "Alat · Kalkulator posisi", tab: "alat", sub: "posisi" },
  { label: "Portofolio · IPO", tab: "porto", view: "ipo" },
  { label: "Keuangan · Transaksi", tab: "keuangan", sub: "transaksi" }, { label: "Keuangan · Rutin", tab: "keuangan", sub: "rutin" },
  { label: "Keuangan · Target & hutang", tab: "keuangan", sub: "target" }, { label: "Keuangan · Akun", tab: "keuangan", sub: "akun" },
];
let palItems = [], palSel = 0, palTimer = null, palReturnFocus = null, palSeq = 0;
function openPalette() {
  palReturnFocus = document.activeElement;
  $("palette").classList.add("open"); $("palInput").value = ""; palQuery();
  setTimeout(() => $("palInput").focus(), 30);
}
function closePalette() {
  $("palette").classList.remove("open");
  if (palReturnFocus && palReturnFocus.isConnected) { try { palReturnFocus.focus(); } catch { /* */ } }
  palReturnFocus = null;
}
function gotoTab(name, sub) {
  // Ringkasan and Pengaturan exist in both workspaces, so the mode stays.
  const m = TAB_MODE[window.UiPrefs.canonicalTab(name).tab] || currentMode;
  if (m !== currentMode) setMode(m);
  showTab(name, sub);
}
async function palQuery() {
  const seq = ++palSeq;
  const q = $("palInput").value.trim().toLowerCase();
  const items = [];
  Object.keys(TAB_LABELS).forEach((k) => { if (!q || TAB_LABELS[k].toLowerCase().includes(q)) items.push({ kind: "Tab", label: TAB_LABELS[k], act: () => gotoTab(k) }); });
  SUB_LABELS.forEach((it) => {
    if (q && !it.label.toLowerCase().includes(q)) return;
    items.push({ kind: "Tab", label: it.label, act: () => {
      gotoTab(it.tab, it.sub);
      if (it.view && window.investmentSetView) window.investmentSetView(it.view);
    } });
  });
  watchlist.forEach((tk) => { const s = tk.replace(".JK", ""); if (!q || s.toLowerCase().includes(q)) items.push({ kind: "Watchlist", label: s, act: () => openStock(tk) }); });
  if (q.length >= 1) {
    try {
      const d = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json();
      (d.results || []).forEach((r) => { if (!watchlist.includes(r.symbol + ".JK") && !watchlist.includes(r.symbol)) items.push({ kind: "Tambah", label: `${r.symbol} - ${r.name}`, act: () => { if (currentMode !== "saham") setMode("saham"); addStock(r.symbol); showTab("analisa"); } }); });
    } catch { /* */ }
  }
  if (seq !== palSeq) return;  // a newer query's results are already shown
  palItems = items.slice(0, 30); palSel = 0; renderPalette();
}
function renderPalette() {
  $("palList").innerHTML = palItems.length ? palItems.map((it, i) =>
    `<div class="pal-item${i === palSel ? " active" : ""}" id="palOpt${i}" role="option" aria-selected="${i === palSel}" data-i="${i}"><span>${escHtml(it.label)}</span><span class="pal-kind">${escHtml(it.kind)}</span></div>`).join("")
    : "<div class='pal-item'><span class='muted'>Tidak ada hasil</span></div>";
  $("palList").querySelectorAll(".pal-item[data-i]").forEach((el) => el.onmousedown = (e) => { e.preventDefault(); const it = palItems[+el.dataset.i]; closePalette(); it.act(); });
  const active = $("palOpt" + palSel);
  if (active) { $("palInput").setAttribute("aria-activedescendant", active.id); active.scrollIntoView({ block: "nearest" }); }
  else $("palInput").removeAttribute("aria-activedescendant");
}
$("palInput").addEventListener("input", () => { clearTimeout(palTimer); palTimer = setTimeout(palQuery, 130); });
$("palInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); renderPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPalette(); }
  else if (e.key === "Enter") { const it = palItems[palSel]; if (it) { closePalette(); it.act(); } }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  else if (e.key === "Tab") e.preventDefault();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").classList.contains("open") ? closePalette() : openPalette(); }
});
$("palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });

/* TOOLTIP METRIK */
const HELP = {
  fundNote: "Data fundamental bisa tidak lengkap; verifikasi ke laporan keuangan resmi IDX. Label <b>acuan</b> menunjukkan nilai acuan dan penilaiannya (ubah lewat <b>Atur acuan</b>).",
  finHist: "Pendapatan dan laba bersih per kuartal. Data sebagian emiten mungkin tidak lengkap.",
  screener: "Skor fundamental 0-100: gabungan ROE, PER, PBV, dividend yield, dan jarak ke target analis. Daftar = saham likuid IDX terkurasi, bukan seluruh bursa. Klik baris untuk analisis.",
  ath: "Rekor tertinggi tercatat tiap tab Keuangan dibuka. Tiga lapis: <b>uang saja</b>, <b>+saham</b> (portofolio + posisi IPO tertaut), <b>+aset barang</b> (item berstatus sudah beli).",
  rutin: "<b>Otomatis</b>: dicatat sendiri tiap bulan pada tanggal yang diset (default tgl 1); bulan yang terlewat disusulkan saat dashboard dibuka. <b>Template</b>: tidak otomatis; klik <b>▶ Catat</b> di daftar saat ingin mencatatnya. Ubah tanggal item lewat kolom angka lalu klik ✓.",
  news: "Media kredibel (Bisnis, Kontan, CNBC, Bareksa, Reuters, dll.) ditandai ✓. Dampak dan sentimen dinilai otomatis dari judul; AI menambah ringkasan bila aktif.",
  mktUnits: "Emas dalam USD/oz; kurs dalam rupiah. Klik kartu untuk mengganti grafik.",
  rpChart: "Kurs mata uang terhadap rupiah, plus Dollar Index (DXY). Klik kartu untuk mengganti grafik.",
  goldIdr: "Emas dan perak dalam USD/oz, plus perkiraan <b>IDR/gram</b> (harga internasional × kurs USD/IDR ÷ 31,1035), bukan harga Antam. Klik kartu untuk mengganti grafik.",
  investSum: "Gabungan saham, reksa dana, dan obligasi. Kas RDN ditampilkan terpisah agar tidak dihitung ganda dalam kekayaan.",
  coupon: "Tanggal dan jumlah kupon dapat dikoreksi. Pembayaran aktual dapat diarahkan ke RDN atau rekening Keuangan.",
  ipo: "Kolom <b>Kekayaan</b> menghitung nilai posisi ini ke net worth di Keuangan. <b>ARA/ARB besok</b> = perkiraan batas dari harga sekarang dan aturan IDX, bukan kepastian.",
  pfRows: "Klik baris untuk analisis posisi.",
  perf: "Asumsi memegang <b>komposisi portofolio saat ini</b> selama periode terpilih (return harga, bobot = nilai sekarang). Bukan return berbobot waktu.",
  pval: "Garis <b>nilai portofolio harian</b> (lembar × harga). Garis putus-putus = <b>modal</b>: di atasnya untung, di bawahnya rugi. Hanya tanggal saat semua saham punya data.",
  divRecv: "Dividen yang <b>benar-benar diterima</b>. \"Masuk ke\" menambah saldo RDN atau rekening pilihan. Yield riil = total dividen tahun ini ÷ modal portofolio.",
  journal: "Realized P/L dan harga rata-rata memakai metode <b>average cost</b>. Win-rate = persentase transaksi jual yang untung.",
  divProj: "Perkiraan dari <b>dividend rate tahunan</b> × jumlah lembar, bukan jadwal pasti. Tombol di atas menambah pemasukan rutin perkiraan per bulan (total tahunan ÷ 12) di Keuangan; hapus di sana bila tidak diinginkan.",
  agenda: "Urut menurut tanggal ex-dividend dari data publik (bisa tanggal mendatang atau terakhir). Beli sebelum ex-date untuk berhak atas dividen. Indikatif, bukan jadwal pasti.",
  per: "<b>PER (Price to Earnings)</b> = Harga ÷ Laba per saham. Berapa kali laba setahun yang dibayar untuk 1 lembar. Makin rendah relatif murah; tapi PER rendah bisa berarti pertumbuhan lambat / risiko (value trap). Bandingkan dengan rata-rata historis & sektor.",
  pbv: "<b>PBV (Price to Book Value)</b> = Harga ÷ Nilai buku per saham. <1 berarti dihargai di bawah nilai bukunya. Untuk bank, PBV adalah patokan utama; pasangkan dengan ROE.",
  eps: "<b>EPS</b> = Laba bersih per lembar saham (setahun). Dasar perhitungan PER.",
  bvps: "<b>BVPS</b> = Ekuitas ÷ jumlah saham = nilai buku per lembar. Dasar perhitungan PBV.",
  roe: "<b>ROE (Return on Equity)</b> = Laba bersih ÷ ekuitas. Seberapa efisien modal pemegang saham menghasilkan laba. >15% umumnya bagus & layak PBV premium.",
  roa: "<b>ROA (Return on Assets)</b> = Laba bersih ÷ total aset. Efisiensi seluruh aset menghasilkan laba.",
  npm: "<b>Margin Laba Bersih</b> = Laba bersih ÷ pendapatan. Berapa persen penjualan menjadi laba bersih.",
  dividendYield: "<b>Imbal Hasil Dividen</b> = Dividen setahun ÷ harga. Imbal hasil tunai dari dividen. Tinggi = arus kas menarik, tapi cek keberlanjutannya (payout).",
  payoutRatio: "<b>Rasio Payout</b> = Dividen ÷ laba bersih. Berapa persen laba dibagikan. Terlalu tinggi (>100%) berarti membayar melebihi laba - kurang berkelanjutan.",
  beta: "<b>Beta</b> = sensitivitas harga terhadap pasar. 1 = bergerak seiring pasar; >1 lebih volatil; <1 lebih stabil.",
  signal: "<b>Skor sinyal teknikal</b> (−100…+100) = gabungan beberapa indikator (MA, MACD, RSI, Bollinger). Alat bantu timing, BUKAN jaminan arah.",
  ma: "<b>Moving Average (MA)</b> = rata-rata harga N periode. Harga di atas MA = tren naik. MA pendek memotong ke atas MA panjang (golden cross) = sinyal bullish.",
  rsi: "<b>RSI (14)</b> = momentum 0-100. >70 jenuh beli (rawan koreksi), <30 jenuh jual (rawan rebound). Divergensi RSI vs harga = sinyal pembalikan.",
  macd: "<b>MACD</b> = selisih EMA12−EMA26 vs garis sinyal (EMA9). MACD memotong ke atas sinyal = momentum positif; histogram membesar = menguat.",
  bollinger: "<b>Bollinger Bands</b> = MA20 ± 2× simpangan baku. Menyentuh band atas = relatif mahal/jenuh; band bawah = murah/jenuh. Band menyempit = potensi ledakan volatilitas.",
  atr: "<b>ATR (14)</b> = rata-rata rentang gerak harian (volatilitas). Berguna menentukan jarak stop-loss yang wajar.",
  pivot: "<b>Pivot Point</b> = level acuan dari high/low/close kemarin. R1/R2 = resistance, S1/S2 = support perkiraan.",
  sr: "<b>Support / Resistance</b> = harga 'lantai' (banyak pembeli) & 'atap' (banyak penjual) dari titik tertinggi/terendah pada periode tertentu.",
  yieldOnCost: "<b>Yield on Cost</b> = dividen per saham ÷ harga beli rata-rata Anda. Imbal hasil dividen relatif terhadap modal Anda, bukan harga pasar sekarang.",
  scoreFund: "<b>Skor fundamental (0-100)</b> = gabungan ROE, PER, PBV, dividend yield, & jarak ke target analis. Makin tinggi makin menarik secara fundamental (acuan, bukan rekomendasi).",
};
function help(key) { return HELP[key] ? ` <span class="hlp" data-help="${key}" tabindex="0" role="button" aria-label="Penjelasan">?</span>` : ""; }
window.help = help;
(function tooltipEngine() {
  const tip = $("tip");
  function show(el) {
    const k = el.dataset.help; if (!HELP[k]) return;
    tip.innerHTML = HELP[k];
    tip.classList.add("show");
    el.setAttribute("aria-describedby", "tip");
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.bottom + 8;
    tip.style.left = "0px"; tip.style.top = "0px";  // measure first
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    left = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8);
    if (top + th > window.innerHeight - 8) top = r.top - th - 8;
    tip.style.left = left + "px"; tip.style.top = Math.max(8, top) + "px";
  }
  let cur = null;
  function hide() { tip.classList.remove("show"); cur = null; }
  document.addEventListener("mouseover", (e) => { const el = e.target.closest && e.target.closest(".hlp"); if (el) show(el); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest(".hlp")) hide(); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest && e.target.closest(".hlp"); if (el) show(el); });
  document.addEventListener("focusout", hide);
  // Tap to toggle (touch devices without hover)
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest(".hlp");
    if (el) { e.preventDefault(); if (cur === el) { hide(); } else { show(el); cur = el; } }
    else if (cur) { hide(); }
  });
  window.addEventListener("scroll", hide, true);
})();
$("resetConfirm").addEventListener("input", (e) => {
  $("resetAllBtn").disabled = e.target.value.trim().toUpperCase() !== "HAPUS SEMUA";
});
$("resetAllBtn").onclick = async () => {
  $("resetAllBtn").disabled = true;
  try { localStorage.clear(); } catch { /* */ }
  toast("Semua data dihapus. Memuat ulang…");
  try { if (window.__syncFlush) await window.__syncFlush(); } catch { /* */ }
  location.reload();
};

/* A11Y / TAMPILAN HELPERS */
// Give an accessible name to form controls without a <label> or aria-label
const A11Y_NAMES = {
  finInclStocks: "Sertakan nilai saham di kekayaan", aiToggle: "Nyalakan atau matikan AI",
  autoChk: "Auto-refresh", bbChk: "Tampilkan Bollinger Bands", emaChk: "Gunakan EMA",
  resetConfirm: "Ketik konfirmasi hapus semua", densitySel: "Kepadatan tampilan",
  fontSizeSel: "Ukuran font antarmuka", photoLeftEnabled: "Tampilkan photo card kiri",
  photoLeftSize: "Ukuran photo card kiri", photoRightEnabled: "Tampilkan photo card kanan",
  photoRightSize: "Ukuran photo card kanan",
};
function humanizeId(id) {
  return id.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function a11yLabel(root) {
  (root || document).querySelectorAll("input,select,textarea").forEach((c) => {
    if (c.type === "hidden" || c.getAttribute("aria-label")) return;
    const id = c.id;
    if (id && document.querySelector('label[for="' + id + '"]')) return;
    const wrap = c.closest("label");
    if (wrap && wrap.textContent.replace(/\s/g, "").length > 1) return;
    c.setAttribute("aria-label", A11Y_NAMES[id] || c.placeholder || (id ? humanizeId(id) : "") || c.name || "Input");
  });
}
// Kepadatan tampilan (lega / rapat)
const DENSITY_KEY = "mc_density";
function applyDensity(k) {
  if (k === "compact") document.body.setAttribute("data-density", "compact");
  else document.body.removeAttribute("data-density");
  const sel = $("densitySel"); if (sel) sel.value = k || "comfortable";
}
// Privacy mode: hide the owner's amounts (CSS .priv / .priv-inp), kept across pages
const HIDE_KEY = "mc_hide";
function privacyOn() { return localStorage.getItem(HIDE_KEY) === "1"; }
function privacyEffectiveFor(pane) { return privacyOn() || !!(pane && pane.classList.contains("priv-on")); }
function syncPrivacyControls() {
  const on = privacyOn(); document.body.classList.toggle("priv-hide", on);
  const b = $("hideBtn");
  if (b) {
    const label = on ? "Tampilkan semua angka" : "Privasi: sensor semua angka";
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", label); b.title = label;
    const text = b.querySelector(".btn-label"); if (text) text.textContent = on ? "Tampilkan" : "Privasi";
  }
  PAGE_SENSORS.forEach(([tabId]) => {
    const pane = $(tabId); if (!pane) return;
    const button = pane.querySelector(".page-sensor"); if (!button) return;
    const local = pane.classList.contains("priv-on"), effective = privacyEffectiveFor(pane);
    const label = local ? "Tampilkan angka halaman ini" : "Sensor angka halaman ini";
    button.classList.toggle("on", effective); button.setAttribute("aria-pressed", local ? "true" : "false");
    button.setAttribute("aria-label", label); button.title = privacyOn() ? `${label}. Sensor global masih aktif.` : label;
    button.textContent = local ? "Tampilkan angka" : (privacyOn() ? "Sensor global aktif" : "Sensor angka");
  });
}
function applyHide() { syncPrivacyControls(); }
function fmtMoneyField(el) {
  const raw = el.value, caret = el.selectionStart || 0;
  const digitsBefore = raw.slice(0, caret).replace(/[^\d]/g, "").length;
  const formatted = groupRp(raw);
  if (formatted === raw) return;
  el.value = formatted;
  let pos = 0, cnt = 0;
  while (pos < formatted.length && cnt < digitsBefore) { if (/\d/.test(formatted[pos])) cnt++; pos++; }
  try { el.setSelectionRange(pos, pos); } catch { /* */ }
}
// Reformat filled .money inputs (e.g. after a render)
window.formatMoneyAll = function (root) {
  (root || document).querySelectorAll("input.money").forEach((el) => {
    if (el.value !== "" && document.activeElement !== el) el.value = groupRp(el.value);
  });
};
document.addEventListener("input", (e) => {
  if (e.target && e.target.classList && e.target.classList.contains("money")) fmtMoneyField(e.target);
});
// Input uang statis → jadikan input teks berformat ribuan
const MONEY_IDS = ["pfAvg", "sellPrice", "sellFee", "rdnInput", "rdnAmt", "divAmount", "araStart", "ipoBuy",
  "adAvg", "adPrice", "adMkt", "accBal", "txAmt", "recAmt", "tgtMonth", "tgtYear", "debtAmt", "buyPrice",
  "bgItemPrice", "bgSave", "jrPrice", "jrFee"];
function setupMoneyInputs() {
  MONEY_IDS.forEach((id) => { const el = $(id); if (el) { el.type = "text"; el.setAttribute("inputmode", "numeric"); el.classList.add("money"); } });
  if (window.formatMoneyAll) window.formatMoneyAll();
}
// Cards can fold. The key is the heading text without a leading symbol, so older
// keys (that still start with an emoji) keep matching.
function collapseKey(text) { return String(text || "").replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 40); }
function readCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem("mc_collapsed") || "[]").map(collapseKey)); } catch { return new Set(); }
}
function initCollapsibles() {
  const collapsed = readCollapsed();
  document.querySelectorAll(".card > h3").forEach((h3) => {
    if (h3.dataset.collapsibleInit) return; h3.dataset.collapsibleInit = "1";
    const card = h3.parentElement, key = collapseKey(h3.textContent);
    const btn = document.createElement("button");
    btn.className = "card-collapse"; btn.type = "button"; btn.textContent = "▾";
    btn.setAttribute("aria-label", `Lipat atau buka kartu ${key}`);
    h3.insertBefore(btn, h3.firstChild);
    const sync = () => btn.setAttribute("aria-expanded", card.classList.contains("collapsed") ? "false" : "true");
    if (collapsed.has(key)) card.classList.add("collapsed");
    sync();
    btn.onclick = (e) => {
      e.stopPropagation(); card.classList.toggle("collapsed"); sync();
      const s = readCollapsed();
      if (card.classList.contains("collapsed")) s.add(key); else s.delete(key);
      localStorage.setItem("mc_collapsed", JSON.stringify([...s]));
    };
  });
}
// Per-page privacy (besides the global header button)
const PAGE_SENSORS = [["tabHome", "home"], ["tabPorto", "porto"], ["tabKeuangan", "keuangan"], ["tabBarang", "barang"]];
function hidePagesSet() { try { return new Set(JSON.parse(localStorage.getItem("mc_hide_pages") || "[]")); } catch { return new Set(); } }
function setupPageSensors() {
  const set = hidePagesSet();
  PAGE_SENSORS.forEach(([tabId, key]) => {
    const pane = $(tabId); if (!pane || pane.dataset.sensorInit) return; pane.dataset.sensorInit = "1";
    if (set.has(key)) pane.classList.add("priv-on");
    const bar = document.createElement("div"); bar.className = "page-sensor-bar";
    const btn = document.createElement("button"); btn.className = "iconbtn page-sensor"; btn.type = "button";
    btn.onclick = () => {
      pane.classList.toggle("priv-on");
      const s = hidePagesSet(); if (pane.classList.contains("priv-on")) s.add(key); else s.delete(key);
      localStorage.setItem("mc_hide_pages", JSON.stringify([...s])); syncPrivacyControls();
    };
    bar.appendChild(btn); pane.insertBefore(bar, pane.firstChild);
  });
  syncPrivacyControls();
}
// Engine sortable (mouse + sentuh) - geser item vertikal, panggil onEnd(orderedEls)
function makeSortable(container, itemSel, onEnd, handleSel) {
  if (!container) return;
  container.querySelectorAll(itemSel).forEach((it) => {
    const handle = handleSel ? it.querySelector(handleSel) : it;
    if (!handle || handle.dataset.sortBound) return; handle.dataset.sortBound = "1";
    handle.style.touchAction = "none";
    handle.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      it.classList.add("dragging");
      try { handle.setPointerCapture(e.pointerId); } catch { /* */ }
      const move = (ev) => {
        const y = ev.clientY;
        const sibs = [...container.querySelectorAll(itemSel)].filter((s) => s !== it);
        let target = null;
        for (const s of sibs) { const r = s.getBoundingClientRect(); if (y < r.top + r.height / 2) { target = s; break; } }
        if (target) container.insertBefore(it, target); else container.appendChild(it);
      };
      const up = () => {
        try { handle.releasePointerCapture(e.pointerId); } catch { /* */ }
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        it.classList.remove("dragging");
        if (onEnd) onEnd([...container.querySelectorAll(itemSel)]);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  });
}
window.makeSortable = makeSortable;

/* Tata letak: urutan/sembunyikan tab & widget Home */
const HOME_LABELS = { ringkasan: "Ringkasan", movers: "Pergerakan Terbesar Watchlist", pasar: "Pasar" };
function jsonSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); } }
function jsonArr(key) { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } }
function tabHiddenSet() { return jsonSet("mc_tab_hidden"); }
// Saved menu lists from before the menu was trimmed: order maps old names to
// their new view; hidden items that moved are dropped.
function migrateSavedTabs() {
  const order = jsonArr("mc_tab_order"), hidden = jsonArr("mc_tab_hidden");
  const newOrder = window.UiPrefs.migrateTabList(order), newHidden = window.UiPrefs.migrateHiddenTabs(hidden, order);
  if (JSON.stringify(newOrder) !== JSON.stringify(order)) localStorage.setItem("mc_tab_order", JSON.stringify(newOrder));
  if (JSON.stringify(newHidden) !== JSON.stringify(hidden)) localStorage.setItem("mc_tab_hidden", JSON.stringify(newHidden));
}
function applyTabOrder() {
  const nav = document.querySelector(".tabs"); if (!nav) return;
  const all = [...nav.querySelectorAll(".tab")].map((b) => b.dataset.tab);
  const order = jsonArr("mc_tab_order");
  const finalOrder = order.filter((t) => all.includes(t)).concat(all.filter((t) => !order.includes(t)));
  finalOrder.forEach((t) => { const b = nav.querySelector(`.tab[data-tab="${t}"]`); if (b) nav.appendChild(b); });
}
function applyHomeLayout() {
  const cont = $("homeWidgets"); if (!cont) return;
  const hid = jsonSet("mc_home_hidden"), order = jsonArr("mc_home_order");
  const all = [...cont.querySelectorAll(".home-widget")].map((w) => w.dataset.widget);
  const finalOrder = order.filter((w) => all.includes(w)).concat(all.filter((w) => !order.includes(w)));
  finalOrder.forEach((w) => { const el = cont.querySelector(`.home-widget[data-widget="${w}"]`); if (el) { cont.appendChild(el); el.style.display = hid.has(w) ? "none" : ""; } });
}
function renderLayoutSettings() {
  const tl = $("tabConfigList");
  if (tl) {
    const hid = tabHiddenSet();
    const tabs = [...document.querySelectorAll(".tabs .tab")];
    tl.innerHTML = tabs.map((b) => {
      const t = b.dataset.tab, on = !hid.has(t);
      return `<div class="layout-item ${on ? "" : "off"}" data-key="${t}">
        <span class="drag-handle" title="Geser untuk urutkan">☰</span>
        <span class="lname">${TAB_LABELS[t] || t}</span>
        <label class="switch" title="Tampilkan tab"><input type="checkbox" class="cfg-toggle" ${on ? "checked" : ""}><span class="slider"></span></label>
      </div>`;
    }).join("");
    tl.querySelectorAll(".cfg-toggle").forEach((c) => c.onchange = () => {
      const key = c.closest(".layout-item").dataset.key, s = tabHiddenSet();
      if (c.checked) s.delete(key); else s.add(key);
      localStorage.setItem("mc_tab_hidden", JSON.stringify([...s]));
      c.closest(".layout-item").classList.toggle("off", !c.checked);
      setMode(currentMode, true);
    });
    makeSortable(tl, ".layout-item", (els) => {
      localStorage.setItem("mc_tab_order", JSON.stringify(els.map((e) => e.dataset.key)));
      applyTabOrder();
    }, ".drag-handle");
  }
  const hl = $("homeConfigList");
  if (hl) {
    const hid = jsonSet("mc_home_hidden");
    const cont = $("homeWidgets");
    const widgets = cont ? [...cont.querySelectorAll(".home-widget")].map((w) => w.dataset.widget) : Object.keys(HOME_LABELS);
    hl.innerHTML = widgets.map((w) => {
      const on = !hid.has(w);
      return `<div class="layout-item ${on ? "" : "off"}" data-key="${w}">
        <span class="drag-handle" title="Geser untuk urutkan">☰</span>
        <span class="lname">${HOME_LABELS[w] || w}</span>
        <label class="switch" title="Tampilkan widget"><input type="checkbox" class="cfg-toggle" ${on ? "checked" : ""}><span class="slider"></span></label>
      </div>`;
    }).join("");
    hl.querySelectorAll(".cfg-toggle").forEach((c) => c.onchange = () => {
      const key = c.closest(".layout-item").dataset.key, s = jsonSet("mc_home_hidden");
      if (c.checked) s.delete(key); else s.add(key);
      localStorage.setItem("mc_home_hidden", JSON.stringify([...s]));
      c.closest(".layout-item").classList.toggle("off", !c.checked);
      applyHomeLayout();
    });
    makeSortable(hl, ".layout-item", (els) => {
      localStorage.setItem("mc_home_order", JSON.stringify(els.map((e) => e.dataset.key)));
      applyHomeLayout();
    }, ".drag-handle");
  }
}

// Thousands hint while typing in plain number inputs (type=number); the value is unchanged
(function moneyHint() {
  const tip = document.createElement("div"); tip.id = "numfmt"; document.body.appendChild(tip);
  const grp = (n) => { const neg = n < 0; const s = Math.abs(n).toString().split("."); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, "."); return (neg ? "-" : "") + s.join(","); };
  const show = (el) => {
    const n = Number(el.value);
    if (el.value === "" || isNaN(n) || Math.abs(n) < 1000) { tip.classList.remove("show"); return; }
    tip.textContent = grp(n);
    const r = el.getBoundingClientRect();
    tip.style.left = Math.round(r.left) + "px"; tip.style.top = Math.round(r.bottom + 4) + "px";
    tip.classList.add("show");
  };
  const hide = () => tip.classList.remove("show");
  const isNum = (e) => e.target && e.target.matches && e.target.matches('input[type="number"]');
  document.addEventListener("focusin", (e) => { if (isNum(e)) show(e.target); });
  document.addEventListener("input", (e) => { if (isNum(e)) show(e.target); });
  document.addEventListener("focusout", (e) => { if (isNum(e)) hide(); });
  window.addEventListener("scroll", hide, true);
})();

/* INIT */
applyTheme(localStorage.getItem(THEME_KEY) || "default", false);
renderThemeGrid();
applyFontSize(localStorage.getItem(FONT_SIZE_KEY) || "normal", false);
const _fontSize = $("fontSizeSel"); if (_fontSize) _fontSize.onchange = () => { applyFontSize(_fontSize.value, true); measureChrome(); };
wirePhotoCards();
loadPhotoCardMeta();
initMaControls();
applyProfile();
renderWL();
loadAiStatus();
loadAuto();
applyAuto(true);
loadAdminStatus();
if (watchlist.length) { Promise.resolve(selectStock(watchlist[0])).finally(hideSplash); } else { hideSplash(); }
setTimeout(hideSplash, 9000);  // the splash must not hang when the first request stalls
const _gear = $("gearBtn"); if (_gear) _gear.onclick = () => gotoTab("profil");
const _pal = $("palBtn"); if (_pal) _pal.onclick = () => openPalette();
applyDensity(localStorage.getItem(DENSITY_KEY) || "comfortable");
const _den = $("densitySel"); if (_den) _den.onchange = () => { const v = _den.value; localStorage.setItem(DENSITY_KEY, v); applyDensity(v); measureChrome(); };
applyHide();
if ($("hideBtn")) $("hideBtn").onclick = () => { localStorage.setItem(HIDE_KEY, privacyOn() ? "0" : "1"); applyHide(); };
setupMoneyInputs();
initCollapsibles();
setupPageSensors();
migrateSavedTabs();
applyTabOrder();
applyHomeLayout();
setupTabsAria();

// setMode runs after every module has registered its window.*Render.
const _boot = () => { setMode(localStorage.getItem("mc_mode") || "saham", false, true); a11yLabel(); measureChrome(); };
window.addEventListener("mc:modules-ready", _boot, { once: true });
window.__appLoaded = true;
