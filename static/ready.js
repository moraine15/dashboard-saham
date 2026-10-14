(() => {
  "use strict";
  if (!window.__appLoaded) {
    window.__dashboardBootErrors.push("Modul inti gagal dimuat.");
    window.__showBootFailure();
    return;
  }
  window.__dashboardReady = true;
  window.dispatchEvent(new Event("mc:modules-ready"));
  const splash = document.getElementById("splash");
  if (splash) {
    splash.classList.add("hide");
    setTimeout(() => { if (splash.isConnected) splash.remove(); }, 450);
  }
})();
