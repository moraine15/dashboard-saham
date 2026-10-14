"use strict";

// The RSI and MACD panes under the Analisis price chart line up bar for bar.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { extract } = require("./helpers/extract.js");

const plain = (value) => JSON.parse(JSON.stringify(value));
const candles = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]
  .map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));

test("indicator series get a blank slot for every candle they skip", () => {
  const { alignToCandles } = extract("app.js", ["alignToCandles"]);
  const out = alignToCandles(candles, [
    { time: "2026-10-09", value: 40 },
    { time: "2026-10-12", value: 55, color: "#fff" },
  ]);
  assert.deepEqual(plain(out), [
    { time: "2026-10-07" },
    { time: "2026-10-08" },
    { time: "2026-10-09", value: 40 },
    { time: "2026-10-12", value: 55, color: "#fff" },
  ]);
});

test("intraday times (epoch seconds) line up the same way", () => {
  const { alignToCandles } = extract("app.js", ["alignToCandles"]);
  const bars = [100, 400, 700].map((time) => ({ time }));
  assert.deepEqual(plain(alignToCandles(bars, [{ time: 700, value: 1 }])), [{ time: 100 }, { time: 400 }, { time: 700, value: 1 }]);
});

test("the price, RSI and MACD panes share bars and price-scale width", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  const body = src.slice(src.indexOf("function renderCharts("), src.indexOf("let _subChartRO"));
  assert.match(body, /alignToCandles\(c\.candles, c\.rsi\)/);
  assert.match(body, /alignToCandles\(c\.candles, c\.macd_hist/);
  assert.match(body, /minimumWidth/);
});
