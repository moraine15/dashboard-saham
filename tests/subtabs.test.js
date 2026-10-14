"use strict";

// Sub-tab control: selection state, panels, onChange and arrow keys.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeEl {
  constructor(attrs = {}) {
    this.attrs = { ...attrs };
    this.dataset = {};
    this.hidden = false;
    this.tabIndex = 0;
    this.listeners = {};
    this.children = [];
    this.focused = false;
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, event = {}) { (this.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, target: this, ...event })); }
  querySelectorAll() { return this.children; }
  focus() { this.focused = true; }
}

function setup(names) {
  const byId = {};
  const nav = new FakeEl({ role: "tablist" });
  nav.children = names.map((name) => {
    const tab = new FakeEl({ role: "tab", "aria-controls": `sub-x-${name}` });
    tab.dataset.sub = name;
    byId[`sub-x-${name}`] = new FakeEl({ role: "tabpanel" });
    return tab;
  });
  const window = {};
  const document = { getElementById: (id) => byId[id] || null, get activeElement() { return nav.children.find((t) => t.focused) || null; } };
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "subtabs.js"), "utf8");
  vm.runInNewContext(src, { window, document });
  return { Subtabs: window.Subtabs, nav, panels: byId };
}

test("the first sub-tab starts selected and its panel is the only one shown", () => {
  const { Subtabs, nav, panels } = setup(["a", "b", "c"]);
  const handle = Subtabs.init(nav, {});
  assert.equal(handle.current(), "a");
  assert.equal(nav.children[0].getAttribute("aria-selected"), "true");
  assert.equal(panels["sub-x-a"].hidden, false);
  assert.equal(panels["sub-x-b"].hidden, true);
});

test("select marks only the chosen tab and calls onChange", () => {
  const { Subtabs, nav, panels } = setup(["a", "b", "c"]);
  const changes = [];
  const handle = Subtabs.init(nav, { onChange: (name) => changes.push(name) });
  handle.select("b");
  assert.deepEqual(nav.children.map((t) => t.getAttribute("aria-selected")), ["false", "true", "false"]);
  assert.deepEqual(nav.children.map((t) => t.tabIndex), [-1, 0, -1]);
  assert.deepEqual(["a", "b", "c"].map((n) => panels[`sub-x-${n}`].hidden), [true, false, true]);
  assert.equal(handle.current(), "b");
  assert.deepEqual(changes, ["b"]);
});

test("clicking a tab selects it", () => {
  const { Subtabs, nav } = setup(["a", "b"]);
  const handle = Subtabs.init(nav, {});
  nav.children[1].dispatch("click");
  assert.equal(handle.current(), "b");
});

test("arrow keys move selection and wrap around", () => {
  const { Subtabs, nav } = setup(["a", "b", "c"]);
  const handle = Subtabs.init(nav, {});
  handle.select("c");
  nav.children[2].focused = true;
  nav.dispatch("keydown", { key: "ArrowRight", target: nav.children[2] });
  assert.equal(handle.current(), "a");
  assert.equal(nav.children[0].focused, true);
  nav.dispatch("keydown", { key: "ArrowLeft", target: nav.children[0] });
  assert.equal(handle.current(), "c");
  nav.dispatch("keydown", { key: "Home", target: nav.children[2] });
  assert.equal(handle.current(), "a");
});

test("selecting an unknown name keeps the current tab", () => {
  const { Subtabs, nav } = setup(["a", "b"]);
  const handle = Subtabs.init(nav, {});
  handle.select("zzz");
  assert.equal(handle.current(), "a");
});
