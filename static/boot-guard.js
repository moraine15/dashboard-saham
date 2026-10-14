(() => {
  "use strict";
  window.__dashboardBootErrors = [];
  function record(value) {
    const message = value && value.message ? value.message : String(value || "Kesalahan tidak diketahui");
    window.__dashboardBootErrors.push(message);
  }
  window.addEventListener("error", (event) => record(event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => record(event.reason));
  window.__showBootFailure = () => {
    const splash = document.getElementById("splash");
    if (!splash) return;
    const detail = window.__dashboardBootErrors[0] || "Salah satu modul dashboard gagal dijalankan.";
    splash.classList.remove("hide");
    splash.style.visibility = "visible";
    splash.style.opacity = "1";
    splash.innerHTML = '<div class="boot-error"><b>Dashboard gagal dimuat</b><span></span><button type="button">Bersihkan & muat ulang</button></div>';
    splash.querySelector("span").textContent = detail;
    splash.querySelector("button").onclick = () => location.replace(`/fresh-start?retry=${Date.now()}`);
  };
  setTimeout(() => { if (!window.__dashboardReady) window.__showBootFailure(); }, 5000);
})();
