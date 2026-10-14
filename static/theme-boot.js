/* theme-boot.js - apply the saved theme before the first paint (after ui-prefs.js). */
(function () {
  "use strict";
  var saved = null;
  try { saved = localStorage.getItem("mc_theme"); } catch (_) { /* storage blocked: stay Hitam */ }
  if (window.UiPrefs && window.UiPrefs.normalizeTheme(saved) === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }
  // Tint the browser bar to match; the stylesheets above are already applied.
  var meta = document.querySelector('meta[name="theme-color"]');
  var bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (meta && bg) meta.setAttribute("content", bg);
})();
