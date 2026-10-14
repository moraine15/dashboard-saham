"use strict";

// Money formatting and the Alat calculators in static/app.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const { extract } = require("./helpers/extract.js");

function elements(values = {}) {
  const els = {};
  const $ = (id) => {
    if (!els[id]) els[id] = { value: values[id] ?? "", checked: false, innerHTML: "", textContent: "" };
    return els[id];
  };
  return { $, els };
}

const FORMAT = ["fmt", "fmtRp"];
const CALC = [...FORMAT, "line", "val", "round2", "calcPosition", "calcRisk", "prefillCalculators"];

test("negative rupiah put the sign before Rp, so it never breaks after 'Rp-'", () => {
  const { fmtRp } = extract("app.js", FORMAT);
  assert.equal(fmtRp(-405878), "-Rp405.878");
  assert.equal(fmtRp(1234), "Rp1.234");
  assert.equal(fmtRp(-0.4), "Rp0");
  assert.equal(fmtRp(-1.5, 2), "-Rp1,50");
  assert.equal(fmtRp(null), "-");
});

test("a 100% sell fee does not print an infinite break-even price", () => {
  const { $, els } = elements({ poLot: "2", poBuy: "1000", poFeeBuy: "0.15", poFeeSell: "100" });
  extract("app.js", CALC, { $ }).calcPosition();
  assert.doesNotMatch(els.poResult.innerHTML, /Infinity|∞|NaN/);
});

test("the risk calculator never divides by a zero price or zero risk", () => {
  for (const values of [
    { riLot: "1", riBuy: "0", riTarget: "1200", riStop: "900" },
    { riLot: "1", riBuy: "1000", riTarget: "1200", riStop: "1000" },
  ]) {
    const { $, els } = elements(values);
    extract("app.js", CALC, { $ }).calcRisk();
    assert.doesNotMatch(els.riResult.innerHTML, /Infinity|∞|NaN/, JSON.stringify(values));
  }
});

test("reloading the same stock keeps what the owner typed into the calculators", () => {
  const { $, els } = elements();
  const ctx = extract("app.js", CALC, { $ });
  const stock = { ticker: "BBCA.JK", price: 9000, fundamentals: { bvps: 1, pbv: 2, eps: 3, per: 4, dps: 5 } };
  ctx.prefillCalculators(stock);
  els.poBuy.value = "8500";  // typed by the owner
  ctx.prefillCalculators({ ...stock, price: 9100 });  // auto-refresh of the same stock
  assert.equal(els.poBuy.value, "8500");
  ctx.prefillCalculators({ ...stock, ticker: "TLKM.JK", price: 3000 });  // another stock
  assert.equal(els.poBuy.value, 3000);
});
