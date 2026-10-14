"use strict";

// Opening the app in a new browser must not save default preferences: sync.js
// records any write made before the server's copy arrives as a local edit, and
// that edit would overwrite the value saved from another device.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadModule } = require("./helpers/vm_module.js");
const InvestmentCore = require("../static/investments-core.js");

test("opening Portofolio does not save the default investment view", () => {
  const { store } = loadModule("investments.js", { window: { InvestmentCore } });
  assert.equal(store.has("mc_investment_view_v1"), false);
});

test("a saved investment view is kept as it is", () => {
  const { store } = loadModule("investments.js", {
    window: { InvestmentCore },
    storage: { mc_investment_view_v1: "funds" },
  });
  assert.equal(store.get("mc_investment_view_v1"), "funds");
});
