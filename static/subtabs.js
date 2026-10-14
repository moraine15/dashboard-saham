/* subtabs.js - text tabs inside a view (Pasar, Alat, Keuangan).
   Markup: a role="tablist" holding role="tab" buttons with data-sub and
   aria-controls pointing at their role="tabpanel". */
(function () {
  "use strict";

  function init(nav, opts) {
    const onChange = (opts && opts.onChange) || function () {};
    const tabs = Array.prototype.slice.call(nav.querySelectorAll('[role="tab"]'));
    let current = "";

    function apply(name) {
      tabs.forEach((tab) => {
        const on = tab.dataset.sub === name;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(tab.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      current = name;
    }

    function select(name) {
      if (!tabs.some((tab) => tab.dataset.sub === name)) return;
      apply(name);
      onChange(name);
    }

    tabs.forEach((tab) => tab.addEventListener("click", () => select(tab.dataset.sub)));

    nav.addEventListener("keydown", (e) => {
      const index = tabs.indexOf(e.target);
      if (index < 0) return;
      let next;
      if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else return;
      e.preventDefault();
      select(tabs[next].dataset.sub);
      tabs[next].focus();
    });

    if (tabs.length) apply(tabs[0].dataset.sub);
    return { select, current: () => current };
  }

  window.Subtabs = { init };
})();
