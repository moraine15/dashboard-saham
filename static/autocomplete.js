/* autocomplete.js - ticker suggestions while typing. Uses the global $. */
"use strict";
(function () {
  const drop = document.createElement("div");
  drop.id = "acDrop"; drop.style.display = "none";
  document.body.appendChild(drop);

  let activeInput = null, items = [], sel = -1, timer = null, lastQ = "", suppress = false;

  function hide() { drop.style.display = "none"; sel = -1; activeInput = null; lastQ = ""; }

  function position(input) {
    const r = input.getBoundingClientRect();
    drop.style.left = r.left + window.scrollX + "px";
    drop.style.top = r.bottom + window.scrollY + 2 + "px";
    drop.style.width = Math.max(r.width, 220) + "px";
  }

  function renderList() {
    if (!items.length) { hide(); return; }
    drop.innerHTML = items.map((it, i) =>
      `<div class="ac-item${i === sel ? " active" : ""}" data-i="${i}">
        <span class="ac-sym">${escHtml(it.symbol)}</span><span class="ac-name">${escHtml(it.name)}</span></div>`).join("");
    drop.style.display = "block";
    drop.querySelectorAll(".ac-item").forEach((el) => {
      el.onmousedown = (e) => { e.preventDefault(); pick(+el.dataset.i); };
    });
  }

  function pick(i) {
    const it = items[i]; if (!it || !activeInput) return;
    activeInput.value = it.symbol;
    const inp = activeInput;
    hide();
    // Dispatch input so other modules react, without reopening the dropdown.
    suppress = true;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.focus();
  }

  async function query(input) {
    const q = input.value.trim();
    if (q.length < 1 || q === lastQ) return;
    lastQ = q;
    try {
      const d = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json();
      if (activeInput !== input) return;
      items = d.results || []; sel = -1;
      position(input); renderList();
    } catch { hide(); }
  }

  function attach(input) {
    if (!input) return;
    input.setAttribute("autocomplete", "off");
    input.addEventListener("input", () => {
      if (suppress) { suppress = false; return; }
      activeInput = input;
      clearTimeout(timer);
      if (!input.value.trim()) { hide(); return; }
      timer = setTimeout(() => query(input), 160);
    });
    // Capture phase: a highlighted suggestion is filled in before the page's own
    // Enter handler reads the input. A partial code (under 4 letters) takes the
    // first suggestion instead of being added as typed.
    input.addEventListener("keydown", (e) => {
      if (drop.style.display === "none") return;
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); renderList(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); renderList(); }
      else if (e.key === "Enter") {
        const typed = input.value.trim().toUpperCase().replace(/\.JK$/, "");
        const choice = sel >= 0 ? sel : (typed.length < 4 && items.length ? 0 : -1);
        if (choice >= 0) { e.preventDefault(); pick(choice); }
      }
      else if (e.key === "Escape") { e.preventDefault(); hide(); }
    }, true);
    input.addEventListener("blur", () => setTimeout(hide, 150));
  }

  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);

  window.acAttach = attach;   // so other modules can attach autocomplete
  attach($("tickerInput"));
  attach($("pfTicker"));
  attach($("ipoTicker"));
  attach($("jrTicker"));
  attach($("cmpInput"));
})();
