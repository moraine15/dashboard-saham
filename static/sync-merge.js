/* Three-way merge for state edited on more than one device.
 *
 * Every value is merged from (base, server, ours): base is what this device
 * last saw on the server, ours is its current value. Values are the stored
 * strings; null means the key is absent.
 */
"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SyncMerge = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MISSING = undefined;

  // Per-key rules. Keys not listed use the default: objects merge per field,
  // arrays of records merge by "id", arrays of unique strings merge as sets.
  const ACCOUNT_RULE = { keyBy: "id", item: { fields: { balance: { accum: true } } } };
  const RULES = {
    saham_portfolio_v1: { keyBy: "ticker" },
    mc_fin_accounts: ACCOUNT_RULE,
    mc_rdn_cash: { accum: true, zeroIsMissing: true },
    mc_fin_ath: { values: { maxBy: "val" } },
  };

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) {
      return Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every((key) => key in b && equal(a[key], b[key]));
    }
    return false;
  }

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function recordKey(rule) { return (rule && rule.keyBy) || "id"; }

  function isRecordArray(values, key) {
    return values.every((list) => list === MISSING || (Array.isArray(list)
      && list.every((item) => isPlainObject(item) && (typeof item[key] === "string" || typeof item[key] === "number"))));
  }

  function isUniqueScalarArray(values) {
    return values.every((list) => list === MISSING || (Array.isArray(list)
      && list.every((item) => item === null || typeof item !== "object")
      && new Set(list).size === list.length));
  }

  function mergeRecords(base, server, ours, rule) {
    const key = recordKey(rule);
    const index = (list) => new Map((list || []).map((item) => [item[key], item]));
    const baseMap = index(base), serverMap = index(server);
    const out = [];
    const placed = new Set();
    (ours || []).forEach((item) => {
      const id = item[key];
      placed.add(id);
      if (serverMap.has(id)) {
        const merged = merge3(baseMap.get(id), serverMap.get(id), item, rule.item);
        if (merged !== MISSING) out.push(merged);
      } else if (!baseMap.has(id) || !equal(item, baseMap.get(id))) {
        // Added here, or edited here after the other device deleted it.
        out.push(item);
      }
    });
    (server || []).forEach((item, position) => {
      const id = item[key];
      if (placed.has(id)) return;
      placed.add(id);
      // Deleted here: keep it only if the other device changed it meanwhile.
      if (baseMap.has(id) && equal(item, baseMap.get(id))) return;
      const before = (server || []).slice(0, position).reverse().find((prev) => out.some((x) => x[key] === prev[key]));
      const at = before ? out.findIndex((x) => x[key] === before[key]) + 1 : out.length;
      out.splice(at, 0, item);
    });
    return out;
  }

  function mergeSet(base, server, ours) {
    const baseSet = new Set(base || []), oursSet = new Set(ours || []), serverSet = new Set(server || []);
    const out = (ours || []).filter((item) => serverSet.has(item) || !baseSet.has(item));
    (server || []).forEach((item) => {
      if (!oursSet.has(item) && !baseSet.has(item)) out.push(item);
    });
    return out;
  }

  function mergeObjects(base, server, ours, rule) {
    const b = isPlainObject(base) ? base : {};
    const out = {};
    const keys = new Set([...Object.keys(server), ...Object.keys(ours)]);
    keys.forEach((key) => {
      const fieldRule = (rule && rule.fields && rule.fields[key]) || (rule && rule.values) || {};
      const merged = merge3(b[key], server[key], ours[key], fieldRule);
      if (merged !== MISSING) out[key] = merged;
    });
    return out;
  }

  // Merge parsed JSON values. MISSING means the value was deleted or never existed.
  function merge3(base, server, ours, rule) {
    rule = rule || {};
    if (rule.accum && [base, server, ours].every((v) => v === MISSING || typeof v === "number")) {
      if (equal(server, base)) return ours;
      if (equal(ours, base)) return server;
      return toNumber(server) + toNumber(ours) - toNumber(base);
    }
    if (equal(server, base)) return ours;
    if (equal(ours, base) || equal(ours, server)) return server;
    if (rule.maxBy && isPlainObject(server) && isPlainObject(ours)) {
      return toNumber(server[rule.maxBy]) > toNumber(ours[rule.maxBy]) ? server : ours;
    }
    if (server === MISSING || ours === MISSING) {
      // One side deleted, the other changed: keep the change.
      return server === MISSING ? ours : server;
    }
    if (isPlainObject(server) && isPlainObject(ours) && (base === MISSING || isPlainObject(base))) {
      return mergeObjects(base, server, ours, rule);
    }
    if (Array.isArray(server) && Array.isArray(ours) && (base === MISSING || Array.isArray(base))) {
      if (isRecordArray([base, server, ours], recordKey(rule))) return mergeRecords(base, server, ours, rule);
      if (isUniqueScalarArray([base, server, ours])) return mergeSet(base, server, ours);
    }
    return ours;
  }

  function decode(text) {
    if (text === null || text === MISSING) return { ok: true, value: MISSING };
    try { return { ok: true, value: JSON.parse(text) }; } catch (_) { return { ok: false, value: text }; }
  }

  function encode(value, rule) {
    if (value === MISSING) return null;
    if (rule && rule.zeroIsMissing && value === 0) return null;
    return JSON.stringify(value);
  }

  /** Merge one stored value. Returns the merged string, or null when absent. */
  function mergeKey(key, baseText, serverText, oursText) {
    const norm = (v) => (v === MISSING ? null : v);
    const base = norm(baseText), server = norm(serverText), ours = norm(oursText);
    if (server === base) return ours;
    if (ours === base || ours === server) return server;
    const parsed = [decode(base), decode(server), decode(ours)];
    if (!parsed.every((p) => p.ok)) return ours === null ? server : ours;
    const rule = RULES[key] || {};
    return encode(merge3(parsed[0].value, parsed[1].value, parsed[2].value, rule), rule);
  }

  // A transaction both devices added under the same id (a recurring posting)
  // moved the balance on both sides. Remove it from this device's balances
  // before merging so the movement is counted once.
  function withoutDuplicatePostings(pending, serverState) {
    const tx = pending.mc_fin_tx, accounts = pending.mc_fin_accounts;
    if (!tx || !accounts || tx.force || accounts.force) return accounts && accounts.value;
    const byId = (text) => {
      const parsed = decode(text);
      return new Map((Array.isArray(parsed.value) ? parsed.value : []).map((t) => [t && t.id, t]));
    };
    const base = byId(tx.base), server = byId(serverState.mc_fin_tx), ours = byId(tx.value);
    const duplicates = [...ours.keys()].filter((id) => !base.has(id) && server.has(id));
    const parsed = decode(accounts.value);
    if (!duplicates.length || !Array.isArray(parsed.value)) return accounts.value;
    const adjusted = parsed.value.map((account) => ({ ...account }));
    duplicates.forEach((id) => {
      const t = ours.get(id);
      const account = adjusted.find((a) => a.id === t.accId);
      if (account) account.balance = toNumber(account.balance) - (t.type === "in" ? 1 : -1) * toNumber(t.amount);
    });
    return JSON.stringify(adjusted);
  }

  /**
   * Merge every pending key against the server state.
   * pending: { key: { base, value, force } } where value/base are strings or null.
   * Returns { key: mergedString | null }.
   */
  function mergeState(pending, serverState) {
    const result = {};
    Object.entries(pending).forEach(([key, entry]) => {
      const server = key in serverState ? serverState[key] : null;
      const ours = key === "mc_fin_accounts" ? withoutDuplicatePostings(pending, serverState) : entry.value;
      result[key] = entry.force ? entry.value : mergeKey(key, entry.base, server, ours);
    });
    return result;
  }

  return { merge3, mergeKey, mergeState, RULES };
});
