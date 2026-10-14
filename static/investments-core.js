/* Pure calculations for manual mutual-fund and bond holdings. */
"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.InvestmentCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FREQUENCIES = new Set([1, 2, 4, 12]);

  function localToday() {
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function optionalNumber(value) {
    if (value === "" || value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }

  function isoDate(year, monthIndex, day) {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay)));
    return date.toISOString().slice(0, 10);
  }

  function calculateFund(fund) {
    const units = number(fund && fund.units);
    const avgNav = number(fund && fund.avgNav);
    const currentNav = number(fund && fund.currentNav);
    const buyFeePct = number(fund && fund.buyFeePct);
    const redeemFeePct = number(fund && fund.redeemFeePct);
    const grossCapital = units * avgNav;
    const buyFee = grossCapital * buyFeePct / 100;
    const capital = grossCapital + buyFee;
    const grossValue = units * currentNav;
    const redeemFee = grossValue * redeemFeePct / 100;
    const value = grossValue - redeemFee;
    const pl = value - capital;
    return {
      grossCapital,
      buyFee,
      capital,
      grossValue,
      redeemFee,
      value,
      pl,
      returnPct: capital > 0 ? pl / capital * 100 : null,
    };
  }

  function calculateBond(bond, asOf) {
    const faceValue = number(bond && bond.faceValue);
    const avgPricePct = number(bond && bond.avgPricePct);
    const currentPricePct = number(bond && bond.currentPricePct);
    const fees = number(bond && bond.fees);
    const couponPct = number(bond && bond.couponPct);
    const taxPct = number(bond && bond.taxPct);
    const frequency = number(bond && bond.frequency);
    const cleanCost = faceValue * avgPricePct / 100;
    const capital = cleanCost + fees;
    const value = faceValue * currentPricePct / 100;
    const pl = value - capital;
    const annualGrossCoupon = faceValue * couponPct / 100;
    const annualNetCoupon = annualGrossCoupon * (1 - taxPct / 100);
    const couponNet = FREQUENCIES.has(frequency) ? annualNetCoupon / frequency : null;
    const currentYieldPct = value > 0 ? annualGrossCoupon / value * 100 : null;
    const start = parseDate(asOf || localToday());
    const maturity = parseDate(bond && bond.maturityDate);
    const years = start && maturity ? (maturity.getTime() - start.getTime()) / 31557600000 : null;
    const ytmPct = years > 0 && value > 0
      ? (annualGrossCoupon + (faceValue - value) / years) / ((faceValue + value) / 2) * 100
      : null;
    const manualCurrentYieldPct = optionalNumber(bond && bond.manualCurrentYieldPct);
    const manualYtmPct = optionalNumber(bond && bond.manualYtmPct);
    return {
      cleanCost,
      capital,
      value,
      pl,
      returnPct: capital > 0 ? pl / capital * 100 : null,
      annualGrossCoupon,
      annualNetCoupon,
      couponNet,
      currentYieldPct,
      ytmPct,
      displayCurrentYieldPct: manualCurrentYieldPct == null ? currentYieldPct : manualCurrentYieldPct,
      displayYtmPct: manualYtmPct == null ? ytmPct : manualYtmPct,
      currentYieldManual: manualCurrentYieldPct != null,
      ytmManual: manualYtmPct != null,
      yearsRemaining: years > 0 ? years : null,
    };
  }

  function generateCouponSchedule(bond) {
    const first = parseDate(bond && bond.firstCouponDate);
    const maturity = parseDate(bond && bond.maturityDate);
    const frequency = number(bond && bond.frequency);
    if (!first || !maturity || !FREQUENCIES.has(frequency) || first > maturity) return [];
    const interval = 12 / frequency;
    const anchorDay = first.getUTCDate();
    const firstMonth = first.getUTCFullYear() * 12 + first.getUTCMonth();
    const amount = calculateBond(bond, bond.firstCouponDate).couponNet;
    const rows = [];
    for (let index = 0; index < 1200; index += 1) {
      const absoluteMonth = firstMonth + index * interval;
      const year = Math.floor(absoluteMonth / 12);
      const monthIndex = absoluteMonth % 12;
      const scheduledDate = isoDate(year, monthIndex, anchorDay);
      if (scheduledDate > bond.maturityDate) break;
      rows.push({
        id: `${bond.id || "bond"}:${scheduledDate}`,
        scheduledDate,
        manualDate: "",
        amount,
        manualAmount: null,
        status: "scheduled",
        destination: "",
        postingId: "",
      });
    }
    return rows;
  }

  function validateFund(fund) {
    const errors = [];
    if (!String(fund && fund.name || "").trim()) errors.push("Nama reksa dana wajib diisi.");
    if (!(number(fund && fund.units) > 0)) errors.push("Unit harus lebih dari 0.");
    if (!(number(fund && fund.avgNav) > 0)) errors.push("NAB beli rata-rata harus lebih dari 0.");
    if (!(number(fund && fund.currentNav) > 0)) errors.push("NAB saat ini harus lebih dari 0.");
    const buyFee = number(fund && fund.buyFeePct, NaN);
    const redeemFee = number(fund && fund.redeemFeePct, NaN);
    if (!(buyFee >= 0 && buyFee <= 100)) errors.push("Biaya beli harus antara 0% dan 100%.");
    if (!(redeemFee >= 0 && redeemFee <= 100)) errors.push("Biaya redemption harus antara 0% dan 100%.");
    return errors;
  }

  function validateBond(bond) {
    const errors = [];
    if (!String(bond && bond.name || "").trim()) errors.push("Nama obligasi wajib diisi.");
    if (!(number(bond && bond.faceValue) > 0)) errors.push("Nilai nominal harus lebih dari 0.");
    if (!(number(bond && bond.avgPricePct) > 0)) errors.push("Harga beli harus lebih dari 0% nilai pari.");
    if (!(number(bond && bond.currentPricePct) > 0)) errors.push("Harga saat ini harus lebih dari 0% nilai pari.");
    if (!(number(bond && bond.fees, NaN) >= 0)) errors.push("Biaya pembelian tidak boleh negatif.");
    if (!(number(bond && bond.couponPct, NaN) >= 0)) errors.push("Kupon tahunan tidak boleh negatif.");
    const tax = number(bond && bond.taxPct, NaN);
    if (!(tax >= 0 && tax <= 100)) errors.push("Pajak kupon harus antara 0% dan 100%.");
    if (!FREQUENCIES.has(number(bond && bond.frequency))) errors.push("Frekuensi kupon harus bulanan, triwulanan, semesteran, atau tahunan.");
    const purchase = parseDate(bond && bond.purchaseDate);
    const first = parseDate(bond && bond.firstCouponDate);
    const maturity = parseDate(bond && bond.maturityDate);
    if (!purchase || !maturity || maturity <= purchase) errors.push("Tanggal jatuh tempo harus setelah tanggal pembelian.");
    if (!first || !maturity || first > maturity) errors.push("Tanggal kupon pertama tidak boleh setelah jatuh tempo.");
    return errors;
  }

  function totals(rows, annualKey) {
    return (rows || []).reduce((sum, row) => {
      sum.capital += number(row && row.capital);
      sum.value += number(row && row.value);
      sum.pl += number(row && row.pl, number(row && row.value) - number(row && row.capital));
      sum.annualIncome += number(row && row[annualKey]);
      return sum;
    }, { capital: 0, value: 0, pl: 0, annualIncome: 0 });
  }

  function aggregateInvestments(input) {
    const stockInput = input && input.stocks || {};
    const stocks = {
      capital: number(stockInput.capital),
      value: number(stockInput.value),
      pl: number(stockInput.pl, number(stockInput.value) - number(stockInput.capital)),
      annualIncome: number(stockInput.annualIncome),
    };
    const funds = totals(input && input.funds, "annualIncome");
    const bonds = totals(input && input.bonds, "annualNetCoupon");
    const capital = stocks.capital + funds.capital + bonds.capital;
    const value = stocks.value + funds.value + bonds.value;
    const pl = stocks.pl + funds.pl + bonds.pl;
    return {
      stocks,
      funds,
      bonds,
      capital,
      value,
      pl,
      returnPct: capital > 0 ? pl / capital * 100 : null,
      annualIncome: stocks.annualIncome + funds.annualIncome + bonds.annualIncome,
    };
  }

  function applyIncomePosting(state, request) {
    const accounts = (state && state.accounts || []).map((account) => ({ ...account }));
    const transactions = (state && state.transactions || []).map((transaction) => ({ ...transaction }));
    const origin = String(request && request.origin || "");
    if (origin && transactions.some((transaction) => transaction.origin === origin)) {
      return { ok: false, error: "Kupon ini sudah pernah dibukukan.", state };
    }
    const account = accounts.find((item) => item.id === (request && request.accId));
    if (!account) return { ok: false, error: "Rekening tujuan tidak ditemukan.", state };
    const amount = number(request && request.amount, NaN);
    if (!(amount > 0)) return { ok: false, error: "Jumlah pemasukan harus lebih dari 0.", state };
    const postingId = String(request && request.postingId || "");
    if (!postingId) return { ok: false, error: "Referensi pembukuan tidak valid.", state };
    account.balance = number(account.balance) + amount;
    transactions.push({
      id: postingId,
      origin,
      date: String(request.date || ""),
      type: "in",
      amount,
      accId: account.id,
      cat: "Investasi",
      note: String(request.label || "Kupon obligasi"),
    });
    return { ok: true, postingId, state: { accounts, transactions } };
  }

  function reverseIncomePosting(state, postingId) {
    const sourceTransactions = state && state.transactions || [];
    const transaction = sourceTransactions.find((item) => item.id === postingId && item.type === "in");
    if (!transaction) return { ok: false, error: "Pembukuan kupon tidak ditemukan.", state };
    const accounts = (state && state.accounts || []).map((account) => ({ ...account }));
    const account = accounts.find((item) => item.id === transaction.accId);
    if (!account) return { ok: false, error: "Rekening asal pembukuan tidak ditemukan.", state };
    account.balance = number(account.balance) - number(transaction.amount);
    const transactions = sourceTransactions.filter((item) => item.id !== postingId).map((item) => ({ ...item }));
    return { ok: true, state: { accounts, transactions } };
  }

  return {
    calculateFund,
    calculateBond,
    generateCouponSchedule,
    aggregateInvestments,
    validateFund,
    validateBond,
    applyIncomePosting,
    reverseIncomePosting,
  };
});
