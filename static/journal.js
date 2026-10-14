/* journal.js - Jurnal transaksi beli/jual + Realized P/L (average cost) + win-rate.
   Memakai helper global: $, fmt, fmtRp, toast, normTicker, window.setPortfolio. */
"use strict";
(function () {
  const JK = "mc_journal", AUTO_KEY = "mc_jr_autosync";
  const load = () => { try { return JSON.parse(localStorage.getItem(JK)) || []; } catch { return []; } };
  const saveJ = (a) => localStorage.setItem(JK, JSON.stringify(a));
  const autoOn = () => localStorage.getItem(AUTO_KEY) === "1";
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const ymd = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  // Realized P/L (average cost), open positions and win rate.
  // Pure function: takes an array of trades, touches neither the DOM nor localStorage.
  function computeFrom(list) {
    const trades = list.slice().sort((a, b) =>
      (a.date || "").localeCompare(b.date || "") || (a.seq || 0) - (b.seq || 0));
    const pos = {};                 // ticker → {qty(shares), cost}
    const realizedByTk = {};
    let realized = 0, sells = 0, wins = 0, warned = false;
    for (const t of trades) {
      const tk = t.ticker, shares = t.lots * 100, fee = +t.fee || 0, price = +t.price;
      pos[tk] = pos[tk] || { qty: 0, cost: 0 };
      if (t.side === "buy") {
        pos[tk].qty += shares; pos[tk].cost += shares * price + fee;
      } else {
        if (pos[tk].qty <= 0) { warned = true; continue; }
        const avg = pos[tk].cost / pos[tk].qty;
        const sold = Math.min(shares, pos[tk].qty);
        const pnl = (price - avg) * sold - fee;
        realized += pnl; realizedByTk[tk] = (realizedByTk[tk] || 0) + pnl;
        sells++; if (pnl > 0) wins++;
        pos[tk].qty -= sold; pos[tk].cost -= avg * sold;
      }
    }
    const open = [];
    for (const tk in pos) {
      if (pos[tk].qty > 1e-6) {
        const avg = pos[tk].cost / pos[tk].qty;
        open.push({ ticker: tk, lots: Math.round(pos[tk].qty / 100), avg, realized: realizedByTk[tk] || 0 });
      }
    }
    // include realized P/L for closed tickers
    for (const tk in realizedByTk) if (!open.find((o) => o.ticker === tk)) open.push({ ticker: tk, lots: 0, avg: null, realized: realizedByTk[tk] });
    return { trades, realized, sells, wins, open, warned };
  }
  function compute() { return computeFrom(load()); }
  window.journalMath = { computeFrom, firstShortfall, shortfalls };

  function render() {
    if (!$("jrDate").value) $("jrDate").value = ymd();
    const c = compute();
    const winRate = c.sells ? c.wins / c.sells * 100 : 0;
    const plc = c.realized >= 0 ? "up" : "down";
    $("jrSummary").innerHTML = `
      <div class="pf-card"><div class="lbl">Realized P/L</div><div class="val priv ${plc}">${c.realized >= 0 ? "+" : ""}${fmtRp(c.realized)}</div></div>
      <div class="pf-card"><div class="lbl">Win-rate</div><div class="val">${fmt(winRate, 0)}%<br><span class="lbl">${c.wins}/${c.sells} jual untung</span></div></div>
      <div class="pf-card"><div class="lbl">Transaksi</div><div class="val">${c.trades.length}</div></div>
      <div class="pf-card"><div class="lbl">Posisi Terbuka</div><div class="val">${c.open.filter((o) => o.lots > 0).length}</div></div>`;

    // posisi terbuka + realized per ticker
    const ph = `<thead><tr><th>Saham</th><th>Lot</th><th>Avg Cost</th><th>Realized P/L</th></tr></thead>`;
    const pb = c.open.length ? c.open.sort((a, b) => b.lots - a.lots).map((o) => `<tr>
      <td><b>${escHtml(o.ticker.replace(".JK", ""))}</b></td><td>${o.lots || "-"}</td>
      <td class="priv">${o.avg != null ? fmtRp(o.avg) : "-"}</td>
      <td class="priv ${o.realized >= 0 ? "up" : "down"}">${o.realized ? (o.realized >= 0 ? "+" : "") + fmtRp(o.realized) : "-"}</td></tr>`).join("")
      : "<tr><td colspan='4' class='empty-row'>Belum ada posisi.</td></tr>";
    $("jrPosTable").innerHTML = ph + "<tbody>" + pb + "</tbody>";

    // trade history (newest first)
    const th = `<thead><tr><th>Tgl</th><th>Aksi</th><th>Saham</th><th>Lot</th><th>Harga</th><th>Fee</th><th></th></tr></thead>`;
    const rows = load().slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.seq || 0) - (a.seq || 0));
    const tb = rows.length ? rows.map((t) => `<tr>
      <td>${escHtml(t.date)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side === "buy" ? "Beli" : "Jual"}</td>
      <td>${escHtml(t.ticker.replace(".JK", ""))}</td><td>${t.lots}</td><td>${fmt(t.price)}</td><td>${t.fee ? fmt(t.fee) : "-"}</td>
      <td><button type="button" class="del jr-del" data-id="${escHtml(t.id)}" aria-label="Hapus transaksi">✕</button></td></tr>`).join("")
      : "<tr><td colspan='7' class='empty-row'>Belum ada transaksi.</td></tr>";
    $("jrTable").innerHTML = th + "<tbody>" + tb + "</tbody>";
    $("jrTable").querySelectorAll(".jr-del").forEach((b) => b.onclick = () => {
      const prev = load();
      const removed = prev.find((x) => x.id === b.dataset.id);
      // Mirrors recording: adding a trade changes RDN cash, so deleting one reverses it.
      // Deleting a buy returns (price × shares + fee) to RDN;
      // deleting a sell takes (price × shares − fee) back out of RDN.
      if (removed && window.addRdn) {
        const cash = (+removed.lots || 0) * 100 * (+removed.price || 0), fee = +removed.fee || 0;
        window.addRdn(removed.side === "sell" ? -(cash - fee) : (cash + fee));
      }
      saveJ(prev.filter((x) => x.id !== b.dataset.id)); render();
      if (window.financeRender) { try { window.financeRender(); } catch { /* */ } }
      if (window.toastUndo) window.toastUndo("Transaksi jurnal dihapus.", () => {
        if (removed && window.addRdn) {
          const cash = (+removed.lots || 0) * 100 * (+removed.price || 0), fee = +removed.fee || 0;
          window.addRdn(removed.side === "sell" ? (cash - fee) : -(cash + fee));
        }
        saveJ(prev); render();
        if (window.financeRender) { try { window.financeRender(); } catch { /* */ } }
      });
    });
  }

  // Core trade recording (used by the Jurnal form and Portofolio's Jual button)
  // Replay a ticker's trades in date order. Each sell must be covered by the
  // shares held at that point; returns the uncovered lots and the first gap.
  function shortfalls(list, tk) {
    const trades = list.filter((t) => t.ticker === tk).sort((a, b) =>
      (a.date || "").localeCompare(b.date || "") || (a.seq || 0) - (b.seq || 0));
    let held = 0, missing = 0, first = null;
    for (const t of trades) {
      if (t.side === "buy") { held += t.lots; continue; }
      if (t.lots > held) {
        missing += t.lots - held;
        if (!first) first = { date: t.date, available: held };
      }
      held = Math.max(0, held - t.lots);
    }
    return { missing, first };
  }
  function firstShortfall(list, tk) { return shortfalls(list, tk).first; }

  function addTrade(side, tk, lots, price, fee, date, opts) {
    const trade = { id: uid(), seq: Date.now(), date: date || ymd(), side, ticker: tk, lots, price, fee };
    if (side === "sell") {
      const before = shortfalls(load(), tk), after = shortfalls(load().concat(trade), tk);
      // History that was already inconsistent does not block new, covered sells.
      const shortfall = after.missing > before.missing ? after.first : null;
      if (shortfall) {
        if (!(opts && opts.quiet)) toast(`Penjualan ditolak: per ${shortfall.date} posisi tersedia ${shortfall.available} lot.`);
        return false;
      }
    }
    const a = load(); a.push(trade);
    saveJ(a);
    // RDN cash flow: a sell adds (price × shares − fee), a buy subtracts (price × shares + fee)
    const cash = lots * 100 * price;
    if (window.addRdn) {
      if (side === "sell") { window.addRdn(cash - fee); toast(`Jual dicatat · +${fmtRp(cash - fee)} ke RDN`); }
      else { window.addRdn(-(cash + fee)); toast(`Beli dicatat · −${fmtRp(cash + fee)} dari RDN`); }
    }
    render();
    if (window.financeRender) { try { window.financeRender(); } catch { /* */ } }
    if (!(opts && opts.skipPortoSync) && autoOn()) syncPorto(true);   // auto-sync when enabled
    return true;
  }
  $("jrAdd").onclick = () => {
    const tk = normTicker($("jrTicker").value), lots = parseInt($("jrLots").value, 10), price = window.parseRp($("jrPrice").value);
    const fee = window.parseRp($("jrFee").value), f = isNaN(fee) ? 0 : fee;
    const side = $("jrSide").value;
    if (!tk || isNaN(lots) || lots <= 0 || isNaN(price) || price <= 0) { toast("Isi kode, lot, & harga"); return; }
    addTrade(side, tk, lots, price, f, $("jrDate").value, null);
    $("jrTicker").value = ""; $("jrLots").value = ""; $("jrPrice").value = ""; $("jrFee").value = "";
  };
  // used by Portofolio's "Jual" button (skipPortoSync: Portofolio's own lot change applies)
  window.journalAdd = (side, ticker, lots, price, fee, opts) => {
    ticker = normTicker(ticker); lots = parseInt(lots, 10); price = +price; const f = +fee || 0;
    if (!ticker || !(lots > 0) || !(price > 0)) return false;
    return addTrade(side, ticker, lots, price, f, null, opts);
  };
  // Sync journal positions → Portofolio. silent=true (auto) skips the confirmation and mirrors as is, even empty.
  async function syncPorto(silent) {
    const open = compute().open.filter((o) => o.lots > 0).map((o) => ({ ticker: o.ticker, avg: Math.round(o.avg), lots: o.lots }));
    if (!silent) {
      if (!open.length) { toast("Tidak ada posisi terbuka"); return; }
      if (!(await window.confirmDialog({ title: "Perbarui Portofolio", text: `Ganti Portofolio dengan ${open.length} posisi dari jurnal?`, okLabel: "Perbarui" }))) return;
    }
    if (window.setPortfolio) { window.setPortfolio(open); if (!silent) toast("Portofolio diperbarui dari jurnal"); }
  }
  $("jrToPorto").onclick = () => syncPorto(false);
  const autoChk = $("jrAutoSync");
  if (autoChk) {
    autoChk.checked = autoOn();
    autoChk.onchange = () => { localStorage.setItem(AUTO_KEY, autoChk.checked ? "1" : "0"); if (autoChk.checked) syncPorto(true); };
  }

  window.journalRender = render;
})();
