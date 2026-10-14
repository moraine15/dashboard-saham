"use strict";

// Ringkasan: net-worth history line and the change since the first record.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModule } = require("./helpers/vm_module.js");

const homeMath = () => loadModule("home.js").win.homeMath;

test("sparkPoints spreads values across the width with the minimum at the bottom", () => {
  assert.equal(homeMath().sparkPoints([1, 2, 3], 100, 10), "0,10 50,5 100,0");
});

test("sparkPoints needs at least two values", () => {
  assert.equal(homeMath().sparkPoints([5], 100, 10), "");
  assert.equal(homeMath().sparkPoints([], 100, 10), "");
});

test("sparkPoints draws a flat line through the middle when nothing changed", () => {
  assert.equal(homeMath().sparkPoints([2, 2], 100, 10), "0,5 100,5");
});

test("sinceChange compares the earliest and latest record", () => {
  const out = homeMath().sinceChange({ "2026-10-11": 110, "2026-10-01": 100 });
  assert.equal(JSON.stringify(out), JSON.stringify({ pct: 10, since: "2026-10-01" }));
});

test("sinceChange returns null without a usable starting value", () => {
  assert.equal(homeMath().sinceChange({ "2026-10-01": 0, "2026-10-02": 5 }), null);
  assert.equal(homeMath().sinceChange({ "2026-10-01": 100 }), null);
  assert.equal(homeMath().sinceChange({}), null);
});
