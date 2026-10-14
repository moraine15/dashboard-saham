"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../static/investments-core.js");

test("mutual fund uses net redemption value for personal return", () => {
  const value = Core.calculateFund({
    units: 1000,
    avgNav: 1000,
    currentNav: 1200,
    buyFeePct: 1,
    redeemFeePct: 0.5,
  });

  assert.deepEqual(value, {
    grossCapital: 1000000,
    buyFee: 10000,
    capital: 1010000,
    grossValue: 1200000,
    redeemFee: 6000,
    value: 1194000,
    pl: 184000,
    returnPct: 18.217821782178216,
  });
});

test("mutual fund validation rejects invalid position values", () => {
  assert.deepEqual(
    Core.validateFund({ name: "", units: 0, avgNav: -1, currentNav: NaN, buyFeePct: 101, redeemFeePct: -1 }),
    [
      "Nama reksa dana wajib diisi.",
      "Unit harus lebih dari 0.",
      "NAB beli rata-rata harus lebih dari 0.",
      "NAB saat ini harus lebih dari 0.",
      "Biaya beli harus antara 0% dan 100%.",
      "Biaya redemption harus antara 0% dan 100%.",
    ],
  );
});

test("bond calculates capital, coupon, current yield, and approximate YTM", () => {
  const value = Core.calculateBond({
    faceValue: 100000000,
    avgPricePct: 98,
    currentPricePct: 99,
    fees: 100000,
    couponPct: 6.5,
    taxPct: 10,
    frequency: 2,
    maturityDate: "2030-02-01",
  }, "2026-02-01");

  assert.equal(value.capital, 98100000);
  assert.equal(value.value, 99000000);
  assert.equal(value.pl, 900000);
  assert.equal(value.annualGrossCoupon, 6500000);
  assert.equal(value.annualNetCoupon, 5850000);
  assert.equal(value.couponNet, 2925000);
  assert.ok(Math.abs(value.currentYieldPct - 6.5656565657) < 1e-8);
  assert.ok(Number.isFinite(value.ytmPct));
});

test("bond manual yields override displayed values without removing calculations", () => {
  const value = Core.calculateBond({
    faceValue: 1000000,
    avgPricePct: 100,
    currentPricePct: 95,
    fees: 0,
    couponPct: 6,
    taxPct: 10,
    frequency: 12,
    maturityDate: "2028-01-01",
    manualCurrentYieldPct: 7.2,
    manualYtmPct: 8.1,
  }, "2026-01-01");

  assert.equal(value.displayCurrentYieldPct, 7.2);
  assert.equal(value.displayYtmPct, 8.1);
  assert.equal(value.currentYieldManual, true);
  assert.equal(value.ytmManual, true);
  assert.notEqual(value.currentYieldPct, value.displayCurrentYieldPct);
});

test("coupon schedules support every approved frequency", () => {
  const expected = new Map([[12, 12], [4, 4], [2, 2], [1, 1]]);
  for (const [frequency, count] of expected) {
    const rows = Core.generateCouponSchedule({
      id: "b1",
      firstCouponDate: "2027-01-15",
      maturityDate: "2027-12-31",
      frequency,
      faceValue: 12000000,
      couponPct: 6,
      taxPct: 10,
    });
    assert.equal(rows.length, count);
    assert.equal(rows[0].amount, 12000000 * 0.06 * 0.9 / frequency);
  }
});

test("schedule clamps the anchor day and stops at maturity", () => {
  const rows = Core.generateCouponSchedule({
    id: "bond-x",
    firstCouponDate: "2027-01-31",
    maturityDate: "2027-07-31",
    frequency: 4,
    faceValue: 1000000,
    couponPct: 6,
    taxPct: 10,
  });
  assert.deepEqual(rows.map((row) => row.scheduledDate), ["2027-01-31", "2027-04-30", "2027-07-31"]);
  assert.deepEqual(rows.map((row) => row.id), ["bond-x:2027-01-31", "bond-x:2027-04-30", "bond-x:2027-07-31"]);
});

test("schedule handles leap-year February", () => {
  const rows = Core.generateCouponSchedule({
    id: "leap",
    firstCouponDate: "2024-01-31",
    maturityDate: "2024-03-31",
    frequency: 12,
    faceValue: 1000000,
    couponPct: 12,
    taxPct: 0,
  });
  assert.deepEqual(rows.map((row) => row.scheduledDate), ["2024-01-31", "2024-02-29", "2024-03-31"]);
});

test("bond validation rejects illogical dates and values", () => {
  assert.deepEqual(Core.validateBond({
    name: "ORI",
    purchaseDate: "2027-02-01",
    firstCouponDate: "2028-02-01",
    maturityDate: "2027-01-01",
    faceValue: 0,
    avgPricePct: -1,
    currentPricePct: 0,
    fees: -1,
    couponPct: -2,
    taxPct: 101,
    frequency: 3,
  }), [
    "Nilai nominal harus lebih dari 0.",
    "Harga beli harus lebih dari 0% nilai pari.",
    "Harga saat ini harus lebih dari 0% nilai pari.",
    "Biaya pembelian tidak boleh negatif.",
    "Kupon tahunan tidak boleh negatif.",
    "Pajak kupon harus antara 0% dan 100%.",
    "Frekuensi kupon harus bulanan, triwulanan, semesteran, atau tahunan.",
    "Tanggal jatuh tempo harus setelah tanggal pembelian.",
    "Tanggal kupon pertama tidak boleh setelah jatuh tempo.",
  ]);
});

test("aggregate combines asset classes without RDN", () => {
  const value = Core.aggregateInvestments({
    stocks: { capital: 100, value: 110, annualIncome: 4 },
    funds: [{ capital: 200, value: 220, pl: 20 }],
    bonds: [{ capital: 300, value: 315, pl: 15, annualNetCoupon: 18 }],
    rdn: 999,
  });
  assert.deepEqual(value, {
    stocks: { capital: 100, value: 110, pl: 10, annualIncome: 4 },
    funds: { capital: 200, value: 220, pl: 20, annualIncome: 0 },
    bonds: { capital: 300, value: 315, pl: 15, annualIncome: 18 },
    capital: 600,
    value: 645,
    pl: 45,
    returnPct: 7.5,
    annualIncome: 22,
  });
});

test("income posting is idempotent and reversible", () => {
  const state = { accounts: [{ id: "bank", name: "BCA", balance: 1000 }], transactions: [] };
  const posted = Core.applyIncomePosting(state, { postingId: "coupon-1", origin: "bond:b1:c1", accId: "bank", amount: 250, date: "2026-07-20", label: "Kupon ORI" });
  assert.equal(posted.ok, true);
  assert.equal(posted.state.accounts[0].balance, 1250);
  assert.equal(posted.state.transactions[0].origin, "bond:b1:c1");
  assert.equal(state.accounts[0].balance, 1000, "input state must not be mutated");

  const duplicate = Core.applyIncomePosting(posted.state, { postingId: "coupon-2", origin: "bond:b1:c1", accId: "bank", amount: 250, date: "2026-07-20", label: "Kupon ORI" });
  assert.deepEqual(duplicate, { ok: false, error: "Kupon ini sudah pernah dibukukan.", state: posted.state });

  const reversed = Core.reverseIncomePosting(posted.state, "coupon-1");
  assert.equal(reversed.ok, true);
  assert.equal(reversed.state.accounts[0].balance, 1000);
  assert.deepEqual(reversed.state.transactions, []);
});

test("income posting rejects missing destination without mutation", () => {
  const state = { accounts: [], transactions: [] };
  const result = Core.applyIncomePosting(state, { postingId: "x", origin: "bond:x", accId: "missing", amount: 1 });
  assert.deepEqual(result, { ok: false, error: "Rekening tujuan tidak ditemukan.", state });
});
