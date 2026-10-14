(() => {
  "use strict";
  async function clearLegacyBrowserCaches() {
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }
    } catch (_) { /* Cleanup is best effort; login continues without it. */ }
  }
  async function postJson(url, body) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let data = {};
    try { data = await response.json(); } catch (_) { /* a non-JSON error page */ }
    if (!response.ok) throw new Error(data.error || "Permintaan gagal.");
    return data;
  }
  function openDashboard() { location.replace(`/?fresh=${Date.now()}`); }

  const form = document.getElementById("loginForm");
  if (form) {
    const password = document.getElementById("password");
    const message = document.getElementById("message");
    const submit = document.getElementById("submitButton");
    const reveal = document.getElementById("showPassword");
    reveal.addEventListener("click", () => {
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      reveal.textContent = show ? "Sembunyikan" : "Lihat";
      reveal.setAttribute("aria-pressed", show ? "true" : "false");
      password.focus();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); message.textContent = ""; submit.disabled = true;
      try {
        await postJson("/api/auth/login", { password: password.value, role: document.getElementById("adminRole").checked ? "admin" : "owner" });
        await clearLegacyBrowserCaches();
        openDashboard();
      } catch (error) {
        message.textContent = error.message || "Login gagal.";
        password.select();
      } finally { submit.disabled = false; }
    });
  }

  const setup = document.getElementById("setupForm");
  if (setup) {
    const code = document.getElementById("setupCode");
    // The server opens this page as /#setup=CODE; take the code and drop it from the address bar.
    const match = /(?:^#|&)setup=([A-Za-z0-9-]+)/.exec(location.hash);
    if (match) {
      code.value = match[1];
      history.replaceState(null, "", location.pathname);
    }
    const output = document.getElementById("setupMessage");
    const button = document.getElementById("setupButton");
    setup.addEventListener("submit", async (event) => {
      event.preventDefault(); output.textContent = "";
      const p1 = document.getElementById("setupPassword").value;
      const p2 = document.getElementById("setupPassword2").value;
      if (p1.length < 8) { output.textContent = "Password minimal 8 karakter."; return; }
      if (p1 !== p2) { output.textContent = "Kedua password tidak sama."; return; }
      button.disabled = true;
      try {
        await postJson("/api/auth/setup", { password: p1, app_name: document.getElementById("setupName").value, code: code.value });
        openDashboard();
      } catch (error) {
        output.textContent = error.message || "Pengaturan gagal.";
      } finally { button.disabled = false; }
    });
  }
})();
