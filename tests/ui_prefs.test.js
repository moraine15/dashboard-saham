"use strict";

// Saved preferences from older versions map onto the current menu and themes.

const test = require("node:test");
const assert = require("node:assert/strict");
const UiPrefs = require("../static/ui-prefs.js");

test("normalizeTheme keeps the two themes and maps anything else to Hitam", () => {
  assert.equal(UiPrefs.normalizeTheme("light"), "light");
  assert.equal(UiPrefs.normalizeTheme("slate-light"), "light");
  assert.equal(UiPrefs.normalizeTheme("putih"), "light");
  assert.equal(UiPrefs.normalizeTheme("default"), "default");
  assert.equal(UiPrefs.normalizeTheme("charcoal"), "default");
  assert.equal(UiPrefs.normalizeTheme(undefined), "default");
  assert.equal(UiPrefs.normalizeTheme(""), "default");
});

test("canonicalTab sends old menu names to their new view and sub-tab", () => {
  assert.deepEqual(UiPrefs.canonicalTab("rupiah"), { tab: "pasar", sub: "rupiah" });
  assert.deepEqual(UiPrefs.canonicalTab("emas"), { tab: "pasar", sub: "emas" });
  assert.deepEqual(UiPrefs.canonicalTab("ara"), { tab: "alat", sub: "ara" });
  assert.deepEqual(UiPrefs.canonicalTab("kalkulator"), { tab: "alat", sub: "avgdown" });
  assert.deepEqual(UiPrefs.canonicalTab("porto"), { tab: "porto", sub: null });
  assert.deepEqual(UiPrefs.canonicalTab("pasar"), { tab: "pasar", sub: null });
});

test("migrateTabList maps, filters and de-duplicates saved menu lists", () => {
  assert.deepEqual(
    UiPrefs.migrateTabList(["home", "rupiah", "pasar", "emas", "ara", "kalkulator", "porto"]),
    ["home", "pasar", "alat", "porto"],
  );
  assert.deepEqual(UiPrefs.migrateTabList(["nonsense", "barang"]), ["barang"]);
  assert.deepEqual(UiPrefs.migrateTabList(null), []);
});

test("migrateHiddenTabs drops moved names so a hidden sub-view never hides its new parent", () => {
  assert.deepEqual(UiPrefs.migrateHiddenTabs(["rupiah", "emas", "ara", "kalkulator", "screener"]), ["screener"]);
  assert.deepEqual(UiPrefs.migrateHiddenTabs(["berita", "berita", "nonsense"]), ["berita"]);
  assert.deepEqual(UiPrefs.migrateHiddenTabs(undefined), []);
});

test("an old hidden 'pasar' meant only IHSG, so old-format lists drop it", () => {
  // Hiding the old IHSG view must not hide the Rupiah and Emas the owner still used.
  assert.deepEqual(UiPrefs.migrateHiddenTabs(["pasar", "rupiah"]), []);
  assert.deepEqual(UiPrefs.migrateHiddenTabs(["pasar"], ["home", "pasar", "rupiah", "emas"]), []);
  // A list already in the new format keeps a deliberately hidden Pasar.
  assert.deepEqual(UiPrefs.migrateHiddenTabs(["pasar"], ["home", "pasar", "alat"]), ["pasar"]);
  assert.deepEqual(UiPrefs.migrateHiddenTabs(["pasar"]), ["pasar"]);
});

test("TABS lists the menu in order", () => {
  assert.deepEqual(UiPrefs.TABS, ["home", "analisa", "pasar", "porto", "screener", "alat", "berita", "keuangan", "barang"]);
});
