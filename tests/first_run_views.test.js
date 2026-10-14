"use strict";

// What a brand-new install shows before any money has been recorded.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadModule } = require("./helpers/vm_module.js");

test("a fresh Keuangan shows no 'ATH baru!' for an empty Rp0 record", () => {
  const { win, html } = loadModule("finance.js", { record: true });
  win.financeRender();
  assert.doesNotMatch(html("finAth"), /ATH baru/);
});

test("a real new high is still announced", () => {
  const { win, html } = loadModule("finance.js", {
    record: true,
    storage: { mc_fin_accounts: [{ id: "a1", name: "BCA", balance: 2500000 }] },
  });
  win.financeRender();
  assert.match(html("finAth"), /ATH baru/);
});

test("a fresh Ringkasan shows no '100% dari ATH Rp0'", async () => {
  const { win, html } = loadModule("home.js", { record: true, window: { getWatchlist: () => [] } });
  await win.homeRender();
  assert.doesNotMatch(html("homeStats"), /dari ATH/);
  assert.match(html("homeStats"), /Belum ada rekor/);
});

test("Ringkasan still compares net worth with a recorded high", async () => {
  const { win, html } = loadModule("home.js", {
    record: true,
    window: { getWatchlist: () => [], financeNetWorth: () => 4000000, financeAth: () => ({ val: 5000000, date: "2026-10-01" }) },
  });
  await win.homeRender();
  assert.match(html("homeStats"), /80% dari ATH/);
});

test("the net worth record matches what net worth includes", () => {
  // Ringkasan compared cash-only net worth with the cash + investments + goods record.
  const ath = { cash: { val: 30 }, stocks: { val: 60 }, all: { val: 90 } };
  const cashOnly = loadModule("finance.js", { storage: { mc_fin_ath: ath, mc_fin_settings: { inclInvestments: false } } });
  assert.equal(cashOnly.win.financeAth().val, 30);
  const withInvestments = loadModule("finance.js", { storage: { mc_fin_ath: ath, mc_fin_settings: { inclInvestments: true } } });
  assert.equal(withInvestments.win.financeAth().val, 60);
});

test("the IPO pane shows its empty state after a reload", () => {
  const { html } = loadModule("ara.js", { record: true });
  assert.match(html("ipoTable"), /Belum ada catatan/);
});
