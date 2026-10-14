/* screener.js - Filter saham berdasar parameter fundamental.
   Memakai helper global app.js: $, fmt, fmtRp, toast, addStock, showTab. */
"use strict";
(function () {
  const num = (x) => (x == null || isNaN(x)) ? "-" : (+x).toFixed(2);
  let sectorsLoaded = false;

  function readFilters() {
    const f = {};
    const per = parseFloat($("scPer").value); if (!isNaN(per)) f.perMax = per;
    const pbv = parseFloat($("scPbv").value); if (!isNaN(pbv)) f.pbvMax = pbv;
    const roe = parseFloat($("scRoe").value); if (!isNaN(roe)) f.roeMin = roe;
    const dy = parseFloat($("scDy").value); if (!isNaN(dy)) f.dyMin = dy;
    const sec = $("scSector").value; if (sec) f.sector = sec;
    return f;
  }

  async function scan() {
    $("scInfo").textContent = "Memindai universe saham… (sebentar, ~5-10 detik pertama kali)";
    $("scTable").innerHTML = "";
    try {
      const r = await fetch("/api/screener", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: readFilters() }),
      });
      const d = await r.json();
      if (!sectorsLoaded && d.sectors) {
        const cur = $("scSector").value;
        $("scSector").innerHTML = `<option value="">Semua</option>` + d.sectors.map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join("");
        $("scSector").value = cur; sectorsLoaded = true;
      }
      renderTable(d);
    } catch {
      $("scInfo").innerHTML = "<span class='error-row'>Pemindaian gagal. <button type='button' class='btn-secondary' data-retry>Coba lagi</button></span>";
      window.wireRetry($("scInfo"), scan);
    }
  }

  function scoreCls(s) { return s >= 65 ? "up" : s >= 40 ? "" : "down"; }

  function renderTable(d) {
    $("scInfo").innerHTML = `Menemukan <b>${d.count}</b> saham (dari ${d.universe} dipindai). Urut dari skor fundamental tertinggi.`;
    const head = `<thead><tr><th>Saham</th><th>Sektor</th><th>Harga</th><th>PER</th><th>PBV</th><th>ROE</th><th>Div%</th><th>Upside</th><th>Sinyal</th><th>Skor</th></tr></thead>`;
    const rows = d.results.length ? d.results.map((m) => {
      const sigCls = m.score >= 20 ? "up" : m.score <= -20 ? "down" : "muted";
      return `<tr data-tk="${escHtml(m.ticker)}">
        <td><b>${escHtml(m.ticker.replace(".JK", ""))}</b></td>
        <td class="tiny">${escHtml(m.sector || "-")}</td>
        <td>${fmt(m.price)}</td>
        <td>${num(m.per)}</td><td>${num(m.pbv)}</td>
        <td>${m.roe != null ? fmt(m.roe, 1) + "%" : "-"}</td>
        <td>${m.dividendYield != null ? fmt(m.dividendYield, 1) + "%" : "-"}</td>
        <td class="${m.targetUpside == null ? "muted" : (m.targetUpside >= 0 ? "up" : "down")}">${m.targetUpside != null ? (m.targetUpside >= 0 ? "+" : "") + fmt(m.targetUpside, 0) + "%" : "-"}</td>
        <td class="${sigCls}">${escHtml(m.signal || "-")}</td>
        <td class="${scoreCls(m.scoreFund)}"><b>${fmt(m.scoreFund, 0)}</b></td>
      </tr>`;
    }).join("") : "<tr><td colspan='10' class='tiny muted'>Tidak ada saham yang lolos filter. Longgarkan kriteria.</td></tr>";
    $("scTable").innerHTML = head + "<tbody>" + rows + "</tbody>";
    $("scTable").querySelectorAll("tbody tr").forEach((tr) => {
      if (!tr.dataset.tk) return;
      tr.onclick = () => { addStock(tr.dataset.tk); showTab("analisa"); toast(tr.dataset.tk.replace(".JK", "") + " dibuka di Analisis"); };
    });
  }

  $("scScan").onclick = scan;
  $("scPreset").onclick = () => {
    $("scRoe").value = 15; $("scPer").value = 20; $("scPbv").value = 3; $("scDy").value = "";
    scan();
  };
  $("scReset").onclick = () => {
    ["scPer", "scPbv", "scRoe", "scDy"].forEach((id) => $(id).value = "");
    $("scSector").value = "";
    $("scTable").innerHTML = ""; $("scInfo").textContent = "";
  };
})();
