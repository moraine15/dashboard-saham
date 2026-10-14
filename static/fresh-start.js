(() => {
  "use strict";
  let continued = false;
  function continueToApp() {
    if (continued) return;
    continued = true;
    location.replace(`/?clean=${Date.now()}`);
  }
  async function clean() {
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }
    } catch (_) { /* Continue with a versioned navigation regardless. */ }
    continueToApp();
  }
  document.getElementById("continueButton").addEventListener("click", continueToApp);
  setTimeout(continueToApp, 3500);
  clean();
})();
