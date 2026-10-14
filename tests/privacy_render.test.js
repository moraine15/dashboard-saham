"use strict";

// Privacy mode ("Sensor angka") blurs elements with .priv and masks inputs with
// .priv-inp. Render Barang and Keuangan with real-looking data and fail on any
// rupiah amount or filled money input that would stay readable.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadModule } = require("./helpers/vm_module.js");

const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "col", "source", "wbr"]);

function unprotected(html) {
  const stack = [];
  const misses = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      if (/Rp-?\d/.test(m[4]) && !stack.some((el) => el.priv)) misses.push(m[4].trim());
      continue;
    }
    const [, close, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      const at = stack.map((el) => el.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (tag === "input") {
      if (/\bmoney\b/.test(attrs) && /value="[^"]*\d/.test(attrs) && !/\bpriv-inp\b/.test(attrs)) {
        misses.push(`input ${attrs.trim().slice(0, 50)}`);
      }
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    stack.push({ tag, priv: /class="[^"]*\bpriv\b/.test(attrs) });
  }
  return misses;
}

test("the checker itself spots readable amounts", () => {
  assert.deepEqual(unprotected('<b class="priv">Rp100</b>'), []);
  assert.deepEqual(unprotected('<div class="val priv up"><span>Rp100</span></div>'), []);
  assert.deepEqual(unprotected("<b>Rp100</b>"), ["Rp100"]);
  assert.deepEqual(unprotected('<input class="edit money" value="1500">').length, 1);
});

test("Barang keeps every amount behind privacy mode", () => {
  const { win, html } = loadModule("barang.js", {
    record: true,
    storage: {
      mc_barang_projects: [{ id: "p1", name: "Rakit PC" }],
      mc_barang_cur: '"p1"',
      mc_barang_items: { p1: [
        { id: "a", name: "GPU", price: 5000000, qty: 1, status: "bought", cond: "ada" },
        { id: "b", name: "SSD", price: 900000, qty: 2, status: "plan", cond: "ada" },
        { id: "c", name: "Monitor", price: 2000000, qty: 1, status: "bought", cond: "dijual", sellPrice: 1500000 },
      ] },
    },
  });
  win.barangRender();
  for (const id of ["bgSummary", "bgTable", "bgFinance"]) {
    assert.deepEqual(unprotected(html(id)), [], id);
  }
});

test("Keuangan keeps every amount behind privacy mode", () => {
  const today = new Date().toISOString().slice(0, 10);
  const { win, html } = loadModule("finance.js", {
    record: true,
    storage: {
      mc_fin_accounts: [{ id: "a1", name: "BCA", balance: 2500000, min: 3000000 }],
      mc_fin_tx: [{ id: "t1", date: today, type: "in", amount: 750000, accId: "a1", cat: "Gaji" }],
      mc_fin_recurring: [{ id: "r1", type: "out", amount: 120000, accId: "a1", label: "Internet", day: 5, mode: "manual" }],
      mc_fin_debts: [{ id: "d1", who: "Budi", amount: 300000, settled: false }],
      mc_fin_targets: { monthly: 1000000, yearly: 12000000 },
    },
  });
  win.financeRender();
  for (const id of ["finSummary", "finAth", "accList", "tgtProgress", "debtList", "txRangeSummary", "txTable", "recList"]) {
    assert.deepEqual(unprotected(html(id)), [], id);
  }
});
