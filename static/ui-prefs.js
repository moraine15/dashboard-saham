/* Menu names and themes, including values saved by older versions. */
"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.UiPrefs = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TABS = ["home", "analisa", "pasar", "porto", "screener", "alat", "berita", "keuangan", "barang"];

  // Views that became sub-tabs of another view.
  const MOVED = {
    rupiah: { tab: "pasar", sub: "rupiah" },
    emas: { tab: "pasar", sub: "emas" },
    ara: { tab: "alat", sub: "ara" },
    kalkulator: { tab: "alat", sub: "avgdown" },
  };

  const LIGHT = new Set(["light", "slate-light", "putih"]);

  function normalizeTheme(value) {
    return LIGHT.has(value) ? "light" : "default";
  }

  function canonicalTab(name) {
    const moved = MOVED[name];
    return moved ? { tab: moved.tab, sub: moved.sub } : { tab: name, sub: null };
  }

  function migrateTabList(names) {
    const out = [];
    (Array.isArray(names) ? names : []).forEach((name) => {
      const tab = canonicalTab(name).tab;
      if (TABS.includes(tab) && !out.includes(tab)) out.push(tab);
    });
    return out;
  }

  // Hidden menu items: a hidden view that became a sub-tab is dropped, not
  // mapped, so hiding "Rupiah" once never hides the whole Pasar view. In lists
  // saved by the old menu "pasar" meant IHSG alone, so it is dropped too.
  function migrateHiddenTabs(names, order) {
    const list = Array.isArray(names) ? names : [];
    const saved = list.concat(Array.isArray(order) ? order : []);
    const oldFormat = saved.some((name) => Object.prototype.hasOwnProperty.call(MOVED, name));
    const out = [];
    list.forEach((name) => {
      if (oldFormat && name === "pasar") return;
      if (TABS.includes(name) && !out.includes(name)) out.push(name);
    });
    return out;
  }

  return { TABS, normalizeTheme, canonicalTab, migrateTabList, migrateHiddenTabs };
});
