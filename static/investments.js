/* Manual mutual funds, bonds, coupons and the investment summary. */
"use strict";

(function () {
  const Core = window.InvestmentCore;
  if (!Core) throw new Error("InvestmentCore tidak tersedia");

  const FUND_KEY = "mc_mutual_funds_v1";
  const BOND_KEY = "mc_bonds_v1";
  const VIEW_KEY = "mc_investment_view_v1";
  const $i = (id) => document.getElementById(id);
  const load = (key, fallback) => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed == null ? fallback : parsed;
    } catch (_) { return fallback; }
  };
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
  const num = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const optionalNum = (value) => value === "" || value == null ? null : num(value, null);
  const money = (id) => {
    const element = $i(id);
    if (!element) return 0;
    if (window.parseRp) return num(window.parseRp(element.value));
    return num(String(element.value).replace(/[^\d,-]/g, "").replace(",", "."));
  };
  const fmtMoney = (value) => window.fmtRp ? window.fmtRp(value) : `Rp${Math.round(value).toLocaleString("id-ID")}`;
  const fmtNumber = (value, digits = 2) => window.fmt ? window.fmt(value, digits) : num(value).toLocaleString("id-ID", { maximumFractionDigits: digits });
  const fmtPercent = (value) => value == null ? "-" : `${fmtNumber(value, 2)}%`;
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  let funds = load(FUND_KEY, []);
  let bonds = load(BOND_KEY, []);
  let stockTotals = { capital: 0, value: 0, pl: 0, annualIncome: 0 };
  let selectedBondId = "";

  if (!Array.isArray(funds)) funds = [];
  if (!Array.isArray(bonds)) bonds = [];

  function calculatedFunds() { return funds.map((fund) => ({ ...fund, ...Core.calculateFund(fund) })); }
  function calculatedBonds() { return bonds.map((bond) => ({ ...bond, ...Core.calculateBond(bond) })); }
  function totals() { return Core.aggregateInvestments({ stocks: stockTotals, funds: calculatedFunds(), bonds: calculatedBonds() }); }

  function emitChange() {
    document.dispatchEvent(new CustomEvent("investment:changed", { detail: totals() }));
  }

  function setError(id, errors) {
    const element = $i(id);
    if (element) element.textContent = errors.join(" ");
  }

  function setView(view, fromBoot) {
    const allowed = new Set(["summary", "stocks", "funds", "bonds", "ipo"]);
    const selected = allowed.has(view) ? view : "summary";
    // Opening the app must not save the default before sync has the server copy.
    if (!fromBoot || localStorage.getItem(VIEW_KEY) !== null) localStorage.setItem(VIEW_KEY, selected);
    document.querySelectorAll("[data-investment-pane]").forEach((pane) => pane.classList.toggle("hidden", pane.dataset.investmentPane !== selected));
    document.querySelectorAll("#investmentNav [data-investment-view]").forEach((button) => {
      const active = button.dataset.investmentView === selected;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (selected === "summary") renderSummary();
    if (selected === "funds") renderFunds();
    if (selected === "bonds") renderBonds();
    if (selected === "ipo" && window.araRender) window.araRender();
  }
  window.investmentSetView = setView;

  function renderCards(targetId, rows) {
    const target = $i(targetId);
    if (!target) return;
    target.innerHTML = rows.map(([label, value, className = ""]) => `<div class="pf-card"><div class="lbl">${esc(label)}</div><div class="val priv ${className}">${value}</div></div>`).join("");
  }

  function renderSummary() {
    const value = totals();
    const rdn = window.rdnCash ? num(window.rdnCash()) : 0;
    renderCards("investmentSummary", [
      ["Nilai Investasi", fmtMoney(value.value)],
      ["Total Modal", fmtMoney(value.capital)],
      ["Unrealized P/L", `${value.pl >= 0 ? "+" : ""}${fmtMoney(value.pl)}<br><span class="tiny">${fmtPercent(value.returnPct)}</span>`, value.pl >= 0 ? "up" : "down"],
      ["Kas RDN", fmtMoney(rdn)],
      ["Investasi + RDN", fmtMoney(value.value + rdn)],
      ["Proyeksi Pendapatan/Thn", fmtMoney(value.annualIncome)],
    ]);
    const allocation = $i("investmentAllocation");
    if (allocation) {
      const rows = [["Saham", value.stocks.value], ["Reksa Dana", value.funds.value], ["Obligasi", value.bonds.value]];
      allocation.innerHTML = rows.map(([name, amount]) => {
        const weight = value.value > 0 ? amount / value.value * 100 : 0;
        return `<div class="investment-allocation-row"><span>${name}</span><div><i style="width:${Math.max(0, Math.min(100, weight))}%"></i></div><b class="priv">${fmtMoney(amount)} (${fmtPercent(weight)})</b></div>`;
      }).join("");
    }
  }

  function readFundForm() {
    return {
      id: $i("fundId").value || uid(),
      name: $i("fundName").value.trim(),
      category: $i("fundCategory").value,
      manager: $i("fundManager").value.trim(),
      purchaseDate: $i("fundPurchaseDate").value,
      units: num($i("fundUnits").value),
      avgNav: money("fundAvgNav"),
      currentNav: money("fundCurrentNav"),
      buyFeePct: num($i("fundBuyFee").value),
      redeemFeePct: num($i("fundRedeemFee").value),
      return1m: optionalNum($i("fundReturn1m").value),
      return3m: optionalNum($i("fundReturn3m").value),
      return6m: optionalNum($i("fundReturn6m").value),
      returnYtd: optionalNum($i("fundReturnYtd").value),
      return1y: optionalNum($i("fundReturn1y").value),
      expenseRatio: optionalNum($i("fundExpenseRatio").value),
      aum: optionalNum(money("fundAum")) || null,
      risk: $i("fundRisk").value.trim(),
    };
  }

  function clearFundForm() {
    ["fundId", "fundName", "fundManager", "fundPurchaseDate", "fundUnits", "fundAvgNav", "fundCurrentNav", "fundReturn1m", "fundReturn3m", "fundReturn6m", "fundReturnYtd", "fundReturn1y", "fundExpenseRatio", "fundAum", "fundRisk"].forEach((id) => { $i(id).value = ""; });
    $i("fundBuyFee").value = "0";
    $i("fundRedeemFee").value = "0";
    $i("fundCancel").classList.add("hidden");
    setError("fundError", []);
  }

  function fillFundForm(id) {
    const fund = funds.find((item) => item.id === id);
    if (!fund) return;
    const fields = { fundId: fund.id, fundName: fund.name, fundCategory: fund.category, fundManager: fund.manager, fundPurchaseDate: fund.purchaseDate, fundUnits: fund.units, fundAvgNav: fund.avgNav, fundCurrentNav: fund.currentNav, fundBuyFee: fund.buyFeePct, fundRedeemFee: fund.redeemFeePct, fundReturn1m: fund.return1m, fundReturn3m: fund.return3m, fundReturn6m: fund.return6m, fundReturnYtd: fund.returnYtd, fundReturn1y: fund.return1y, fundExpenseRatio: fund.expenseRatio, fundAum: fund.aum, fundRisk: fund.risk };
    Object.entries(fields).forEach(([key, value]) => {
      const input = $i(key);
      input.value = input.classList.contains("money") ? window.toMoneyField(value) : (value == null ? "" : value);
    });
    $i("fundCancel").classList.remove("hidden");
    $i("fundForm").closest("details").open = true;
    $i("fundName").focus();
  }

  function saveFund() {
    const fund = readFundForm();
    const errors = Core.validateFund(fund);
    setError("fundError", errors);
    if (errors.length) return;
    const index = funds.findIndex((item) => item.id === fund.id);
    if (index >= 0) funds[index] = fund; else funds.push(fund);
    save(FUND_KEY, funds);
    clearFundForm();
    renderFunds();
    renderSummary();
    emitChange();
    if (window.toast) window.toast(index >= 0 ? "Reksa dana diperbarui" : "Reksa dana ditambahkan");
  }

  async function removeFund(id) {
    const item = funds.find((fund) => fund.id === id);
    if (!item || !(await window.confirmDialog({ title: "Hapus reksa dana", text: `Hapus reksa dana ${item.name}?`, okLabel: "Hapus", danger: true }))) return;
    funds = funds.filter((fund) => fund.id !== id);
    save(FUND_KEY, funds);
    renderFunds(); renderSummary(); emitChange();
  }

  function renderFunds() {
    const rows = calculatedFunds();
    const aggregate = Core.aggregateInvestments({ funds: rows });
    renderCards("fundSummary", [
      ["Nilai Bersih", fmtMoney(aggregate.funds.value)],
      ["Modal", fmtMoney(aggregate.funds.capital)],
      ["P/L", `${aggregate.funds.pl >= 0 ? "+" : ""}${fmtMoney(aggregate.funds.pl)}`, aggregate.funds.pl >= 0 ? "up" : "down"],
      ["Jumlah Produk", String(rows.length)],
    ]);
    const table = $i("fundInvestmentTable");
    table.innerHTML = `<thead><tr><th>Produk</th><th>Kategori</th><th>Unit</th><th>NAB Beli</th><th>NAB Kini</th><th>Modal</th><th>Nilai Bersih</th><th>P/L</th><th>Return Pribadi</th><th>1T</th><th></th></tr></thead><tbody>${rows.length ? rows.map((fund) => `<tr data-fund-id="${esc(fund.id)}"><td><b>${esc(fund.name)}</b><br><span class="tiny muted">${esc(fund.manager || "-")}</span></td><td>${esc(fund.category)}</td><td>${fmtNumber(fund.units, 4)}</td><td class="priv">${fmtMoney(fund.avgNav)}</td><td class="priv">${fmtMoney(fund.currentNav)}</td><td class="priv">${fmtMoney(fund.capital)}</td><td class="priv">${fmtMoney(fund.value)}</td><td class="priv ${fund.pl >= 0 ? "up" : "down"}">${fund.pl >= 0 ? "+" : ""}${fmtMoney(fund.pl)}</td><td>${fmtPercent(fund.returnPct)}</td><td>${fmtPercent(fund.return1y)}</td><td class="investment-row-actions"><button data-fund-edit="${esc(fund.id)}" class="mini">Edit</button><button data-fund-delete="${esc(fund.id)}" class="mini del">Hapus</button></td></tr>`).join("") : `<tr><td colspan="11" class="tiny muted">Belum ada reksa dana. Isi formulir di atas.</td></tr>`}</tbody>`;
    table.querySelectorAll("[data-fund-edit]").forEach((button) => button.onclick = () => fillFundForm(button.dataset.fundEdit));
    table.querySelectorAll("[data-fund-delete]").forEach((button) => button.onclick = () => removeFund(button.dataset.fundDelete));
  }

  function readBondForm() {
    return {
      id: $i("bondId").value || uid(),
      name: $i("bondName").value.trim(), issuer: $i("bondIssuer").value.trim(), type: $i("bondType").value,
      purchaseDate: $i("bondPurchaseDate").value, firstCouponDate: $i("bondFirstCouponDate").value, maturityDate: $i("bondMaturityDate").value,
      faceValue: money("bondFaceValue"), avgPricePct: num($i("bondAvgPrice").value), currentPricePct: num($i("bondCurrentPrice").value), fees: money("bondFees"),
      couponPct: num($i("bondCoupon").value), frequency: num($i("bondFrequency").value), taxPct: num($i("bondTax").value),
      manualCurrentYieldPct: optionalNum($i("bondManualCurrentYield").value), manualYtmPct: optionalNum($i("bondManualYtm").value), coupons: [],
    };
  }

  // Unpaid coupons take the recalculated amount but keep the user's corrections;
  // paid coupons keep exactly what was booked.
  function mergeCoupons(bond, previous) {
    const old = new Map((previous || []).map((coupon) => [coupon.scheduledDate, coupon]));
    return Core.generateCouponSchedule(bond).map((coupon) => {
      const prev = old.get(coupon.scheduledDate);
      if (!prev) return coupon;
      if (prev.status === "paid") return { ...coupon, ...prev };
      return { ...coupon, manualDate: prev.manualDate || "", manualAmount: prev.manualAmount, status: prev.status, destination: prev.destination || "" };
    });
  }

  function clearBondForm() {
    ["bondId", "bondName", "bondIssuer", "bondPurchaseDate", "bondFirstCouponDate", "bondMaturityDate", "bondFaceValue", "bondCoupon", "bondManualCurrentYield", "bondManualYtm"].forEach((id) => { $i(id).value = ""; });
    $i("bondAvgPrice").value = "100"; $i("bondCurrentPrice").value = "100"; $i("bondFees").value = "0"; $i("bondTax").value = "10"; $i("bondFrequency").value = "2";
    $i("bondCancel").classList.add("hidden"); setError("bondError", []);
  }

  function fillBondForm(id) {
    const bond = bonds.find((item) => item.id === id); if (!bond) return;
    const fields = { bondId: bond.id, bondName: bond.name, bondIssuer: bond.issuer, bondType: bond.type, bondPurchaseDate: bond.purchaseDate, bondFirstCouponDate: bond.firstCouponDate, bondMaturityDate: bond.maturityDate, bondFaceValue: bond.faceValue, bondAvgPrice: bond.avgPricePct, bondCurrentPrice: bond.currentPricePct, bondFees: bond.fees, bondCoupon: bond.couponPct, bondFrequency: bond.frequency, bondTax: bond.taxPct, bondManualCurrentYield: bond.manualCurrentYieldPct, bondManualYtm: bond.manualYtmPct };
    Object.entries(fields).forEach(([key, value]) => {
      const input = $i(key);
      input.value = input.classList.contains("money") ? window.toMoneyField(value) : (value == null ? "" : value);
    });
    $i("bondCancel").classList.remove("hidden"); $i("bondForm").closest("details").open = true; $i("bondName").focus();
  }

  async function saveBond() {
    const bond = readBondForm();
    const errors = Core.validateBond(bond); setError("bondError", errors); if (errors.length) return;
    const index = bonds.findIndex((item) => item.id === bond.id);
    const previous = index >= 0 ? bonds[index] : null;
    bond.coupons = mergeCoupons(bond, previous ? previous.coupons : []);
    const kept = new Set(bond.coupons.map((coupon) => coupon.scheduledDate));
    const orphaned = (previous ? previous.coupons || [] : []).filter((coupon) => coupon.status === "paid" && !kept.has(coupon.scheduledDate));
    if (orphaned.length) {
      const confirmed = await window.confirmDialog({
        title: "Kupon di luar jadwal baru",
        text: `${orphaned.length} kupon yang sudah dibayar jatuh di luar jadwal baru dan pembukuannya akan dibalik. Lanjutkan?`,
        okLabel: "Balik & simpan", danger: true,
      });
      if (!confirmed) return;
      for (const coupon of orphaned) {
        if (!reverseCoupon(previous, coupon, false)) {
          setError("bondError", ["Pembukuan kupon gagal dibalik; obligasi tidak disimpan."]);
          renderCouponTable(); renderSummary(); emitChange();
          return;
        }
        save(BOND_KEY, bonds);   // money already moved; record it before the next reversal
      }
    }
    if (index >= 0) bonds[index] = bond; else bonds.push(bond);
    selectedBondId = bond.id; save(BOND_KEY, bonds); clearBondForm(); renderBonds(); renderSummary(); emitChange();
    if (window.toast) window.toast(index >= 0 ? "Obligasi diperbarui" : "Obligasi ditambahkan");
  }

  async function removeBond(id) {
    const bond = bonds.find((item) => item.id === id); if (!bond || !(await window.confirmDialog({ title: "Hapus obligasi", text: `Hapus obligasi ${bond.name}?`, okLabel: "Hapus", danger: true }))) return;
    const paid = (bond.coupons || []).filter((coupon) => coupon.status === "paid");
    for (const coupon of paid) {
      if (!reverseCoupon(bond, coupon, false)) {
        setError("bondError", ["Obligasi tidak dihapus karena pembukuan kupon gagal dibalik."]);
        return;
      }
    }
    bonds = bonds.filter((item) => item.id !== id); if (selectedBondId === id) selectedBondId = "";
    save(BOND_KEY, bonds); renderBonds(); renderSummary(); emitChange();
  }

  function updateCoupon(bondId, couponId, field, value) {
    const bond = bonds.find((item) => item.id === bondId); if (!bond) return;
    const coupon = (bond.coupons || []).find((item) => item.id === couponId); if (!coupon || coupon.status === "paid") return;
    if (field === "manualAmount") coupon.manualAmount = (value === "" || value == null || !Number.isFinite(Number(value))) ? null : num(value);
    else coupon[field] = value;
    save(BOND_KEY, bonds); renderCouponTable(); emitChange();
  }

  function couponAmount(coupon) { return coupon.manualAmount == null ? num(coupon.amount) : num(coupon.manualAmount); }
  function couponDate(coupon) { return coupon.manualDate || coupon.scheduledDate; }

  function payCoupon(bond, coupon) {
    if (!bond || !coupon || coupon.status === "paid") return;
    const destination = $i(`couponDest-${coupon.id}`).value;
    const amount = couponAmount(coupon);
    if (!(amount > 0)) { setError("bondError", ["Jumlah kupon harus lebih dari 0."]); return; }
    let postingId = "";
    if (destination === "rdn") {
      if (!window.addRdn) { setError("bondError", ["Saldo RDN tidak tersedia."]); return; }
      window.addRdn(amount);
      postingId = `rdn:${bond.id}:${coupon.id}`;
    } else if (destination.startsWith("account:")) {
      if (!window.financePostIncome) { setError("bondError", ["Modul Keuangan tidak tersedia."]); return; }
      const result = window.financePostIncome({
        amount,
        accId: destination.slice(8),
        label: `Kupon ${bond.name}`,
        origin: `bond:${bond.id}:${coupon.id}`,
        date: couponDate(coupon),
      });
      if (!result.ok) { setError("bondError", [result.error || "Kupon gagal dibukukan."]); return; }
      postingId = result.postingId;
    } else { setError("bondError", ["Pilih tujuan pembayaran kupon."]); return; }
    coupon.status = "paid";
    coupon.destination = destination;
    coupon.postingId = postingId;
    coupon.paidAmount = amount;
    coupon.paidDate = couponDate(coupon);
    save(BOND_KEY, bonds); setError("bondError", []); renderCouponTable(); renderSummary(); emitChange();
    if (window.toast) window.toast(`Kupon ${fmtMoney(amount)} dibukukan`);
  }

  function reverseCoupon(bond, coupon, rerender = true) {
    if (!coupon || coupon.status !== "paid") return true;
    let ok = false;
    if (coupon.destination === "rdn") {
      if (window.addRdn) { window.addRdn(-num(coupon.paidAmount)); ok = true; }
    } else if (coupon.postingId && window.financeReversePosting) ok = window.financeReversePosting(coupon.postingId);
    if (!ok) return false;
    coupon.status = "scheduled"; coupon.destination = ""; coupon.postingId = ""; coupon.paidAmount = null; coupon.paidDate = "";
    if (rerender) { save(BOND_KEY, bonds); renderCouponTable(); renderSummary(); emitChange(); if (window.toast) window.toast("Pembukuan kupon dibalik"); }
    return true;
  }

  function renderCouponTable() {
    const bond = bonds.find((item) => item.id === selectedBondId);
    $i("couponCard").classList.toggle("hidden", !bond);
    if (!bond) return;
    $i("couponBondName").textContent = bond.name;
    const accounts = window.financeAccounts ? window.financeAccounts() : [];
    const destinations = (coupon) => `<select id="couponDest-${esc(coupon.id)}" ${coupon.status === "paid" ? "disabled" : ""}><option value="">Pilih tujuan</option><option value="rdn" ${coupon.destination === "rdn" ? "selected" : ""}>Kas RDN</option>${accounts.map((account) => `<option value="account:${esc(account.id)}" ${coupon.destination === `account:${account.id}` ? "selected" : ""}>${esc(account.name)}</option>`).join("")}</select>`;
    const table = $i("couponTable");
    table.innerHTML = `<thead><tr><th>Jadwal</th><th>Tanggal koreksi</th><th>Kupon bersih</th><th>Jumlah koreksi</th><th>Status</th><th>Tujuan</th><th></th></tr></thead><tbody>${(bond.coupons || []).map((coupon) => `<tr><td>${esc(coupon.scheduledDate)}</td><td><input type="date" data-coupon-date="${esc(coupon.id)}" value="${esc(coupon.manualDate || "")}" ${coupon.status === "paid" ? "disabled" : ""}></td><td class="priv">${fmtMoney(coupon.amount)}</td><td><input class="money priv-inp" inputmode="numeric" data-coupon-amount="${esc(coupon.id)}" value="${esc(window.toMoneyField(coupon.manualAmount))}" ${coupon.status === "paid" ? "disabled" : ""}></td><td>${coupon.status === "paid" ? `<span class="badge b-low">Dibayar ${esc(coupon.paidDate || "")}</span>` : `<select data-coupon-status="${esc(coupon.id)}"><option value="scheduled" ${coupon.status === "scheduled" ? "selected" : ""}>Terjadwal</option><option value="skipped" ${coupon.status === "skipped" ? "selected" : ""}>Dilewati</option></select>`}</td><td>${destinations(coupon)}</td><td>${coupon.status === "paid" ? `<button class="mini" data-coupon-reverse="${esc(coupon.id)}">Balikkan</button>` : `<button class="mini" data-coupon-pay="${esc(coupon.id)}" ${coupon.status === "skipped" ? "disabled" : ""}>Tandai dibayar</button>`}</td></tr>`).join("")}</tbody>`;
    table.querySelectorAll("[data-coupon-date]").forEach((input) => input.onchange = () => updateCoupon(bond.id, input.dataset.couponDate, "manualDate", input.value));
    table.querySelectorAll("[data-coupon-amount]").forEach((input) => input.onchange = () => updateCoupon(bond.id, input.dataset.couponAmount, "manualAmount", window.parseRp ? window.parseRp(input.value) : input.value));
    table.querySelectorAll("[data-coupon-status]").forEach((select) => select.onchange = () => updateCoupon(bond.id, select.dataset.couponStatus, "status", select.value));
    table.querySelectorAll("[data-coupon-pay]").forEach((button) => button.onclick = () => payCoupon(bond, bond.coupons.find((coupon) => coupon.id === button.dataset.couponPay)));
    table.querySelectorAll("[data-coupon-reverse]").forEach((button) => button.onclick = () => reverseCoupon(bond, bond.coupons.find((coupon) => coupon.id === button.dataset.couponReverse)));
    if (window.formatMoneyAll) window.formatMoneyAll(table);
  }

  function renderBonds() {
    const rows = calculatedBonds(); const aggregate = Core.aggregateInvestments({ bonds: rows });
    renderCards("bondSummary", [["Nilai", fmtMoney(aggregate.bonds.value)], ["Modal", fmtMoney(aggregate.bonds.capital)], ["P/L", `${aggregate.bonds.pl >= 0 ? "+" : ""}${fmtMoney(aggregate.bonds.pl)}`, aggregate.bonds.pl >= 0 ? "up" : "down"], ["Kupon Bersih/Thn", fmtMoney(aggregate.bonds.annualIncome)]]);
    const table = $i("bondTable");
    table.innerHTML = `<thead><tr><th>Obligasi</th><th>Nominal</th><th>Harga Kini</th><th>Nilai</th><th>P/L</th><th>Kupon</th><th>Current Yield</th><th>YTM</th><th>Jatuh Tempo</th><th></th></tr></thead><tbody>${rows.length ? rows.map((bond) => `<tr data-bond-row="${esc(bond.id)}"><td><b>${esc(bond.name)}</b><br><span class="tiny muted">${esc(bond.issuer || bond.type)}</span></td><td class="priv">${fmtMoney(bond.faceValue)}</td><td>${fmtPercent(bond.currentPricePct)}</td><td class="priv">${fmtMoney(bond.value)}</td><td class="priv ${bond.pl >= 0 ? "up" : "down"}">${bond.pl >= 0 ? "+" : ""}${fmtMoney(bond.pl)}</td><td>${fmtPercent(bond.couponPct)}</td><td>${fmtPercent(bond.displayCurrentYieldPct)}${bond.currentYieldManual ? " <span class='badge'>manual</span>" : ""}</td><td>${fmtPercent(bond.displayYtmPct)}${bond.ytmManual ? " <span class='badge'>manual</span>" : ""}</td><td>${esc(bond.maturityDate)}</td><td class="investment-row-actions"><button data-bond-coupons="${esc(bond.id)}" class="mini">Kupon</button><button data-bond-edit="${esc(bond.id)}" class="mini">Edit</button><button data-bond-delete="${esc(bond.id)}" class="mini del">Hapus</button></td></tr>`).join("") : `<tr><td colspan="10" class="tiny muted">Belum ada obligasi. Isi formulir di atas.</td></tr>`}</tbody>`;
    table.querySelectorAll("[data-bond-coupons]").forEach((button) => button.onclick = () => { selectedBondId = button.dataset.bondCoupons; renderCouponTable(); });
    table.querySelectorAll("[data-bond-edit]").forEach((button) => button.onclick = () => fillBondForm(button.dataset.bondEdit));
    table.querySelectorAll("[data-bond-delete]").forEach((button) => button.onclick = () => removeBond(button.dataset.bondDelete));
    renderCouponTable();
  }

  function render() { renderSummary(); renderFunds(); renderBonds(); }

  $i("investmentNav").querySelectorAll("[data-investment-view]").forEach((button) => button.onclick = () => setView(button.dataset.investmentView));
  $i("fundSave").onclick = saveFund; $i("fundCancel").onclick = clearFundForm;
  $i("bondSave").onclick = saveBond; $i("bondCancel").onclick = clearBondForm;

  window.investmentTotals = totals;
  window.investmentRefreshStocks = (latest) => {
    stockTotals = {
      capital: num(latest && (latest.cost == null ? latest.capital : latest.cost)),
      value: num(latest && latest.value),
      pl: num(latest && latest.pl),
      annualIncome: num(latest && latest.annualDividend),
    };
    renderSummary(); emitChange();
  };

  if (!$i("fundPurchaseDate").value) $i("fundPurchaseDate").value = today();
  setView(localStorage.getItem(VIEW_KEY) || "summary", true);
  render();
})();
