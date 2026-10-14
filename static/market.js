/* market.js - Tab Pasar (IHSG & global), Rupiah (kurs+DXY), Emas (logam mulia).
   Memakai helper global: $, fmt, toast, window.chartColors. */
"use strict";
(function () {
  const charts = {};  // elId -> instance
  const fmtVal = (v) => (v == null ? "-" : (Math.abs(v) >= 1000 ? fmt(v, 0) : fmt(v, 2)));

  function makeChart(elId, c) {
    const el = $(elId);
    if (charts[elId]) { try { charts[elId].remove(); } catch { /* */ } charts[elId] = null; }
    if (!c || !c.candles || !c.candles.length) { el.innerHTML = "<div class='empty-row'>Data grafik tak tersedia.</div>"; return; }
    if (!window.LightweightCharts) { el.innerHTML = "<div class='error-row'>Library grafik gagal dimuat (perlu internet).</div>"; return; }
    el.innerHTML = "";
    const cc = window.chartColors();
    const ch = LightweightCharts.createChart(el, {
      layout: { background: { color: cc.bg }, textColor: cc.text },
      grid: { vertLines: { color: cc.grid }, horzLines: { color: cc.grid } },
      rightPriceScale: { borderColor: cc.grid }, timeScale: { borderColor: cc.grid }, autoSize: true, height: 380,
    });
    ch.addCandlestickSeries({ upColor: cc.up, downColor: cc.down, borderVisible: false, wickUpColor: cc.up, wickDownColor: cc.down }).setData(c.candles);
    if (c.ma20 && c.ma20.length) ch.addLineSeries({ color: cc.muted, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }).setData(c.ma20);
    ch.timeScale().fitContent();
    window.fitChartOnResize(ch, el);
    charts[elId] = ch;
  }

  async function loadChart(cfg) {
    const tf = ($(cfg.rangeId).value || "1y|1d").split("|");
    $(cfg.titleId).textContent = cfg.name;
    $(cfg.chartId).innerHTML = "<div class='skel skel-chart'></div>";
    try {
      const d = await (await fetch(`/api/marketchart/${encodeURIComponent(cfg.sym)}?range=${tf[0]}&interval=${tf[1] || "1d"}`)).json();
      makeChart(cfg.chartId, d.chart);
    } catch { $(cfg.chartId).innerHTML = "<div class='error-row'>Gagal memuat grafik.</div>"; }
  }

  function renderCards(cfg, items, extraHtml) {
    const cur = cfg.sym;
    const cards = (items || []).map((q) => {
      const up = (q.changePct || 0) >= 0;
      const val = q.error ? "<span class='tiny muted'>n/a</span>" : fmtVal(q.price);
      const chg = (q.error || q.changePct == null) ? "" : `<span class="${up ? "up" : "down"}">${up ? "▲" : "▼"} ${fmt(Math.abs(q.changePct), 2)}%</span>`;
      const clickable = q.symbol ? " mkt-card" : "";
      const active = q.symbol && q.symbol === cur ? " active" : "";
      return `<div class="pf-card${clickable}${active}"${q.symbol ? ` data-sym="${escHtml(q.symbol)}" data-name="${escHtml(q.name)}"` : ""}>
        <div class="lbl">${escHtml(q.name)}</div><div class="val">${val}</div><div class="tiny">${chg}</div></div>`;
    }).join("");
    $(cfg.quotesId).innerHTML = cards + (extraHtml || "");
    $(cfg.quotesId).querySelectorAll(".mkt-card").forEach((c) => c.onclick = () => {
      cfg.sym = c.dataset.sym; cfg.name = c.dataset.name; renderCards(cfg, cfg._items, extraHtml); loadChart(cfg);
    });
  }

  async function render(cfg) {
    try {
      const d = await (await fetch(cfg.endpoint)).json();
      cfg._items = d.items || [];
      // Gold leads with the rupiah price per gram, the figure the owner reads first.
      if (cfg.key === "emas") cfg._items.sort((a, b) => (b.name === "Emas (IDR / gram)") - (a.name === "Emas (IDR / gram)"));
      if (!cfg.loaded) { cfg.sym = d.chartSymbol || cfg.sym; cfg.name = d.chartName || cfg.name; }
      let extra = "";
      if (cfg.key === "pasar") {
        const bi = localStorage.getItem("mc_birate");
        extra = `<div class="pf-card"><div class="lbl">BI Rate</div><div class="val">${bi ? fmt(+bi, 2) + "%" : "-"}</div></div>`;
        if (bi && $("biRate") && !$("biRate").value) $("biRate").value = bi;
      }
      renderCards(cfg, cfg._items, extra);
      if (!cfg.loaded) { cfg.loaded = true; loadChart(cfg); }
    } catch {
      $(cfg.quotesId).innerHTML = "<div class='error-row'>Gagal memuat data. <button type='button' class='btn-secondary mkt-retry'>Coba lagi</button></div>";
      $(cfg.quotesId).querySelector(".mkt-retry").onclick = () => render(cfg);
    }
  }

  const CFG = {
    pasar: { key: "pasar", endpoint: "/api/market", quotesId: "mktQuotes", chartId: "mktChart", rangeId: "mktRange", titleId: "mktChartTitle", sym: "^JKSE", name: "IHSG", loaded: false },
    rupiah: { key: "rupiah", endpoint: "/api/rupiah", quotesId: "rpQuotes", chartId: "rpChart", rangeId: "rpRange", titleId: "rpChartTitle", sym: "IDR=X", name: "USD / IDR", loaded: false },
    emas: { key: "emas", endpoint: "/api/gold", quotesId: "goldQuotes", chartId: "goldChart", rangeId: "goldRange", titleId: "goldChartTitle", sym: "GC=F", name: "Emas (USD/oz)", loaded: false },
  };

  $("mktRange").onchange = () => loadChart(CFG.pasar);
  $("rpRange").onchange = () => loadChart(CFG.rupiah);
  $("goldRange").onchange = () => loadChart(CFG.emas);
  $("biRateSave").onclick = () => {
    const v = parseFloat($("biRate").value);
    if (isNaN(v)) { toast("Isi BI rate"); return; }
    localStorage.setItem("mc_birate", v); render(CFG.pasar); toast("BI Rate disimpan");
  };

  window.marketRender = () => render(CFG.pasar);
  window.rupiahRender = () => render(CFG.rupiah);
  window.emasRender = () => render(CFG.emas);
  // used on a theme change: reload every market chart already shown, so all of
  // them take the new theme's colours, not only IHSG.
  window.marketReload = () => {
    [CFG.pasar, CFG.rupiah, CFG.emas].forEach((cfg) => { if (cfg.loaded) loadChart(cfg); });
  };
})();
