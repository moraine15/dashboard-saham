"use strict";

// Charts built while their pane is hidden are 0 px wide; once shown they must
// refit, or their data piles up at the right edge.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { extract } = require("./helpers/extract.js");

function harness() {
  let notify = null;
  class FakeObserver {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() {}
  }
  const { fitChartOnResize } = extract("app.js", ["fitChartOnResize"], {
    ResizeObserver: FakeObserver,
    requestAnimationFrame: (run) => run(),
  });
  let fits = 0;
  const chart = { timeScale: () => ({ fitContent: () => { fits += 1; } }) };
  return { fitChartOnResize, chart, fired: () => notify(), fits: () => fits };
}

test("a chart built at 0 px is refit when it gets its width", () => {
  const h = harness();
  const el = { clientWidth: 0 };
  h.fitChartOnResize(h.chart, el);
  el.clientWidth = 1050;
  h.fired();
  assert.equal(h.fits(), 1);
});

test("an unchanged or hidden width does not refit", () => {
  const h = harness();
  const el = { clientWidth: 900 };
  h.fitChartOnResize(h.chart, el);
  h.fired();
  el.clientWidth = 0;
  h.fired();
  assert.equal(h.fits(), 0);
});

test("the Keuangan, Portofolio value and Pasar charts use it", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", "static", name), "utf8");
  const app = read("app.js");
  const valueChart = app.slice(app.indexOf("async function loadValueChart"));
  assert.match(valueChart.slice(0, valueChart.indexOf("\n}\n")), /fitChartOnResize\(/);
  assert.match(read("finance.js"), /fitChartOnResize\(/);
  assert.match(read("market.js"), /fitChartOnResize\(/);
});
