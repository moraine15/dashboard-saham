"use strict";

// Quarterly bars: a missing quarter must read as "n/a", never as a tiny
// positive bar that looks like a value of zero.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMiniBars() {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  const start = src.indexOf("function _miniBars(");
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const match = close.exec(src);
  const end = match.index + match[0].indexOf("}") + 1;
  const ctx = { fmtBig: (v) => String(v), _shortNum: (v) => String(v) };
  vm.runInNewContext(src.slice(start, end), ctx);
  return ctx._miniBars;
}

const cells = (html) => html.split('<div class="qbar"').slice(1);

test("a missing quarter shows n/a and draws no bar", () => {
  const [missing, present] = cells(loadMiniBars()("Pendapatan", [{ label: "Q1'25", rev: null }, { label: "Q2'25", rev: 10 }], "rev"));
  assert.match(missing, /n\/a/);
  assert.doesNotMatch(missing, /class="bar/);
  assert.match(present, /class="bar pos"/);
});

test("negative quarters are drawn as losses", () => {
  const [loss, gain] = cells(loadMiniBars()("Laba Bersih", [{ label: "A", v: -5 }, { label: "B", v: 5 }], "v"));
  assert.match(loss, /class="bar neg"/);
  assert.match(gain, /class="bar pos"/);
});
