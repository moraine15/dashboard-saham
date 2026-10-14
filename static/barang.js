/* barang.js - the Barang tab (purchase projects and wishlists), linked to Keuangan.
   Uses the global helpers $, fmt, fmtRp, toast and window.finance* from finance.js. */
"use strict";
(function () {
  const PK = "mc_barang_projects", IK = "mc_barang_items", CK = "mc_barang_cur";
  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch { return def; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  const projects = () => load(PK, []);
  const allItems = () => load(IK, {});
  const curId = () => load(CK, null);
  const itemsOf = (pid) => (allItems()[pid] || []);
  const subtotal = (it) => (+it.price || 0) * (Number.isFinite(+it.qty) ? +it.qty : 1);

  function ensureProject() {
    let ps = projects();
    if (!ps.length) { const id = uid(); ps = [{ id, name: "Proyek 1" }]; save(PK, ps); save(CK, id); }
    if (!curId() || !ps.find((p) => p.id === curId())) save(CK, ps[0].id);
  }

  function render() {
    ensureProject();
    const ps = projects(), cur = curId();
    $("bgProject").innerHTML = ps.map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`).join("");
    $("bgProject").value = cur;
    // accounts to pay from
    const accs = (window.financeAccounts ? window.financeAccounts() : []);
    $("bgPayAcc").innerHTML = accs.length ? accs.map((a) => `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`).join("") : "<option value=''>(buat akun di Keuangan)</option>";
    renderSummary(); renderTable(); renderFinance();
    if (window.formatMoneyAll) window.formatMoneyAll($("bgTable"));
  }

  function totals(pid) {
    const its = itemsOf(pid);
    let total = 0, bought = 0, plan = 0;
    its.forEach((it) => { const s = subtotal(it); total += s; if (it.status === "bought") bought += s; else plan += s; });
    return { total, bought, plan, count: its.length, progress: total ? bought / total * 100 : 0 };
  }

  function renderSummary() {
    const t = totals(curId());
    $("bgSummary").innerHTML = `
      <div class="pf-card"><div class="lbl">Total Proyek</div><div class="val priv">${fmtRp(t.total)}</div></div>
      <div class="pf-card"><div class="lbl">Sudah Dibeli</div><div class="val priv up">${fmtRp(t.bought)}</div></div>
      <div class="pf-card"><div class="lbl">Sisa (Rencana)</div><div class="val priv down">${fmtRp(t.plan)}</div></div>
      <div class="pf-card"><div class="lbl">Progress</div><div class="val">${fmt(t.progress, 0)}%</div>
        <div class="wbar" style="margin-top:6px"><span class="wbar-track"><span class="wbar-fill" style="width:${t.progress}%"></span></span></div></div>
      <div class="pf-card"><div class="lbl">Jumlah Item</div><div class="val">${t.count}</div></div>`;
  }

  const esc = (s) => escHtml(s);
  const CONDS = [["ada", "Ada"], ["rusak", "Rusak"], ["dijual", "Dijual"]];
  const destOpts = () => `<option value="rdn">Kas RDN</option>` +
    (window.financeAccounts ? window.financeAccounts() : []).map((a) => `<option value="acc:${esc(a.id)}">${esc(a.name)}</option>`).join("");

  function renderTable() {
    const its = itemsOf(curId());
    const head = `<thead><tr><th>Item</th><th>Harga</th><th>Qty</th><th>Subtotal</th><th>Status</th><th>Kondisi</th><th></th></tr></thead>`;
    const body = its.length ? its.map((it) => {
      const cond = it.cond || "ada";
      const sold = cond === "dijual";
      const condSel = `<select class="bg-cond" data-id="${esc(it.id)}" title="Kondisi barang">${CONDS.map(([v, t]) => `<option value="${v}"${cond === v ? " selected" : ""}>${t}</option>`).join("")}</select>`;
      const sellInp = sold ? `<div class="bg-sell-row">
        <input class="edit bg-sell money priv-inp" data-id="${esc(it.id)}" type="text" inputmode="numeric" value="${window.toMoneyField(it.sellPrice)}" placeholder="Harga jual" style="width:110px">
        ${it.soldPosted
          ? `<span class="tiny up">✓ masuk ${esc(it.soldDest || "rekening")}</span>`
          : `<select class="bg-sell-acc" data-id="${esc(it.id)}">${destOpts()}</select><button class="mini bg-sell-go" data-id="${esc(it.id)}">Catat masuk</button>`}
      </div>` : "";
      return `<tr data-id="${esc(it.id)}" class="${sold ? "bg-sold" : ""}">
      <td><input class="edit bg-name" data-id="${esc(it.id)}" value="${esc(it.name)}" title="Nama (bisa diedit)" style="min-width:130px">${it.posted ? " <span class='tiny muted'>(tercatat)</span>" : ""}</td>
      <td><input class="edit bg-price money priv-inp" data-id="${esc(it.id)}" type="text" inputmode="numeric" value="${window.toMoneyField(it.price)}"></td>
      <td><input class="edit bg-qty" data-id="${esc(it.id)}" type="number" step="1" value="${esc(it.qty)}" style="width:60px"></td>
      <td class="priv">${fmtRp(subtotal(it))}</td>
      <td><button class="mini bg-status ${it.status === "bought" ? "" : "del"}" data-id="${esc(it.id)}">${it.status === "bought" ? "✓ Beli" : "Rencana"}</button></td>
      <td>${condSel}${sellInp}</td>
      <td><span class="del bg-del" data-id="${esc(it.id)}">✕</span></td></tr>`;
    }).join("")
      : "<tr><td colspan='7' class='empty-row'>Belum ada item. Tambah di atas.</td></tr>";
    $("bgTable").innerHTML = head + "<tbody>" + body + "</tbody>";
    const its2 = () => allItems();
    $("bgTable").querySelectorAll(".bg-name").forEach((inp) => inp.onchange = () => { const v = inp.value.trim(); if (v) setField(inp.dataset.id, "name", v); });
    $("bgTable").querySelectorAll(".bg-price").forEach((inp) => inp.onchange = () => updateItem(inp.dataset.id, "price", window.parseRp(inp.value)));
    $("bgTable").querySelectorAll(".bg-qty").forEach((inp) => inp.onchange = () => updateItem(inp.dataset.id, "qty", parseInt(inp.value, 10)));
    $("bgTable").querySelectorAll(".bg-cond").forEach((sel) => sel.onchange = () => setField(sel.dataset.id, "cond", sel.value));
    $("bgTable").querySelectorAll(".bg-sell").forEach((inp) => inp.onchange = () => { const p = window.parseRp(inp.value); setField(inp.dataset.id, "sellPrice", isNaN(p) ? null : p); });
    $("bgTable").querySelectorAll(".bg-sell-go").forEach((b) => b.onclick = () => {
      const m = its2(), arr = m[curId()] || []; const it = arr.find((x) => x.id === b.dataset.id); if (!it) return;
      const row = b.closest(".bg-sell-row");
      const price = window.parseRp(row.querySelector(".bg-sell").value);
      if (isNaN(price) || price <= 0) { toast("Isi harga jual dulu"); return; }
      const destVal = row.querySelector(".bg-sell-acc").value;
      let destName = "Kas RDN";
      if (destVal === "rdn") { if (window.addRdn) window.addRdn(price); }
      else if (destVal.indexOf("acc:") === 0) {
        const id = destVal.slice(4); const a = (window.financeAccounts ? window.financeAccounts() : []).find((x) => x.id === id);
        destName = a ? a.name : "Rekening";
        if (!window.financeAddIncome || !window.financeAddIncome(price, id, "Jual barang: " + it.name)) { toast("Gagal mencatat ke rekening"); return; }
      }
      it.sellPrice = price; it.soldPosted = true; it.soldDest = destName;
      save(IK, m); render();
      if (window.financeRender) { try { window.financeRender(); } catch { /* */ } }
      toast(`Penjualan ${fmtRp(price)} masuk ke ${destName}`);
    });
    $("bgTable").querySelectorAll(".bg-status").forEach((b) => b.onclick = () => {
      const m = its2(), arr = m[curId()] || []; const it = arr.find((x) => x.id === b.dataset.id); if (!it) return;
      it.status = it.status === "bought" ? "plan" : "bought"; save(IK, m); render();
    });
    $("bgTable").querySelectorAll(".bg-del").forEach((b) => b.onclick = () => {
      const prev = (its2()[curId()] || []).slice();
      const m = its2(); m[curId()] = (m[curId()] || []).filter((x) => x.id !== b.dataset.id); save(IK, m); render();
      if (window.toastUndo) window.toastUndo("Item dihapus.", () => { const mm = its2(); mm[curId()] = prev; save(IK, mm); render(); });
    });
  }

  function updateItem(id, field, val) {
    if (isNaN(val)) return;
    setField(id, field, val);
  }
  function setField(id, field, val) {
    const m = allItems(), arr = m[curId()] || []; const it = arr.find((x) => x.id === id);
    if (!it) return; it[field] = val; save(IK, m); render();
  }

  function renderFinance() {
    const t = totals(curId());
    const cash = window.financeCash ? window.financeCash() : 0;
    const afterPlan = cash - t.plan;
    const unposted = itemsOf(curId()).filter((it) => it.status === "bought" && !it.posted).reduce((s, it) => s + subtotal(it), 0);
    $("bgFinance").innerHTML = `
      Kas/tabungan saat ini: <b class="priv">${fmtRp(cash)}</b><br>
      Jika beli semua rencana (<span class="priv">${fmtRp(t.plan)}</span>): sisa <b class="priv ${afterPlan >= 0 ? "" : "down"}">${fmtRp(afterPlan)}</b>${afterPlan < 0 ? " <span class='warn'>(belum cukup)</span>" : ""}<br>
      Item "sudah beli" yang belum dicatat ke Keuangan: <b class="priv">${fmtRp(unposted)}</b>`;
    $("bgPayBtn").disabled = unposted <= 0;
  }

  /* ---------- actions ---------- */
  $("bgAddProj").onclick = () => {
    const name = $("bgNewProj").value.trim(); if (!name) { toast("Isi nama proyek"); return; }
    const ps = projects(); const id = uid(); ps.push({ id, name }); save(PK, ps); save(CK, id);
    $("bgNewProj").value = ""; render();
  };
  $("bgDelProj").onclick = async () => {
    const ps = projects(); if (ps.length <= 1) { toast("Minimal 1 proyek"); return; }
    if (!(await window.confirmDialog({ title: "Hapus proyek", text: "Hapus proyek ini beserta itemnya?", okLabel: "Hapus", danger: true }))) return;
    const cur = curId(); const m = allItems(); delete m[cur]; save(IK, m);
    save(PK, ps.filter((p) => p.id !== cur)); save(CK, projects()[0].id); render();
  };
  $("bgProject").onchange = () => { save(CK, $("bgProject").value); render(); };
  $("bgAddItem").onclick = () => {
    const name = $("bgItemName").value.trim(); const price = window.parseRp($("bgItemPrice").value);
    const qty = parseInt($("bgItemQty").value, 10) || 1;
    if (!name || isNaN(price)) { toast("Isi nama & harga"); return; }
    const m = allItems(); (m[curId()] = m[curId()] || []).push({ id: uid(), name, price, qty, status: $("bgItemStatus").value, posted: false, cond: "ada" });
    save(IK, m); $("bgItemName").value = ""; $("bgItemPrice").value = ""; $("bgItemQty").value = "1"; render();
  };
  $("bgPayBtn").onclick = () => {
    const acc = $("bgPayAcc").value; if (!acc) { toast("Buat akun di tab Keuangan dulu"); return; }
    const m = allItems(), arr = m[curId()] || [];
    const pname = (projects().find((p) => p.id === curId()) || {}).name || "Barang";
    let sum = 0; arr.forEach((it) => { if (it.status === "bought" && !it.posted) { sum += subtotal(it); it.posted = true; } });
    if (sum <= 0) { toast("Tidak ada item baru untuk dicatat"); return; }
    if (window.financeAddExpense && window.financeAddExpense(sum, acc, "Barang: " + pname)) {
      save(IK, m); render(); toast(`${fmtRp(sum)} dicatat sebagai pengeluaran`);
    } else toast("Gagal mencatat ke Keuangan");
  };
  $("bgSaveCalc").onclick = () => {
    const t = totals(curId()); const perMonth = window.parseRp($("bgSave").value);
    if (isNaN(perMonth) || perMonth <= 0) { $("bgSaveResult").textContent = "Isi nominal nabung/bulan."; return; }
    const months = Math.ceil(t.plan / perMonth);
    $("bgSaveResult").innerHTML = `Untuk sisa rencana <b class="priv">${fmtRp(t.plan)}</b> dengan nabung <b class="priv">${fmtRp(perMonth)}</b>/bulan → sekitar <b>${months} bulan</b> (~${(months / 12).toFixed(1)} tahun).`;
  };
  $("bgAiBtn").onclick = async () => {
    const out = $("bgAiOut"); out.classList.remove("muted"); out.textContent = "Menganalisis…";
    const t = totals(curId());
    const pname = (projects().find((p) => p.id === curId()) || {}).name || "Proyek";
    const items = itemsOf(curId()).map((it) => ({ nama: it.name, harga: subtotal(it), status: it.status }));
    const ctx = { ticker: "PROYEK-BARANG", proyek: pname, totalBiaya: Math.round(t.total), sudahDibeli: Math.round(t.bought), sisaRencana: Math.round(t.plan), kasTersedia: Math.round(window.financeCash ? window.financeCash() : 0), items };
    const q = `Ini rencana belanja proyek "${pname}" (Rupiah). Beri saran: prioritas item mana dulu, mana yang bisa dihemat/ditunda, dan apakah anggaran realistis vs kas saya. Ringkas, praktis, objektif. Bukan nasihat keuangan profesional.`;
    try {
      const d = await (await fetch("/api/ai/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: ctx, question: q }) })).json();
      out.textContent = d.text || d.error || "Tidak ada jawaban.";
      if (d.enabled === false && d.hint) out.textContent += "\n\n" + d.hint;
    } catch (e) { out.textContent = "Gagal: " + e.message; }
  };

  // Value of the bought items across projects, for the net-worth ATH.
  window.barangAssetValue = () => {
    const all = allItems(); let s = 0;
    for (const pid in all) for (const it of (all[pid] || [])) if (it.status === "bought" && it.cond !== "dijual") s += subtotal(it);
    return s;
  };

  window.barangRender = render;
})();
