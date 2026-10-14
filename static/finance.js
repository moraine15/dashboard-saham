/* finance.js - Tab Keuangan (tabungan, arus kas, target, hutang, grafik kekayaan, AI)
   Memakai helper global dari app.js: $, fmt, fmtRp, fmtBig, toast. Data tersimpan di localStorage. */
"use strict";
(function () {
  const FK = {
    acc: "mc_fin_accounts", tx: "mc_fin_tx", rec: "mc_fin_recurring",
    debt: "mc_fin_debts", tgt: "mc_fin_targets", set: "mc_fin_settings", hist: "mc_fin_hist",
    ath: "mc_fin_ath",
  };
  const PF_KEY = "saham_portfolio_v1";

  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch { return def; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const p2 = (n) => String(n).padStart(2, "0");
  const ymd = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const ym = (s) => s.slice(0, 7);
  const curYM = () => ymd().slice(0, 7);
  const nextYM = (y) => { let [a, b] = y.split("-").map(Number); b++; if (b > 12) { b = 1; a++; } return `${a}-${p2(b)}`; };
  const daysInMonth = (ymStr) => { const [y, m] = ymStr.split("-").map(Number); return new Date(y, m, 0).getDate(); };
  const clampDay = (d) => Math.min(31, Math.max(1, parseInt(d, 10) || 1));
  const schedDate = (ymStr, day) => `${ymStr}-${p2(Math.min(clampDay(day), daysInMonth(ymStr)))}`;

  let finStockValue = null, finStockPnl = null;   // stock value and unrealized P/L (cached)
  let stockKnown = false, stockFailed = false, stockFetch = null;
  let finChart = null, finSeries = null;
  let recurringDay = "";

  /* ---------- data getters ---------- */
  const accounts = () => load(FK.acc, []);
  const txs = () => load(FK.tx, []);
  const recs = () => load(FK.rec, []);
  const debts = () => load(FK.debt, []);
  const targets = () => load(FK.tgt, { monthly: 0, yearly: 0 });
  const settings = () => {
    const value = load(FK.set, { inclInvestments: false });
    if (value.inclInvestments == null) {
      value.inclInvestments = !!value.inclStocks;
      save(FK.set, value);
    }
    return value;
  };

  const accName = (id) => { const a = accounts().find((x) => x.id === id); return a ? a.name : "-"; };
  const totalCash = () => accounts().reduce((s, a) => s + (+a.balance || 0), 0);
  const ipoLinked = () => (window.ipoLinkedValue ? (window.ipoLinkedValue() || 0) : 0);
  const rdnCash = () => (window.rdnCash ? (window.rdnCash() || 0) : 0);
  const investmentValue = () => window.investmentTotals ? window.investmentTotals() : {
    value: finStockValue || 0, pl: finStockPnl || 0, stocks: { value: finStockValue || 0 }, funds: { value: 0 }, bonds: { value: 0 },
  };
  const netWorth = () => totalCash() + rdnCash() + (settings().inclInvestments ? investmentValue().value : 0) + ipoLinked();

  function adjustAcc(id, delta) {
    const a = accounts(); const acc = a.find((x) => x.id === id); if (!acc) return;
    acc.balance = (+acc.balance || 0) + delta; save(FK.acc, a);
  }

  /* ---------- recurring schedule (pure, testable) ----------
     Mengembalikan daftar jatuh tempo {ym, date} dari bulan setelah lastYM (atau startYM)
     sampai hari ini. Lastaa tidak di-mutasi di sini; pemanggil yang menyimpannya.
     Catch-up: semua bulan terlewat ikut terbit. Hari 29-31 di bulan pendek di-clamp
     ke hari terakhir bulan itu. Perbandingan tanggal memakai string YYYY-MM-DD lokal
     (tidak pernah new Date('YYYY-MM-DD')) agar aman timezone. */
  function dueSchedule(rec, todayStr) {
    const out = [];
    const day = rec.day || 1;
    let from = rec.lastYM ? nextYM(rec.lastYM) : (rec.startYM || todayStr.slice(0, 7));
    let guard = 0;
    while (guard < 240) {
      const dt = schedDate(from, day);
      if (dt > todayStr) break;   // not due yet
      out.push({ ym: from, date: dt });
      from = nextYM(from); guard++;
    }
    return out;
  }
  window.financeMath = { dueSchedule, schedDate, daysInMonth, nextYM, clampDay };

  /* ---------- recurring auto-post ---------- */
  function applyRecurring() {
    const rs = recs(); let changed = false;
    const today = ymd();
    rs.forEach((r) => {
      if (r.mode === "manual") return;   // template: only recorded when its button is clicked
      const due = dueSchedule(r, today);
      due.forEach(({ ym: fromYM, date: dt }) => {
        const t = txs();
        const origin = `recurring:${r.id}:${dt}`;
        if (!t.some((item) => item.origin === origin)) {
          // The id is derived from the schedule so two devices posting it merge into one.
          t.push({ id: origin, origin, date: dt, type: r.type, amount: +r.amount, accId: r.accId, cat: r.label || "Rutin", note: "(otomatis bulanan)" });
          save(FK.tx, t);
          adjustAcc(r.accId, r.type === "in" ? +r.amount : -(+r.amount));
        }
        r.lastYM = fromYM; changed = true;
      });
    });
    if (changed) save(FK.rec, rs);
  }

  // Post due recurring items once per calendar day, also when a tab is left open overnight.
  function runRecurringOncePerDay() {
    if (recurringDay === ymd()) return false;
    recurringDay = ymd();
    applyRecurring();
    return true;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && runRecurringOncePerDay() && !$("tabKeuangan").classList.contains("hidden")) render();
  });

  /* ---------- net worth history ---------- */
  function snapshotToday() {
    const h = load(FK.hist, {});
    h[ymd()] = Math.round(netWorth());
    save(FK.hist, h);
    return h;
  }

  /* ---------- stock value ---------- */
  async function fetchStockValue() {
    const pf = load(PF_KEY, []);
    if (!pf.length) { finStockValue = 0; stockKnown = true; return; }
    try {
      const r = await fetch("/api/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holdings: pf }) });
      const d = await r.json();
      if (!r.ok || !d.totals) throw new Error("portfolio");
      finStockValue = d.totals.value;
      finStockPnl = d.totals.pl;
      stockKnown = true;
      if (window.investmentRefreshStocks) window.investmentRefreshStocks(d.totals);
    } catch { finStockValue = 0; finStockPnl = 0; stockFailed = true; }
  }

  /* ---------- summaries ---------- */
  function cashFlow(rangeKey) {
    const now = new Date();
    let from;
    if (rangeKey === "day") from = ymd(now);
    else if (rangeKey === "week") { const d = new Date(now); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); from = ymd(d); }
    else if (rangeKey === "year") from = `${now.getFullYear()}-01-01`;
    else from = `${curYM()}-01`; // month
    let inc = 0, exp = 0;
    // Transfers between own accounts move money but are neither income nor spending.
    txs().forEach((t) => { if (t.date >= from && !t.transfer) { if (t.type === "in") inc += +t.amount; else exp += +t.amount; } });
    return { inc, exp, net: inc - exp, from };
  }
  function monthNet() { const c = cashFlow("month"); return c.net; }
  function yearNet() { const c = cashFlow("year"); return c.net; }

  /* ---------- RENDER ---------- */
  // three net-worth layers for the ATH
  function layers() {
    const cash = totalCash() + rdnCash();
    const stockVal = investmentValue().value + (window.ipoLinkedValue ? window.ipoLinkedValue() : 0);
    const goods = window.barangAssetValue ? (window.barangAssetValue() || 0) : 0;
    return { cash, stockVal, goods, l1: cash, l2: cash + stockVal, l3: cash + stockVal + goods };
  }
  function updateAth() {
    const L = layers(); const ath = load(FK.ath, {}); const today = ymd();
    [["cash", L.l1], ["stocks", L.l2], ["all", L.l3]].forEach(([k, v]) => {
      if (!ath[k] || v > ath[k].val) ath[k] = { val: v, date: today };
    });
    save(FK.ath, ath);
    return { L, ath };
  }

  function render() {
    runRecurringOncePerDay();
    // Stock value is loaded once. History and all-time highs are only written
    // with a known value, otherwise today's entry would flip between totals.
    const holdings = load(PF_KEY, []).length > 0;
    if (holdings && !stockKnown && !stockFailed && !stockFetch) {
      stockFetch = fetchStockValue().finally(() => { stockFetch = null; render(); });
    }
    if (!holdings || stockKnown) { snapshotToday(); updateAth(); }
    $("finInclStocks").checked = settings().inclInvestments;
    renderSummary();
    renderAth();
    renderAccounts();
    fillAccountSelects();
    renderTargets();
    renderDebts();
    renderTxTable();
    renderRecs();
    renderChart();
    if (!$("txDate").value) $("txDate").value = ymd();
    if (window.formatMoneyAll) window.formatMoneyAll($("tabKeuangan"));
  }

  function renderSummary() {
    const m = cashFlow("month");
    const nw = netWorth();
    const incl = settings().inclInvestments;
    const investments = investmentValue();
    const sv = incl ? investments.value : 0;
    const netCls = m.net >= 0 ? "up" : "down";
    // unrealized P/L of all investments + IPO (shown when investments are included)
    const ipoPnl = window.ipoLinkedPnl ? (window.ipoLinkedPnl() || 0) : 0;
    const unreal = (incl ? (investments.pl || 0) : 0) + ipoPnl;
    const showUnreal = incl || ipoPnl !== 0;
    const upCard = showUnreal
      ? `<div class="pf-card"><div class="lbl">Unrealized Investasi/IPO</div><div class="val priv ${unreal >= 0 ? "up" : "down"}">${unreal >= 0 ? "+" : ""}${fmtRp(unreal)}</div></div>` : "";
    const rdn = rdnCash();
    const rdnCard = rdn ? `<div class="pf-card"><div class="lbl">Kas RDN (broker)</div><div class="val priv">${fmtRp(rdn)}</div></div>` : "";
    $("finSummary").innerHTML = `
      <div class="pf-card"><div class="lbl">Kas / Tabungan</div><div class="val priv">${fmtRp(totalCash())}</div></div>
      <div class="pf-card"><div class="lbl">Kekayaan Total</div><div class="val priv">${fmtRp(nw)}</div></div>
      ${rdnCard}
      <div class="pf-card"><div class="lbl">Nilai Investasi</div><div class="val priv">${incl ? fmtRp(sv) : "-"}</div></div>
      ${upCard}
      <div class="pf-card"><div class="lbl">Pemasukan (bln ini)</div><div class="val priv up">${fmtRp(m.inc)}</div></div>
      <div class="pf-card"><div class="lbl">Pengeluaran (bln ini)</div><div class="val priv down">${fmtRp(m.exp)}</div></div>
      <div class="pf-card"><div class="lbl">Selisih (bln ini)</div><div class="val priv ${netCls}">${m.net >= 0 ? "+" : ""}${fmtRp(m.net)}</div></div>`;
  }

  function renderAth() {
    const { L, ath } = updateAth();
    const row = (title, cur, a) => {
      // Nothing to celebrate until there is a positive record.
      if (!a || !(a.val > 0)) {
        return `<div class="ath-row"><div class="ath-nm">${title}</div><div class="ath-vals"><span class="tiny muted">Belum ada rekor</span></div></div>`;
      }
      const pct = cur / a.val * 100;
      const atAth = cur >= a.val - 1;
      return `<div class="ath-row">
        <div class="ath-nm">${title}${atAth ? ' <span class="badge b-low">ATH baru!</span>' : ""}</div>
        <div class="ath-vals"><span class="ath-ath">ATH <span class="priv">${fmtRp(a ? a.val : cur)}</span></span>
          <span class="tiny muted">${a ? a.date : ""} · sekarang <span class="priv">${fmtRp(cur)}</span> (${fmt(pct, 0)}% dari ATH)</span></div></div>`;
    };
    $("finAth").innerHTML =
      row("Uang saja", L.l1, ath.cash) +
      row("Uang + Investasi", L.l2, ath.stocks) +
      row("Uang + Investasi + Barang", L.l3, ath.all);
  }

  function renderAccounts() {
    const a = accounts();
    $("accList").innerHTML = a.length ? a.map((x) => {
      const min = (x.min === "" || x.min == null) ? null : +x.min;
      const low = (min != null) && (+x.balance < min);
      return `
      <div class="fin-item ${low ? "acc-low" : ""}" data-id="${escHtml(x.id)}">
        <span class="drag-handle" title="Geser untuk urutkan">☰</span>
        <input class="edit acc-name" data-id="${escHtml(x.id)}" value="${escHtml(x.name)}" title="Nama akun (bisa diedit)">
        <input class="edit acc-bal priv-inp money" data-id="${escHtml(x.id)}" type="text" inputmode="numeric" value="${window.toMoneyField(x.balance)}" title="Saldo">
        <input class="edit acc-min money priv-inp" data-id="${escHtml(x.id)}" type="text" inputmode="numeric" value="${window.toMoneyField(x.min)}" placeholder="batas" title="Batas peringatan: merah bila saldo di bawah ini">
        <button class="mini acc-save" data-id="${escHtml(x.id)}" title="Simpan akun">✓</button>
        <button class="mini del acc-del" data-id="${escHtml(x.id)}" title="Hapus akun">✕</button>
        ${low ? `<span class="warn tiny acc-warn">di bawah <span class="priv">${fmtRp(min)}</span></span>` : ""}
      </div>`;
    }).join("") : "<div class='empty-row'>Belum ada akun. Tambah di atas.</div>";
    $("accList").querySelectorAll(".acc-save").forEach((b) => b.onclick = () => {
      const item = b.closest(".fin-item"); if (!item) return;
      const name = item.querySelector(".acc-name").value.trim();
      const v = window.parseRp(item.querySelector(".acc-bal").value);
      const minRaw = item.querySelector(".acc-min").value.trim();
      const a2 = accounts(); const acc = a2.find((x) => x.id === b.dataset.id); if (!acc) return;
      if (name) acc.name = name;
      if (!isNaN(v)) acc.balance = v;
      acc.min = minRaw === "" ? "" : (window.parseRp(minRaw) || 0);
      save(FK.acc, a2); render(); toast("Akun diperbarui");
    });
    $("accList").querySelectorAll(".acc-del").forEach((b) => b.onclick = () => {
      const prev = accounts(); save(FK.acc, prev.filter((x) => x.id !== b.dataset.id)); render();
      if (window.toastUndo) window.toastUndo("Akun dihapus (transaksi tetap ada).", () => { save(FK.acc, prev); render(); });
    });
    if (window.makeSortable) window.makeSortable($("accList"), ".fin-item", (els) => {
      const order = els.map((e) => e.dataset.id);
      const a2 = accounts(); a2.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id)); save(FK.acc, a2);
    }, ".drag-handle");
  }

  function fillAccountSelects() {
    const a = accounts();
    const opts = a.map((x) => `<option value="${escHtml(x.id)}">${escHtml(x.name)}</option>`).join("");
    ["txAcc", "recAcc", "buyAcc"].forEach((id) => { const el = $(id); const cur = el.value; el.innerHTML = opts || "<option value=''>(buat akun dulu)</option>"; if (cur) el.value = cur; });
  }

  function renderTargets() {
    const t = targets();
    $("tgtMonth").value = window.toMoneyField(t.monthly || ""); $("tgtYear").value = window.toMoneyField(t.yearly || "");
    const mn = monthNet(), yn = yearNet();
    const bar = (val, tgt) => {
      if (!tgt || tgt <= 0) return "<span class='tiny muted'>belum diset</span>";
      const pct = Math.max(0, Math.min(100, val / tgt * 100));
      const cls = val >= tgt ? "var(--up)" : "var(--ink)";
      return `<div class="wbar"><span class="wbar-track"><span class="wbar-fill" style="width:${pct}%;background:${cls}"></span></span><span class="wbar-val">${fmt(pct, 0)}%</span></div>
        <span class="tiny muted priv">${fmtRp(val)} / ${fmtRp(tgt)}</span>`;
    };
    $("tgtProgress").innerHTML = `
      <div><span class="tiny muted">Target bulan ini</span>${bar(mn, t.monthly)}</div>
      <div><span class="tiny muted">Target tahun ini</span>${bar(yn, t.yearly)}</div>`;
  }

  function renderDebts() {
    const d = debts();
    const out = d.filter((x) => !x.settled).reduce((s, x) => s + (+x.amount || 0), 0);
    const head = `<div class="tiny muted" style="margin-bottom:6px">Belum kembali: <b class="warn priv">${fmtRp(out)}</b></div>`;
    $("debtList").innerHTML = head + (d.length ? d.map((x) => `
      <div class="fin-item ${x.settled ? "settled" : ""}" data-id="${escHtml(x.id)}">
        <span class="nm">${escHtml(x.who)}</span><span class="amt priv">${fmtRp(x.amount)}</span>
        <button class="mini debt-toggle" data-id="${escHtml(x.id)}" title="${x.settled ? "Tandai belum" : "Tandai sudah kembali"}">${x.settled ? "↩" : "✓"}</button>
        <button class="mini del debt-del" data-id="${escHtml(x.id)}">✕</button>
      </div>`).join("") : "<div class='empty-row'>Belum ada catatan.</div>");
    $("debtList").querySelectorAll(".debt-toggle").forEach((b) => b.onclick = () => { const a = debts(); const it = a.find((x) => x.id === b.dataset.id); if (!it) return; it.settled = !it.settled; save(FK.debt, a); render(); });
    $("debtList").querySelectorAll(".debt-del").forEach((b) => b.onclick = () => { save(FK.debt, debts().filter((x) => x.id !== b.dataset.id)); render(); });
  }

  function renderTxTable() {
    const range = $("txRange").value;
    const cf = cashFlow(range);
    $("txRangeSummary").innerHTML = `Masuk <b class="up priv">${fmtRp(cf.inc)}</b> · Keluar <b class="down priv">${fmtRp(cf.exp)}</b> · Selisih <b class="priv ${cf.net >= 0 ? "up" : "down"}">${fmtRp(cf.net)}</b>`;
    const rows = txs().filter((t) => t.date >= cf.from).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200);
    const head = `<thead><tr><th>Tanggal</th><th>Jenis</th><th>Akun</th><th>Kategori</th><th>Nominal</th><th></th></tr></thead>`;
    const body = rows.length ? rows.map((t) => `<tr data-id="${escHtml(t.id)}">
      <td>${escHtml(t.date)}</td><td class="${t.transfer ? "muted" : t.type === "in" ? "up" : "down"}">${t.transfer ? "Transfer" : t.type === "in" ? "Masuk" : "Keluar"}</td>
      <td>${escHtml(accName(t.accId))}</td><td>${escHtml(t.cat || "-")}${t.note ? ` <span class='tiny muted'>${escHtml(t.note)}</span>` : ""}</td>
      <td class="priv ${t.type === "in" ? "up" : "down"}">${t.type === "in" ? "+" : "-"}${fmt(t.amount)}</td>
      <td><span class="del tx-del" data-id="${escHtml(t.id)}">✕</span></td></tr>`).join("") : "<tr><td colspan='6' class='empty-row'>Belum ada transaksi pada rentang ini.</td></tr>";
    $("txTable").innerHTML = head + "<tbody>" + body + "</tbody>";
    $("txTable").querySelectorAll(".tx-del").forEach((b) => b.onclick = () => {
      const t = txs(); const it = t.find((x) => x.id === b.dataset.id); if (!it) return;
      const prevTx = t.slice(), prevAcc = accounts();
      adjustAcc(it.accId, it.type === "in" ? -(+it.amount) : (+it.amount)); // reverse the balance
      save(FK.tx, t.filter((x) => x.id !== b.dataset.id)); render();
      if (window.toastUndo) window.toastUndo("Transaksi dihapus.", () => { save(FK.tx, prevTx); save(FK.acc, prevAcc); render(); });
    });
  }

  function renderRecs() {
    const r = recs();
    $("recList").innerHTML = r.length ? r.map((x) => {
      const manual = x.mode === "manual";
      const meta = manual ? "template (klik)" : "tiap tgl " + (x.day || 1);
      return `
      <div class="fin-item" data-id="${escHtml(x.id)}">
        <span class="nm">${escHtml(x.label || "(tanpa label)")} <span class="tiny muted">${escHtml(accName(x.accId))} · ${meta}</span></span>
        <input class="edit rec-day" data-id="${escHtml(x.id)}" type="number" min="1" max="31" step="1" value="${x.day || 1}" title="Tanggal posting tiap bulan (mode otomatis)" aria-label="Tanggal posting" ${manual ? "disabled style='opacity:.4'" : ""}>
        <span class="amt priv ${x.type === "in" ? "up" : "down"}">${x.type === "in" ? "+" : "-"}${fmtRp(x.amount)}/bln</span>
        ${manual ? `<button class="mini rec-post" data-id="${escHtml(x.id)}" title="Catat sekarang ke ${x.type === "in" ? "pemasukan" : "pengeluaran"}">▶ Catat</button>` : `<button class="mini rec-daysave" data-id="${escHtml(x.id)}" title="Simpan tanggal">✓</button>`}
        <button class="mini del rec-del" data-id="${escHtml(x.id)}">✕</button>
      </div>`;
    }).join("") : "<div class='empty-row'>Belum ada item rutin.</div>";
    $("recList").querySelectorAll(".rec-post").forEach((b) => b.onclick = () => {
      const x = recs().find((r2) => r2.id === b.dataset.id); if (!x) return;
      const t = txs(); t.push({ id: uid(), date: ymd(), type: x.type, amount: +x.amount, accId: x.accId, cat: x.label || "Rutin", note: "(template)" });
      save(FK.tx, t); adjustAcc(x.accId, x.type === "in" ? +x.amount : -(+x.amount));
      render(); toast(`"${x.label || "Template"}" dicatat ${fmtRp(x.amount)}`);
    });
    $("recList").querySelectorAll(".rec-daysave").forEach((b) => b.onclick = () => {
      const item = b.closest(".fin-item"); const inp = item && item.querySelector(".rec-day"); if (!inp) return;
      const rs = recs(); const it = rs.find((x) => x.id === b.dataset.id);
      if (it) { it.day = clampDay(inp.value); save(FK.rec, rs); toast(`Tanggal "${it.label || "rutin"}" → tgl ${it.day}`); render(); }
    });
    $("recList").querySelectorAll(".rec-del").forEach((b) => b.onclick = () => { const prev = recs(); save(FK.rec, prev.filter((x) => x.id !== b.dataset.id)); render(); if (window.toastUndo) window.toastUndo("Rutin dihapus.", () => { save(FK.rec, prev); render(); }); });
  }

  function renderChart() {
    const h = load(FK.hist, {});
    let keys = Object.keys(h).sort();
    const days = +$("finRange").value;
    if (days > 0) { const cut = ymd(new Date(Date.now() - days * 864e5)); keys = keys.filter((k) => k >= cut); }
    const data = keys.map((k) => ({ time: k, value: h[k] }));
    const el = $("finChart");
    if (finChart) { try { finChart.remove(); } catch { /* */ } finChart = null; }
    if (!window.LightweightCharts || data.length < 1) { el.innerHTML = "<div class='tiny muted' style='padding:20px'>Belum cukup data. Kekayaan dicatat otomatis tiap hari Anda membuka tab ini.</div>"; $("finDelta").textContent = ""; return; }
    el.innerHTML = "";
    const cc = window.chartColors();
    finChart = LightweightCharts.createChart(el, {
      layout: { background: { color: cc.bg }, textColor: cc.text },
      grid: { vertLines: { color: cc.grid }, horzLines: { color: cc.grid } },
      rightPriceScale: { borderColor: cc.grid }, timeScale: { borderColor: cc.grid }, autoSize: true, height: 240,
      localization: { priceFormatter: (p) => fmt(p) },
    });
    finSeries = finChart.addAreaSeries({ lineColor: cc.ink, topColor: cc.ink + "22", bottomColor: cc.ink + "00", lineWidth: 2 });
    finSeries.setData(data);
    finChart.timeScale().fitContent();
    window.fitChartOnResize(finChart, el);
    if (data.length >= 2) {
      const delta = data[data.length - 1].value - data[0].value;
      const pct = data[0].value ? delta / Math.abs(data[0].value) * 100 : 0;
      $("finDelta").innerHTML = `Perubahan periode: <b class="priv ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${fmtRp(delta)} (${fmt(pct, 1)}%)</b> · dari ${data[0].time} ke ${data[data.length - 1].time}`;
    } else $("finDelta").textContent = "Catatan kekayaan baru dimulai hari ini.";
  }

  /* ---------- actions ---------- */
  function addAccount() {
    const name = $("accName").value.trim(); const bal = window.parseRp($("accBal").value);
    if (!name) { toast("Isi nama akun"); return; }
    const a = accounts(); a.push({ id: uid(), name, balance: isNaN(bal) ? 0 : bal }); save(FK.acc, a);
    $("accName").value = ""; $("accBal").value = ""; render();
  }
  function addTx() {
    const acc = $("txAcc").value; if (!acc) { toast("Buat akun dulu"); return; }
    const amt = window.parseRp($("txAmt").value); if (isNaN(amt) || amt <= 0) { toast("Nominal tidak valid"); return; }
    const type = $("txType").value, date = $("txDate").value || ymd();
    const t = txs(); t.push({ id: uid(), date, type, amount: amt, accId: acc, cat: $("txCat").value.trim(), note: $("txNote").value.trim() }); save(FK.tx, t);
    adjustAcc(acc, type === "in" ? amt : -amt);
    $("txAmt").value = ""; $("txCat").value = ""; $("txNote").value = ""; render();
  }
  function addRec() {
    const acc = $("recAcc").value; if (!acc) { toast("Buat akun dulu"); return; }
    const amt = window.parseRp($("recAmt").value); if (isNaN(amt) || amt <= 0) { toast("Nominal tidak valid"); return; }
    const day = clampDay($("recDay").value);
    const mode = $("recMode") ? $("recMode").value : "auto";
    const r = recs(); r.push({ id: uid(), type: $("recType").value, amount: amt, accId: acc, label: $("recLabel").value.trim(), day, mode, startYM: curYM(), lastYM: "" });
    save(FK.rec, r);
    $("recAmt").value = ""; $("recLabel").value = ""; $("recDay").value = "";
    applyRecurring(); render();
    toast(mode === "manual" ? "Template rutin disimpan · klik ▶ Catat untuk memasukkan" : `Item rutin ditambah · otomatis tiap tgl ${day}`);
  }
  function saveTargets() { save(FK.tgt, { monthly: window.parseRp($("tgtMonth").value) || 0, yearly: window.parseRp($("tgtYear").value) || 0 }); render(); toast("Target disimpan"); }
  function addDebt() {
    const who = $("debtWho").value.trim(); const amt = window.parseRp($("debtAmt").value);
    if (!who || isNaN(amt)) { toast("Isi keperluan & nominal"); return; }
    const d = debts(); d.push({ id: uid(), who, amount: amt, settled: false }); save(FK.debt, d);
    $("debtWho").value = ""; $("debtAmt").value = ""; render();
  }
  let buyPending = null;
  function calcBuy() {
    const price = window.parseRp($("buyPrice").value); const acc = $("buyAcc").value;
    if (isNaN(price) || price <= 0) { $("buyResult").innerHTML = "Masukkan harga yang valid."; return; }
    const nw = netWorth(); const accBalEl = accounts().find((x) => x.id === acc);
    const after = nw - price; const accAfter = accBalEl ? (+accBalEl.balance - price) : null;
    $("buyResult").innerHTML = `Harga: <b>${fmtRp(price)}</b><br>Kekayaan sekarang: <b class="priv">${fmtRp(nw)}</b><br>Kekayaan setelah beli: <b class="priv ${after >= 0 ? "" : "down"}">${fmtRp(after)}</b>`
      + (accBalEl ? `<br>Saldo <b>${escHtml(accBalEl.name)}</b> setelah: <b class="priv ${accAfter >= 0 ? "" : "down"}">${fmtRp(accAfter)}</b>${accAfter < 0 ? " <span class='warn tiny'>(saldo akun tak cukup)</span>" : ""}` : "");
    $("buyResult").classList.remove("muted");
    buyPending = { name: $("buyName").value.trim() || "Barang", price, acc };
    $("buyExec").classList.remove("hidden");
  }
  function execBuy() {
    if (!buyPending || !buyPending.acc) { toast("Hitung dulu & pilih akun"); return; }
    const t = txs(); t.push({ id: uid(), date: ymd(), type: "out", amount: buyPending.price, accId: buyPending.acc, cat: "Belanja", note: buyPending.name }); save(FK.tx, t);
    adjustAcc(buyPending.acc, -buyPending.price);
    $("buyExec").classList.add("hidden"); $("buyName").value = ""; $("buyPrice").value = "";
    buyPending = null; render(); toast("Pengeluaran dicatat");
  }

  async function finAi() {
    const out = $("finAiOut"); out.classList.remove("muted"); out.textContent = "Menganalisis keuangan…";
    const m = cashFlow("month"), y = cashFlow("year"), t = targets();
    const ctx = {
      ticker: "KEUANGAN-PRIBADI",
      kekayaan: Math.round(netWorth()), kas: Math.round(totalCash()),
      nilaiInvestasi: settings().inclInvestments ? Math.round(investmentValue().value || 0) : null,
      akun: accounts().map((a) => ({ nama: a.name, saldo: Math.round(a.balance) })),
      arusKasBulanIni: { masuk: Math.round(m.inc), keluar: Math.round(m.exp), selisih: Math.round(m.net) },
      arusKasTahunIni: { selisih: Math.round(y.net) },
      target: t, hutangBelumKembali: Math.round(debts().filter((d) => !d.settled).reduce((s, d) => s + (+d.amount || 0), 0)),
    };
    const q = "Ini ringkasan keuangan pribadi saya (Rupiah). Tinjau kondisi keuangan: arus kas, rasio pengeluaran, progres target, dan hutang/reimburse. Beri 3-5 observasi & saran praktis yang membangun, objektif, sebut risiko. Ini bukan nasihat keuangan profesional.";
    try {
      const d = await (await fetch("/api/ai/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: ctx, question: q }) })).json();
      out.textContent = d.text || d.error || "Tidak ada jawaban.";
      if (d.enabled === false && d.hint) out.textContent += "\n\n" + d.hint;
    } catch (e) { out.textContent = "Gagal: " + e.message; }
  }

  /* ---------- wiring (the DOM is ready: finance.js loads at the end of body) ---------- */
  $("accAdd").onclick = addAccount;
  $("txAdd").onclick = addTx;
  $("recAdd").onclick = addRec;
  $("tgtSave").onclick = saveTargets;
  $("debtAdd").onclick = addDebt;
  $("buyCalc").onclick = calcBuy;
  $("buyExec").onclick = execBuy;
  $("finAiBtn").onclick = finAi;
  $("txRange").onchange = renderTxTable;
  $("finRange").onchange = renderChart;
  $("finInclStocks").onchange = (e) => { const s = settings(); s.inclInvestments = e.target.checked; save(FK.set, s); render(); };

  window.financeRender = render;

  /* ---------- API for other modules (e.g. Barang) ---------- */
  window.financeAccounts = () => accounts().map((a) => ({ id: a.id, name: a.name }));
  window.financeCash = () => totalCash();
  window.financeNetWorth = () => netWorth();
  // The record that counts the same things as netWorth(), for Ringkasan.
  window.financeAth = () => load(FK.ath, {})[settings().inclInvestments ? "stocks" : "cash"] || null;
  window.financePostIncome = (request) => {
    const postingId = request.postingId || uid();
    const result = window.InvestmentCore.applyIncomePosting(
      { accounts: accounts(), transactions: txs() },
      { ...request, postingId, date: request.date || ymd() },
    );
    if (!result.ok) return result;
    save(FK.acc, result.state.accounts); save(FK.tx, result.state.transactions);
    if (!$("tabKeuangan").classList.contains("hidden")) render();
    return { ok: true, postingId };
  };
  window.financeReversePosting = (postingId) => {
    const result = window.InvestmentCore.reverseIncomePosting({ accounts: accounts(), transactions: txs() }, postingId);
    if (!result.ok) return false;
    save(FK.acc, result.state.accounts); save(FK.tx, result.state.transactions);
    if (!$("tabKeuangan").classList.contains("hidden")) render();
    return true;
  };
  window.financeAddExpense = (amount, accId, label) => {
    if (!accId || !(amount > 0)) return false;
    const t = txs(); t.push({ id: uid(), date: ymd(), type: "out", amount: +amount, accId, cat: "Belanja", note: label || "Barang" });
    save(FK.tx, t); adjustAcc(accId, -(+amount));
    if (!$("tabKeuangan").classList.contains("hidden")) render();
    return true;
  };
  // Money into an account (e.g. a transfer from RDN)
  window.financeAddIncome = (amount, accId, label, opts) => {
    const result = window.financePostIncome({ amount, accId, label: label || "Transfer masuk", origin: `manual:${uid()}` });
    if (result.ok && opts && opts.transfer) {
      const t = txs(); const posted = t.find((x) => x.id === result.postingId);
      if (posted) { posted.transfer = true; posted.cat = "Transfer"; save(FK.tx, t); }
    }
    return result.ok;
  };
  // Add a monthly recurring income or expense (e.g. estimated dividends); skips duplicate labels.
  window.financeAddRecurring = (type, amount, accId, label, day) => {
    if (!accId || !(amount > 0)) return false;
    const r = recs();
    const idx = r.findIndex((x) => x.label === label && x.type === type);
    const d = clampDay(day);
    if (idx >= 0) { r[idx].amount = +amount; r[idx].accId = accId; if (day != null) r[idx].day = d; }
    else r.push({ id: uid(), type, amount: +amount, accId, label: label || "Rutin", day: d, startYM: curYM(), lastYM: "" });
    save(FK.rec, r); applyRecurring();
    if (!$("tabKeuangan").classList.contains("hidden")) render();
    return true;
  };
  document.addEventListener("investment:changed", () => {
    if (!$("tabKeuangan").classList.contains("hidden")) render();
  });
})();
