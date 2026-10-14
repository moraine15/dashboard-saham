/* layout.js - the navigation drawer on narrow screens (below 1024 px). */
(function () {
  "use strict";
  var toggle = document.getElementById("railToggle");
  var rail = document.getElementById("workspaceRail");
  var scrim = document.getElementById("railScrim");
  if (!toggle || !rail || !scrim) return;

  var narrow = window.matchMedia("(max-width: 1023px)");

  function isOpen() {
    return document.body.classList.contains("rail-open");
  }

  // A closed drawer is out of reach for keyboard and screen readers.
  function syncInert() {
    rail.inert = narrow.matches && !isOpen();
  }

  function open() {
    document.body.classList.add("rail-open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Tutup navigasi");
    scrim.hidden = false;
    syncInert();
    var active = rail.querySelector('.tab[aria-selected="true"]') || rail.querySelector(".tab");
    if (active) { try { active.focus(); } catch (e) { /* */ } }
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    document.body.classList.remove("rail-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Buka navigasi");
    scrim.hidden = true;
    syncInert();
    if (returnFocus) { try { toggle.focus(); } catch (e) { /* */ } }
  }

  toggle.addEventListener("click", function () {
    if (!narrow.matches) return;
    if (isOpen()) close(true); else open();
  });

  scrim.addEventListener("click", function () { close(true); });

  document.addEventListener("keydown", function (e) {
    // A dialog, the palette or a suggestion list handles its own Escape first.
    if (e.key === "Escape" && isOpen() && !e.defaultPrevented) { e.preventDefault(); close(true); }
  });

  // Close the drawer when a tab or workspace is picked.
  rail.addEventListener("click", function (e) {
    if (!narrow.matches) return;
    if (e.target.closest && e.target.closest(".tab, .modebtn")) close(true);
  });

  function onChange() {
    if (!narrow.matches) close(false);
    syncInert();
  }
  if (narrow.addEventListener) narrow.addEventListener("change", onChange);
  else if (narrow.addListener) narrow.addListener(onChange);
  syncInert();
})();
