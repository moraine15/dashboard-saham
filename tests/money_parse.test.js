"use strict";

// Indonesian money formatting: "." groups thousands, "," marks decimals.
// Numbers written back into a money field must survive a parse round trip.

const test = require("node:test");
const assert = require("node:assert/strict");
const money = require("../static/money.js");

test("parseRp reads Indonesian grouping and decimals", () => {
  assert.equal(money.parseRp("600.000"), 600000);
  assert.equal(money.parseRp("1.234,5"), 1234.5);
  assert.equal(money.parseRp("-2.500"), -2500);
  assert.equal(money.parseRp(""), NaN);
  assert.equal(money.parseRp(1851.75), 1851.75);
});

test("toMoneyField formats JS numbers so parseRp reads them back unchanged", () => {
  for (const value of [0, 7, 1234.56, 1500000.5, 1523.4567, 6918.75, -2500.25, 1e9]) {
    assert.equal(money.parseRp(money.toMoneyField(value)), value, `round trip ${value}`);
  }
  assert.equal(money.toMoneyField(1234.56), "1.234,56");
  assert.equal(money.toMoneyField(1500000), "1.500.000");
  assert.equal(money.toMoneyField(-2500.25), "-2.500,25");
});

test("toMoneyField leaves empty and invalid values blank", () => {
  assert.equal(money.toMoneyField(null), "");
  assert.equal(money.toMoneyField(undefined), "");
  assert.equal(money.toMoneyField(""), "");
  assert.equal(money.toMoneyField(NaN), "");
  assert.equal(money.toMoneyField(Infinity), "");
});

test("groupRp is idempotent on already formatted text", () => {
  const once = money.groupRp(money.toMoneyField(1523.4567));
  assert.equal(once, "1.523,4567");
  assert.equal(money.groupRp(once), once);
});

test("parseDecimal accepts both comma and dot for percentages", () => {
  assert.equal(money.parseDecimal("0,3"), 0.3);
  assert.equal(money.parseDecimal("0.3"), 0.3);
  assert.equal(money.parseDecimal(""), NaN);
});
