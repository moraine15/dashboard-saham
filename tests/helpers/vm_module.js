"use strict";

// Load a DOM-coupled static/*.js IIFE in a vm context with minimal stubs, so
// tests can call the pure helpers it exposes on window.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// A stateful element for render tests: innerHTML, value and friends keep what
// the module writes, so a test can read the rendered markup back by id.
function makeRecorder(fallback) {
  const state = {};
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop in state) return state[prop];
      if (prop === "value" || prop === "innerHTML" || prop === "textContent") return "";
      return fallback()[prop];
    },
    set(_t, prop, value) { state[prop] = value; return true; },
    apply() { return fallback(); },
  });
}

function loadModule(file, options = {}) {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "static", file), "utf8");

  // A chainable DOM element stub: any property can be read or assigned, any
  // method call returns another stub. Covers the top-level wiring in the IIFEs.
  const makeEl = () => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "value" || prop === "innerHTML" || prop === "textContent") return "";
      if (prop === "classList") return { add() {}, remove() {}, contains() { return false; }, toggle() {} };
      if (prop === "dataset") return {};
      if (prop === "style") return {};
      if (prop === "checked") return false;
      if (prop === "querySelectorAll") return () => [];
      if (prop === "querySelector") return () => makeEl();
      if (prop === "closest") return () => makeEl();
      if (prop === "addEventListener") return () => {};
      if (prop === Symbol.toPrimitive) return () => "";
      return makeEl();
    },
    set() { return true; },
    apply() { return makeEl(); },
  });

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const elements = new Map();
  const byId = (id) => {
    if (!options.record) return makeEl();
    if (!elements.has(id)) elements.set(id, makeRecorder(makeEl));
    return elements.get(id);
  };

  const win = {};
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById: byId, querySelectorAll: () => [], querySelector: () => makeEl() },
    localStorage,
    $: byId,
    fmt: (n) => String(n),
    fmtRp: options.record ? (n) => "Rp" + Math.round(n) : (n) => String(n),
    fmtPct: (n) => String(n),
    fmtBig: (n) => String(n),
    escHtml: (s) => String(s == null ? "" : s),
    toast: () => {},
    toastUndo: () => {},
    normTicker: (t) => String(t || "").toUpperCase(),
    makeSortable: () => {},
    confirm: () => true,
    fetch: () => Promise.reject(new Error("no network in tests")),
    console,
    Math,
    Date,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    Number,
    Promise,
    setTimeout,
    Symbol,
  };
  sandbox.globalThis = sandbox;
  win.parseRp = (v) => { const n = Number(String(v).replace(/[^\d.-]/g, "")); return Number.isNaN(n) ? NaN : n; };
  win.addRdn = () => {};
  win.rdnCash = () => 0;
  win.setPortfolio = () => {};
  win.chartColors = () => ({ bg: "#000000", grid: "#111111", text: "#ffffff", up: "#00ff00", down: "#ff0000", accent: "#0000ff", warning: "#ffff00", neutral: "#888888" });

  win.toMoneyField = (n) => (n == null || n === "" ? "" : String(n));
  Object.assign(win, options.window || {});
  // Strings are stored as they are (some keys hold raw strings); anything else as JSON.
  for (const [key, value] of Object.entries(options.storage || {})) store.set(key, typeof value === "string" ? value : JSON.stringify(value));

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  return { win, store, localStorage, html: (id) => String(byId(id).innerHTML) };
}

module.exports = { loadModule };
