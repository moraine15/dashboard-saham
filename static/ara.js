/* ara.js - Kalkulator ARA/ARB IDX (14 slot, kustom per hari) + catatan UMA/suspensi.
   Memakai helper global: $, fmt, fmtRp, toast. */
"use strict";
(function () {
  const KEY = "mc_ara";
  const N = 14;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (o) => localStorage.setItem(KEY, JSON.stringify(o));

  // Lowest regular-market price on the IDX.
  const MIN_PRICE = 50;
  // IDX rule (symmetric): auto-reject percentage per reference-price band.
  // Bands use the reference price (previous close), not the price after it moved.
  function pct(p) { if (p <= 200) return 0.35; if (p <= 5000) return 0.25; return 0.20; }
  // Price fraction (tick) per band.
  function tick(p) { p = Math.abs(p); if (p < 200) return 1; if (p < 500) return 2; if (p < 2000) return 5; if (p < 5000) return 10; return 25; }
  function roundTick(p, dir) { const t = tick(p); return dir === "down" ? Math.floor(p / t) * t : dir === "up" ? Math.ceil(p / t) * t : Math.round(p / t) * t; }
  // Tomorrow's ARA limit: the largest rise, rounded down to a valid tick.
  function araLimit(ref) { return roundTick(ref * (1 + pct(ref)), "down"); }
  // Tomorrow's ARB limit: the largest fall, rounded up to a tick, never below the minimum price.
  function arbLimit(ref) { return Math.max(MIN_PRICE, roundTick(ref * (1 - pct(ref)), "up")); }
  // Pure helpers, testable without a DOM.
  window.araMath = { pct, tick, roundTick, araLimit, arbLimit, MIN_PRICE };

  let st = load();
  if (!Array.isArray(st.slots) || st.slots.length !== N) st.slots = Array(N).fill("ara");

  function buildSlots() {
    $("araSlots").innerHTML = st.slots.map((v, i) =>
      `<label class="ara-chip">H${i + 1}
        <select data-i="${i}">
          <option value="ara"${v === "ara" ? " selected" : ""}>ARA</option>
          <option value="arb"${v === "arb" ? " selected" : ""}>ARB</option>
          <option value="flat"${v === "flat" ? " selected" : ""}>Flat</option>
        </select></label>`).join("");
    $("araSlots").querySelectorAll("select").forEach((s) => s.onchange = () => {
      st.slots[+s.dataset.i] = s.value; save(st); calc();
    });
  }

  function calc() {
    const start = window.parseRp($("araStart").value);
    const lot = parseFloat($("araLot").value);
    st.start = $("araStart").value; st.lot = $("araLot").value; save(st);
    if (isNaN(start) || start <= 0) { $("araTable").innerHTML = "<tbody><tr><td class='tiny muted'>Isi harga awal.</td></tr></tbody>"; renderNote(); return; }

    let price = start, streakUp = 0, streakDown = 0;
    const head = `<thead><tr><th>Hari</th><th>Aksi</th><th>Band</th><th>Harga</th><th>Δ Hari</th><th>Kumulatif</th>${!isNaN(lot) ? "<th>Nilai</th>" : ""}<th>Catatan</th></tr></thead>`;
    const rows = [`<tr><td>0</td><td>Awal</td><td>-</td><td>${fmtRp(price)}</td><td>-</td><td>0%</td>${!isNaN(lot) ? `<td>${fmtRp(price * 100 * lot)}</td>` : ""}<td>-</td></tr>`];
    for (let i = 0; i < N; i++) {
      const act = st.slots[i];
      const band = pct(price) * 100;
      const prev = price;
      if (act === "ara") { price = araLimit(prev); streakUp++; streakDown = 0; }
      else if (act === "arb") { price = arbLimit(prev); streakDown++; streakUp = 0; }
      else { streakUp = 0; streakDown = 0; }
      const dDay = prev ? (price - prev) / prev * 100 : 0;
      const cum = (price - start) / start * 100;
      let note = "";
      const streak = act === "ara" ? streakUp : act === "arb" ? streakDown : 0;
      if (streak >= 4) note = `<span class="badge b-high">potensi suspensi (${streak}x ${act.toUpperCase()})</span>`;
      else if (streak >= 2) note = `<span class="badge b-med">potensi UMA (${streak}x ${act.toUpperCase()})</span>`;
      const cls = act === "ara" ? "up" : act === "arb" ? "down" : "muted";
      rows.push(`<tr>
        <td>${i + 1}</td>
        <td class="${cls}">${act === "ara" ? "ARA" : act === "arb" ? "ARB" : "Flat"}</td>
        <td>±${fmt(band, 0)}%</td>
        <td>${fmtRp(price)}</td>
        <td class="${dDay >= 0 ? "up" : "down"}">${dDay >= 0 ? "+" : ""}${fmt(dDay, 1)}%</td>
        <td class="${cum >= 0 ? "up" : "down"}">${cum >= 0 ? "+" : ""}${fmt(cum, 1)}%</td>
        ${!isNaN(lot) ? `<td>${fmtRp(price * 100 * lot)}</td>` : ""}
        <td>${note || "-"}</td></tr>`);
    }
    $("araTable").innerHTML = head + "<tbody>" + rows.join("") + "</tbody>";
    renderNote();
  }

  function renderNote() {
    $("araNote").innerHTML = `
      <b>Aturan Auto Reject (ARA/ARB) IDX, simetris:</b>
      <ul>
        <li>Harga Rp50-Rp200 → <b>±35%</b></li>
        <li>Harga >Rp200-Rp5.000 → <b>±25%</b></li>
        <li>Harga >Rp5.000 → <b>±20%</b></li>
      </ul>
      Persentase memakai <b>harga acuan</b> (penutupan hari sebelumnya) dan harga dibulatkan ke <b>fraksi (tick)</b> yang berlaku, jadi Δ harian bisa sedikit beda dari persen band.
      <br><b>UMA / Suspensi:</b> bila ARA/ARB beruntun atau gerak tak wajar, bursa kerap menerbitkan <b>UMA</b> (peringatan) dan dapat melakukan <b>suspensi sementara</b> (cooling-down). Ini <b>diskresi bursa, bukan rumus pasti</b>, penanda di tabel hanya perkiraan.
      <span class="tiny warn">Simulasi & edukasi, bukan jaminan pergerakan harga.</span>`;
  }

  /* IPO notes / positions */
  const SK = "mc_ipo_saves";
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const saves = () => { try { return JSON.parse(localStorage.getItem(SK)) || []; } catch { return []; } };
  const saveSaves = (a) => localStorage.setItem(SK, JSON.stringify(a));
  let quoteCache = {}, linkedTotal = 0, linkedCost = 0;
  window.ipoLinkedValue = () => linkedTotal;
  window.ipoLinkedPnl = () => linkedTotal - linkedCost;

  async function getQuote(tk) {
    if (quoteCache[tk] !== undefined) return quoteCache[tk];
    try { const d = await (await fetch("/api/quote/" + encodeURIComponent(tk))).json(); quoteCache[tk] = (d && d.price) || null; }
    catch { quoteCache[tk] = null; }
    return quoteCache[tk];
  }
  function refreshFinance() { if (window.financeRender && !$("tabKeuangan").classList.contains("hidden")) window.financeRender(); }

  async function renderSaves() {
    const list = saves();
    if (!list.length) {
      $("ipoTotals").innerHTML = "";
      $("ipoTable").innerHTML = "<tbody><tr><td class='empty-row'>Belum ada catatan. Tambah di atas.</td></tr></tbody>";
      linkedTotal = 0; linkedCost = 0; refreshFinance(); return;
    }
    await Promise.all(list.map((e) => getQuote(normTicker(e.ticker))));
    let cost = 0, val = 0, pnl = 0; linkedTotal = 0; linkedCost = 0;
    const head = `<thead><tr><th>Saham</th><th>Lot</th><th>Beli</th><th>Sekarang</th><th>%</th><th>Unreal P/L</th><th>ARA besok</th><th>ARB besok</th><th>Kekayaan</th><th></th></tr></thead>`;
    const body = list.map((e) => {
      const tk = normTicker(e.ticker), price = quoteCache[tk], shares = e.lots * 100, c = shares * e.buy;
      cost += c;
      if (price == null) {
        return `<tr><td><b>${escHtml(tk.replace(".JK", ""))}</b></td><td>${escHtml(e.lots)}</td><td>${fmt(e.buy)}</td><td colspan="6" class="tiny muted">harga tak tersedia</td><td><span class="del ipo-del" data-id="${escHtml(e.id)}">✕</span></td></tr>`;
      }
      const v = shares * price, p = v - c; val += v; pnl += p; if (e.linked) { linkedTotal += v; linkedCost += c; }
      const araT = araLimit(price), arbT = arbLimit(price);
      const cls = p >= 0 ? "up" : "down";
      return `<tr>
        <td><b>${escHtml(tk.replace(".JK", ""))}</b></td><td>${escHtml(e.lots)}</td><td>${fmt(e.buy)}</td>
        <td>${fmt(price)}</td><td class="${cls}">${((price - e.buy) / e.buy * 100).toFixed(1)}%</td>
        <td class="priv ${cls}">${p >= 0 ? "+" : ""}${fmtRp(p)}</td>
        <td class="up">${fmt(araT)}</td><td class="down">${fmt(arbT)}</td>
        <td><button class="mini ipo-link ${e.linked ? "" : "del"}" data-id="${escHtml(e.id)}" title="Hitung ke kekayaan">${e.linked ? "✓" : "+"}</button></td>
        <td><span class="del ipo-del" data-id="${escHtml(e.id)}">✕</span></td></tr>`;
    }).join("");
    $("ipoTable").innerHTML = head + "<tbody>" + body + "</tbody>";
    const plc = pnl >= 0 ? "up" : "down";
    $("ipoTotals").innerHTML = `
      <div class="pf-card"><div class="lbl">Modal</div><div class="val priv">${fmtRp(cost)}</div></div>
      <div class="pf-card"><div class="lbl">Nilai Sekarang</div><div class="val priv">${fmtRp(val)}</div></div>
      <div class="pf-card"><div class="lbl">Unrealized P/L</div><div class="val priv ${plc}">${pnl >= 0 ? "+" : ""}${fmtRp(pnl)}</div></div>
      <div class="pf-card"><div class="lbl">Masuk Kekayaan</div><div class="val priv">${fmtRp(linkedTotal)}</div></div>`;
    $("ipoTable").querySelectorAll(".ipo-del").forEach((b) => b.onclick = () => { saveSaves(saves().filter((x) => x.id !== b.dataset.id)); renderSaves(); });
    $("ipoTable").querySelectorAll(".ipo-link").forEach((b) => b.onclick = () => { const a = saves(); const it = a.find((x) => x.id === b.dataset.id); if (!it) return; it.linked = !it.linked; saveSaves(a); renderSaves(); });
    refreshFinance();
  }

  $("ipoAdd").onclick = () => {
    const tk = normTicker($("ipoTicker").value), buy = window.parseRp($("ipoBuy").value), lots = parseInt($("ipoLots").value, 10);
    if (!tk || isNaN(buy) || buy <= 0 || isNaN(lots) || lots <= 0) { toast("Isi kode, harga beli, & lot"); return; }
    const a = saves(); a.push({ id: uid(), ticker: tk, buy, lots, linked: false }); saveSaves(a);
    $("ipoTicker").value = ""; $("ipoBuy").value = ""; $("ipoLots").value = ""; delete quoteCache[tk];
    renderSaves();
  };
  $("ipoRefresh").onclick = () => { quoteCache = {}; renderSaves(); };

  function render() {
    if ($("araStart").value === "" && st.start) $("araStart").value = st.start;
    if ($("araLot").value === "" && st.lot) $("araLot").value = st.lot;
    buildSlots();
    calc();
    renderSaves();
  }
  // Render at load: linked positions count toward net worth, and an IPO pane that
  // was open before a reload needs its empty state.
  renderSaves();

  $("araCalc").onclick = calc;
  $("araAllAra").onclick = () => { st.slots = Array(N).fill("ara"); save(st); buildSlots(); calc(); };
  $("araAllArb").onclick = () => { st.slots = Array(N).fill("arb"); save(st); buildSlots(); calc(); };
  $("araReset").onclick = () => { st.slots = Array(N).fill("ara"); $("araStart").value = ""; $("araLot").value = ""; st.start = ""; st.lot = ""; save(st); buildSlots(); calc(); };

  window.araRender = render;
})();
