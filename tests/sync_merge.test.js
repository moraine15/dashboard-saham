"use strict";

// Three-way merge of state values edited on two devices at once.

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeKey, mergeState } = require("../static/sync-merge.js");

const J = JSON.stringify;
const parse = (s) => JSON.parse(s);

test("unchanged server takes ours; unchanged ours takes server", () => {
  assert.equal(mergeKey("mc_theme", "dark", "dark", "light"), "light");
  assert.equal(mergeKey("mc_theme", "dark", "light", "dark"), "light");
});

test("plain strings in conflict keep this device's value", () => {
  assert.equal(mergeKey("mc_theme", "dark", "light", "midnight"), "midnight");
});

test("transactions added on both devices are all kept", () => {
  const base = J([{ id: "a", amount: 1 }]);
  const server = J([{ id: "a", amount: 1 }, { id: "b", amount: 2 }]);
  const ours = J([{ id: "a", amount: 1 }, { id: "c", amount: 3 }]);
  assert.deepEqual(parse(mergeKey("mc_fin_tx", base, server, ours)).map((t) => t.id).sort(), ["a", "b", "c"]);
});

test("a record deleted on one side stays deleted unless the other side edited it", () => {
  const base = J([{ id: "a", note: "x" }, { id: "b", note: "y" }]);
  const ours = J([{ id: "b", note: "y" }]);
  assert.deepEqual(parse(mergeKey("mc_fin_tx", base, base, ours)), [{ id: "b", note: "y" }]);
  const serverEdited = J([{ id: "a", note: "edited" }, { id: "b", note: "y" }]);
  assert.deepEqual(parse(mergeKey("mc_fin_tx", base, serverEdited, ours)).map((t) => t.id), ["b", "a"]);
});

test("different fields edited on the same record are both kept", () => {
  const base = J([{ id: "a", name: "BCA", min: 0 }]);
  const server = J([{ id: "a", name: "BCA Utama", min: 0 }]);
  const ours = J([{ id: "a", name: "BCA", min: 100 }]);
  assert.deepEqual(parse(mergeKey("mc_fin_tx", base, server, ours)), [{ id: "a", name: "BCA Utama", min: 100 }]);
});

test("account balances combine both devices' movements", () => {
  const base = J([{ id: "a", balance: 100 }]);
  const server = J([{ id: "a", balance: 90 }]);
  const ours = J([{ id: "a", balance: 80 }]);
  assert.equal(parse(mergeKey("mc_fin_accounts", base, server, ours))[0].balance, 70);
});

test("RDN cash combines movements and treats a missing value as zero", () => {
  assert.equal(mergeKey("mc_rdn_cash", "1000", "1500", "800"), "1300");
  assert.equal(mergeKey("mc_rdn_cash", "1000", null, "1200"), "200");
  assert.equal(mergeKey("mc_rdn_cash", "1000", "500", null), "-500");
  assert.equal(mergeKey("mc_rdn_cash", "1000", "1000", null), null);
});

test("the same recurring posting made on two devices is booked once", () => {
  const tx = { id: "rec:r1:2026-10-01", type: "in", amount: 50, accId: "a" };
  const pending = {
    mc_fin_tx: { base: J([]), value: J([tx]) },
    mc_fin_accounts: { base: J([{ id: "a", balance: 100 }]), value: J([{ id: "a", balance: 150 }]) },
  };
  const server = { mc_fin_tx: J([tx]), mc_fin_accounts: J([{ id: "a", balance: 150 }]) };
  const out = mergeState(pending, server);
  assert.equal(parse(out.mc_fin_tx).length, 1);
  assert.equal(parse(out.mc_fin_accounts)[0].balance, 150);
  // With an extra local expense of 20, only that movement is added on top.
  pending.mc_fin_accounts.value = J([{ id: "a", balance: 130 }]);
  assert.equal(parse(mergeState(pending, server).mc_fin_accounts)[0].balance, 130);
});

test("barang items merge per project", () => {
  const base = J({ p1: [{ id: "x", qty: 1 }], p2: [{ id: "y", qty: 1 }] });
  const server = J({ p1: [{ id: "x", qty: 1 }, { id: "z", qty: 2 }], p2: [{ id: "y", qty: 1 }] });
  const ours = J({ p1: [{ id: "x", qty: 5 }] });
  assert.deepEqual(parse(mergeKey("mc_barang_items", base, server, ours)), { p1: [{ id: "x", qty: 5 }, { id: "z", qty: 2 }] });
});

test("portfolio positions merge by ticker", () => {
  const base = J([{ ticker: "BBCA.JK", lots: 1, avg: 9000 }]);
  const server = J([{ ticker: "BBCA.JK", lots: 1, avg: 9000 }, { ticker: "TLKM.JK", lots: 2, avg: 3000 }]);
  const ours = J([{ ticker: "BBCA.JK", lots: 3, avg: 8900 }]);
  assert.deepEqual(parse(mergeKey("saham_portfolio_v1", base, server, ours)).map((p) => p.ticker), ["BBCA.JK", "TLKM.JK"]);
});

test("watchlist merges as an ordered set", () => {
  const out = parse(mergeKey("saham_watchlist_v1", J(["BBCA.JK", "BBRI.JK"]), J(["BBCA.JK", "BBRI.JK", "TLKM.JK"]), J(["BBRI.JK", "BBCA.JK"])));
  assert.deepEqual(out, ["BBRI.JK", "BBCA.JK", "TLKM.JK"]);
});

test("arrays with repeated values are treated as a whole", () => {
  const base = J({ slots: ["ara", "ara"] });
  assert.deepEqual(parse(mergeKey("mc_ara", base, J({ slots: ["arb", "ara"] }), J({ slots: ["ara", "arb"] }))), { slots: ["ara", "arb"] });
});

test("all-time highs keep the larger value", () => {
  const base = J({ all: { val: 100, date: "2026-10-01" } });
  const server = J({ all: { val: 300, date: "2026-10-03" } });
  const ours = J({ all: { val: 200, date: "2026-10-02" } });
  assert.deepEqual(parse(mergeKey("mc_fin_ath", base, server, ours)), { all: { val: 300, date: "2026-10-03" } });
});

test("removal on this device versus an edit elsewhere keeps the edit", () => {
  assert.equal(mergeKey("mc_fin_targets", J({ monthly: 1 }), J({ monthly: 2 }), null), J({ monthly: 2 }));
  assert.equal(mergeKey("mc_fin_targets", J({ monthly: 1 }), J({ monthly: 1 }), null), null);
});

test("forced keys skip the merge", () => {
  const out = mergeState({ mc_fin_tx: { base: J([{ id: "a" }]), value: J([]), force: true } }, { mc_fin_tx: J([{ id: "a" }, { id: "b" }]) });
  assert.equal(out.mc_fin_tx, J([]));
});
