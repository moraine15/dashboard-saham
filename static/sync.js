/* Server-backed state sync with a persisted queue and three-way merge.
 *
 * localStorage holds the working copy. Every app-key change is queued in
 * META_KEY together with the server value it was based on, so an edit made
 * offline, after the session expired, or while another device saved first is
 * merged (SyncMerge) instead of being dropped or overwriting other edits.
 * Modules keep their own in-memory copies, so when data they hold changes
 * underneath them the page reloads rather than updating in place.
 */
(() => {
  "use strict";
  const PREFIX = /^(saham_|mc_)/;
  const BLOCKED = new Set(["mc_password", "mc_custom_theme"]);
  // Values that are derived or only affect presentation. Other devices' changes
  // to these are applied quietly instead of reloading the page.
  const QUIET = new Set([
    "mc_fin_hist", "mc_fin_ath", "mc_mode", "mc_investment_view_v1", "mc_collapsed",
    "mc_theme", "mc_font", "mc_font_size", "mc_density", "mc_hide", "mc_hide_pages", "saham_autorefresh_v1",
  ]);
  const META_KEY = "__sync_meta";
  const PULL_MS = 60000;
  const MAX_CONFLICT_RETRIES = 5;
  const proto = Object.getPrototypeOf(localStorage) || Storage.prototype;
  const nativeGet = proto.getItem;
  const nativeSet = proto.setItem;
  const nativeRemove = proto.removeItem;
  const nativeClear = proto.clear;
  const nativeFetch = window.fetch.bind(window);
  // Without the merge module, this device's value wins.
  const merge = window.SyncMerge || {
    mergeKey: (_key, _base, _server, ours) => ours,
    mergeState: (pending) => Object.fromEntries(Object.entries(pending).map(([key, entry]) => [key, entry.value])),
  };

  let csrfToken = "";
  let hydrated = false;
  let serverValues = {};
  let timer = null;
  let flushing = null;
  let flushAgain = false;
  let retryDelay = 5000;
  let reloadRequested = false;
  const forceKeys = new Set();

  function appKey(key) { return PREFIX.test(key) && !BLOCKED.has(key); }
  function status(value) { try { if (window.__syncStatus) window.__syncStatus(value); } catch (_) { /* status chip is optional */ } }
  function local(key) { return nativeGet.call(localStorage, key); }
  const norm = (value) => (value === undefined ? null : value);

  // The queue lives in localStorage so it survives reloads, logins and other tabs.
  function readMeta() {
    try {
      const meta = JSON.parse(local(META_KEY) || "{}");
      return { pending: meta.pending || {}, revision: Number(meta.revision) || 0, epoch: meta.epoch == null ? null : meta.epoch };
    } catch (_) {
      return { pending: {}, revision: 0, epoch: null };
    }
  }
  function writeMeta(meta) {
    try { nativeSet.call(localStorage, META_KEY, JSON.stringify(meta)); } catch (_) { status("error"); }
  }
  function sendable(meta) { return Object.keys(meta.pending).filter((key) => !meta.pending[key].rejected); }
  function hasPending() { return sendable(readMeta()).length > 0; }
  function hasRejected() { const meta = readMeta(); return Object.keys(meta.pending).some((key) => meta.pending[key].rejected); }

  // What this page's modules last read or wrote for each key. If another tab
  // changed a key since, a write from this page is merged with that change.
  const seen = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && appKey(key)) seen[key] = local(key);
  }
  const startValues = { ...seen };

  function record(key, value) {
    const meta = readMeta();
    const entry = meta.pending[key];
    let base;
    if (entry) base = norm(entry.base);
    else if (hydrated) base = key in serverValues ? serverValues[key] : null;
    else base = key in startValues ? startValues[key] : null;
    const force = forceKeys.has(key) || Boolean(entry && entry.force);
    if (value === base && !force) delete meta.pending[key];   // back to what the server has
    else meta.pending[key] = { value, base, force };
    writeMeta(meta);
    schedule();
  }

  // A write from this page: merge with any change another tab made meanwhile.
  function localWrite(storage, key, value) {
    const current = local(key);
    const believed = key in seen ? seen[key] : null;
    if (current !== believed && !forceKeys.has(key)) value = merge.mergeKey(key, believed, current, value);
    seen[key] = value;
    if (value === current) return;
    if (value === null) nativeRemove.call(storage, key); else nativeSet.call(storage, key, value);
    record(key, value);
  }

  window.fetch = (input, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const url = typeof input === "string" ? input : input.url;
    if (csrfToken && url.startsWith("/") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const headers = new Headers(init.headers || {});
      headers.set("X-CSRF-Token", csrfToken);
      init = { ...init, headers };
    }
    return nativeFetch(input, init).then((response) => {
      if (response.status === 401 && url.startsWith("/api/") && !url.startsWith("/api/auth/")) location.assign("/");
      return response;
    });
  };

  function isEditing() {
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
    return Boolean(document.querySelector(".modal-overlay:not([hidden]), dialog[open]"));
  }

  // Reload once the user is not mid-edit; queued edits are already persisted.
  function requestReload() {
    if (reloadRequested) return;
    reloadRequested = true;
    status("stale");
    const go = () => {
      if (isEditing()) { setTimeout(go, 1500); return; }
      location.reload();
    };
    go();
  }

  // Apply the server state plus the merged queue. Returns the keys whose stored value changed.
  function applyServerState(state, revision, epoch) {
    let meta = readMeta();
    if (meta.epoch !== null && epoch !== meta.epoch) meta.pending = {};  // server data was reset
    const merged = merge.mergeState(meta.pending, state);
    const target = {};
    Object.entries(state).forEach(([key, value]) => { if (appKey(key) && typeof value === "string") target[key] = value; });
    Object.entries(merged).forEach(([key, value]) => {
      const server = key in state ? state[key] : null;
      if (value === null) delete target[key]; else target[key] = value;
      if (value === server) delete meta.pending[key];
      else meta.pending[key] = { ...meta.pending[key], value, base: server };
    });
    const changed = [];
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && appKey(key) && !(key in target)) { nativeRemove.call(localStorage, key); changed.push(key); }
    }
    Object.entries(target).forEach(([key, value]) => {
      if (local(key) !== value) { nativeSet.call(localStorage, key, value); changed.push(key); }
    });
    BLOCKED.forEach((key) => nativeRemove.call(localStorage, key));
    serverValues = { ...state };
    meta = { ...meta, revision, epoch };
    writeMeta(meta);
    return changed;
  }
  const needsReload = (keys) => keys.some((key) => !QUIET.has(key));

  async function fetchState() {
    const response = await nativeFetch("/api/state", { cache: "no-store" });
    if (response.status === 401) { location.assign("/"); throw new Error("Sesi berakhir"); }
    if (!response.ok) { const error = new Error("State tidak dapat dimuat"); error.status = response.status; throw error; }
    const payload = await response.json();
    return { state: payload.state || {}, revision: Number(payload.revision) || 0, epoch: payload.epoch == null ? 0 : payload.epoch };
  }

  async function bootstrap() {
    const authResponse = await nativeFetch("/api/auth/session", { cache: "no-store" });
    const auth = await authResponse.json();
    if (!auth.authenticated) { location.replace("/"); return; }
    csrfToken = auth.csrf_token || "";
    window.__authRole = auth.role;
    await hydrate();
  }

  async function hydrate() {
    let changed;
    let revision;
    try {
      const snapshot = await fetchState();
      // Values the server refused last time get one more try per page load.
      const meta = readMeta();
      Object.values(meta.pending).forEach((entry) => { delete entry.rejected; });
      writeMeta(meta);
      changed = applyServerState(snapshot.state, snapshot.revision, snapshot.epoch);
      revision = snapshot.revision;
    } catch (error) {
      // Never clear local data because the server could not answer.
      status(error.status === 503 ? "unavailable" : "offline");
      setTimeout(hydrate, 15000);
      return;
    }
    hydrated = true;
    if (hasPending()) schedule();
    else status("saved");
    const marker = `mc_reloaded_${revision}`;
    if (needsReload(changed) && window.__dashboardReady && !sessionStorage.getItem(marker)) {
      sessionStorage.setItem(marker, "1");
      location.reload();
    }
  }

  async function post(meta, keys) {
    const changes = {}, removals = [];
    keys.forEach((key) => {
      const value = meta.pending[key].value;
      if (value === null) removals.push(key); else changes[key] = value;
    });
    const body = JSON.stringify({ changes, removals, revision: meta.revision, epoch: meta.epoch });
    // Browsers reject keepalive bodies above 64 KB; the persisted queue covers larger ones.
    const response = await window.fetch("/api/state", {
      method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000,
    });
    let data = {};
    try { data = await response.json(); } catch (_) { /* non-JSON error page */ }
    return { response, data };
  }

  async function sendQueue() {
    let conflicts = 0;
    let oneByOne = false;   // after a refusal, find the refused key by sending keys singly
    let refused = false;
    for (;;) {
      const meta = readMeta();
      let keys = sendable(meta);
      if (!keys.length) break;
      if (oneByOne) keys = keys.slice(0, 1);
      const sent = {};
      keys.forEach((key) => { sent[key] = meta.pending[key].value; });
      const { response, data } = await post(meta, keys);

      if (response.ok) {
        const after = readMeta();
        keys.forEach((key) => {
          if (sent[key] === null) delete serverValues[key]; else serverValues[key] = sent[key];
          const entry = after.pending[key];
          if (entry && entry.value === sent[key]) delete after.pending[key];
          else if (entry) entry.base = sent[key];
        });
        writeMeta({ ...after, revision: Number(data.revision) || after.revision, epoch: data.epoch == null ? after.epoch : data.epoch });
        retryDelay = 5000;
        if (oneByOne) continue;
        break;
      }
      if (response.status === 409) {
        if (data.reason === "epoch") {
          writeMeta({ ...readMeta(), pending: {} });
          requestReload();
          return;
        }
        conflicts += 1;
        if (conflicts > MAX_CONFLICT_RETRIES) throw Object.assign(new Error("Konflik berulang"), { status: 409 });
        const snapshot = await fetchState();
        if (needsReload(applyServerState(snapshot.state, snapshot.revision, snapshot.epoch))) requestReload();
        await new Promise((resolve) => setTimeout(resolve, 200 * conflicts));
        continue;
      }
      if (response.status === 400 || response.status === 413) {
        if (keys.length > 1) { oneByOne = true; continue; }
        // The server refuses this value; keep it locally and stop resending it.
        const after = readMeta();
        if (after.pending[keys[0]]) after.pending[keys[0]].rejected = true;
        writeMeta(after);
        refused = true;
        continue;
      }
      throw Object.assign(new Error(data.error || "Sinkronisasi gagal"), { status: response.status });
    }
    if (refused) throw Object.assign(new Error("Nilai ditolak server"), { status: 400 });
  }

  async function flush() {
    timer = null;
    if (!hydrated) return;
    if (flushing) { flushAgain = true; return flushing; }
    if (!hasPending()) { status(hasRejected() ? "error" : "saved"); return; }
    status("saving");
    const run = () => sendQueue();
    flushing = (navigator.locks ? navigator.locks.request("mc-sync", run) : run())
      .then(() => status(hasPending() ? "saving" : hasRejected() ? "error" : "saved"))
      .catch((error) => {
        if (error.status === 401 || error.status === 403) { status("offline"); location.assign("/"); return; }
        if (error.status === 400 || error.status === 413) { status("error"); return; }
        status(error.status === 503 ? "unavailable" : "offline");
        setTimeout(schedule, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60000);
      })
      .finally(() => {
        flushing = null;
        if (flushAgain) { flushAgain = false; schedule(); }
      });
    return flushing;
  }
  function schedule() { if (hydrated && !timer) timer = setTimeout(flush, 500); }

  window.__syncFlush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
    if (flushing) await flushing;
  };
  // Restoring a backup overwrites server data instead of merging with it.
  window.__syncForce = (keys) => { (keys || []).forEach((key) => forceKeys.add(key)); };

  // Pick up changes saved by other devices.
  async function pull() {
    if (!hydrated || reloadRequested) return;
    if (hasPending()) { schedule(); return; }
    try {
      const response = await nativeFetch("/api/state/revision", { cache: "no-store" });
      if (!response.ok) return;
      const remote = await response.json();
      const meta = readMeta();
      if (remote.revision === meta.revision && remote.epoch === meta.epoch) return;
      const snapshot = await fetchState();
      if (hasPending()) { schedule(); return; }
      if (needsReload(applyServerState(snapshot.state, snapshot.revision, snapshot.epoch))) requestReload();
    } catch (_) { /* offline; try again later */ }
  }
  setInterval(pull, PULL_MS);
  document.addEventListener("visibilitychange", pull);
  window.addEventListener("focus", pull);
  window.addEventListener("online", schedule);
  // Another tab of this browser changed data this page may hold in memory.
  window.addEventListener("storage", (event) => {
    if (event.key && appKey(event.key) && !QUIET.has(event.key) && hydrated) requestReload();
  });
  window.addEventListener("pagehide", () => { if (timer) { clearTimeout(timer); flush(); } });

  proto.setItem = function setItem(key, value) {
    key = String(key);
    if (this !== window.localStorage) { nativeSet.call(this, key, value); return; }
    if (BLOCKED.has(key)) return;
    if (!appKey(key)) { nativeSet.call(this, key, value); return; }
    localWrite(this, key, String(value));
  };
  proto.removeItem = function removeItem(key) {
    key = String(key);
    if (this !== window.localStorage || !appKey(key)) { nativeRemove.call(this, key); return; }
    localWrite(this, key, null);
  };
  proto.clear = function clear() {
    if (this !== window.localStorage) { nativeClear.call(this); return; }
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i); if (key && appKey(key)) keys.push(key);
    }
    keys.forEach((key) => localWrite(this, key, null));
  };

  window.__stateReady = bootstrap().catch((error) => {
    status("offline");
    const splash = document.getElementById("splash");
    if (splash) splash.textContent = "Data privat gagal dimuat. Muat ulang halaman.";
    throw error;
  });
})();
