"use strict";

// Tests for money logic in static/ara.js, static/journal.js, static/finance.js.
// The modules are DOM-coupled IIFEs, so we load the source in a vm context with
// minimal stubs (same spirit as investments.test.js, which requires a pure module),
// then exercise the pure helpers each module exports on window: araMath,
// journalMath, financeMath.

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadModule } = require("./helpers/vm_module.js");

/* ---------------- ARA / ARB band + tick rounding ---------------- */

test("araMath bands follow IDX symmetric rule", () => {
  const { win } = loadModule("ara.js");
  const m = win.araMath;
  assert.equal(m.pct(50), 0.35);
  assert.equal(m.pct(200), 0.35);   // boundary: 200 still in the 35% band
  assert.equal(m.pct(201), 0.25);
  assert.equal(m.pct(5000), 0.25);  // boundary: 5000 still in the 25% band
  assert.equal(m.pct(5001), 0.20);
});

test("araMath tick sizes follow IDX fraction table", () => {
  const { win } = loadModule("ara.js");
  const m = win.araMath;
  assert.equal(m.tick(100), 1);
  assert.equal(m.tick(199), 1);
  assert.equal(m.tick(200), 2);
  assert.equal(m.tick(499), 2);
  assert.equal(m.tick(500), 5);
  assert.equal(m.tick(1999), 5);
  assert.equal(m.tick(2000), 10);
  assert.equal(m.tick(4999), 10);
  assert.equal(m.tick(5000), 25);
  assert.equal(m.tick(10000), 25);
});

test("araMath ARA floors to a valid tick, ARB ceils to a valid tick", () => {
  const { win } = loadModule("ara.js");
  const m = win.araMath;
  // ref 1000 (band 25%, tick 5): up raw 1250 -> floor to tick = 1250; down raw 750 -> ceil = 750
  assert.equal(m.araLimit(1000), 1250);
  assert.equal(m.arbLimit(1000), 750);
  // ref 2000 (band 25%, tick 10): up raw 2500 -> 2500; down raw 1500 (tick at 1500 is 5) -> 1500
  assert.equal(m.araLimit(2000), 2500);
  // ref 102 (band 35%, tick 1): up raw 137.7 -> floor 137; down raw 66.3 -> ceil 67
  assert.equal(m.araLimit(102), 137);
  assert.equal(m.arbLimit(102), 67);
});

test("araMath ARB never falls below the Rp50 minimum price", () => {
  const { win } = loadModule("ara.js");
  const m = win.araMath;
  // ref 60 (band 35%): raw down = 39, below the floor -> clamp to 50
  assert.equal(m.arbLimit(60), 50);
  assert.equal(m.arbLimit(50), 50);
});

/* ---------------- journal average cost + realized P/L ---------------- */

test("journalMath computes average cost and realized P/L on a partial sell", () => {
  const { win } = loadModule("journal.js");
  const compute = win.journalMath.computeFrom;
  // Buy 10 lots @ 1000 (fee 0), buy 10 lots @ 1200 (fee 0): avg = 1100 over 20 lots.
  // Sell 5 lots @ 1300 fee 0: realized = (1300-1100)*500 = 100000, 15 lots remain @ 1100.
  const r = compute([
    { date: "2026-01-01", seq: 0, side: "buy", ticker: "AAA", lots: 10, price: 1000, fee: 0 },
    { date: "2026-01-02", seq: 1, side: "buy", ticker: "AAA", lots: 10, price: 1200, fee: 0 },
    { date: "2026-01-03", seq: 2, side: "sell", ticker: "AAA", lots: 5, price: 1300, fee: 0 },
  ]);
  assert.equal(r.realized, 100000);
  assert.equal(r.sells, 1);
  assert.equal(r.wins, 1);
  const open = r.open.find((o) => o.ticker === "AAA");
  assert.equal(open.lots, 15);
  assert.equal(open.avg, 1100);
});

test("journalMath includes fees in cost and realized P/L", () => {
  const { win } = loadModule("journal.js");
  const compute = win.journalMath.computeFrom;
  // Buy 1 lot (100 sh) @ 1000, fee 5000: cost = 105000, avg = 1050.
  // Sell 1 lot @ 1100, fee 5000: realized = (1100-1050)*100 - 5000 = 0.
  const r = compute([
    { date: "2026-02-01", seq: 0, side: "buy", ticker: "BBB", lots: 1, price: 1000, fee: 5000 },
    { date: "2026-02-02", seq: 1, side: "sell", ticker: "BBB", lots: 1, price: 1100, fee: 5000 },
  ]);
  assert.equal(r.realized, 0);
  assert.equal(r.wins, 0);          // pnl is 0, not > 0
  // Closed position is still listed (lots 0) to surface its realized P/L.
  assert.equal(r.open.find((o) => o.ticker === "BBB").lots, 0);
});

test("journalMath orders by date then seq", () => {
  const { win } = loadModule("journal.js");
  const compute = win.journalMath.computeFrom;
  // Deliberately out of order: sell listed before buy but earlier date/seq must sort first.
  const r = compute([
    { date: "2026-03-02", seq: 1, side: "sell", ticker: "CCC", lots: 1, price: 1200, fee: 0 },
    { date: "2026-03-01", seq: 0, side: "buy", ticker: "CCC", lots: 1, price: 1000, fee: 0 },
  ]);
  assert.equal(r.realized, 20000);  // (1200-1000)*100
  assert.equal(r.warned, false);    // buy processed before sell, no negative position
});

test("journalMath flags selling with no position", () => {
  const { win } = loadModule("journal.js");
  const compute = win.journalMath.computeFrom;
  const r = compute([
    { date: "2026-04-01", seq: 0, side: "sell", ticker: "DDD", lots: 1, price: 1000, fee: 0 },
  ]);
  assert.equal(r.warned, true);
  assert.equal(r.realized, 0);
});

test("journalMath rejects a sell dated before the shares were bought", () => {
  const { win } = loadModule("journal.js");
  const shortfall = win.journalMath.firstShortfall;
  const buy = { date: "2026-05-10", seq: 1, side: "buy", ticker: "EEE", lots: 5, price: 1000, fee: 0 };
  const early = { date: "2026-05-01", seq: 2, side: "sell", ticker: "EEE", lots: 2, price: 1100, fee: 0 };
  assert.equal(JSON.stringify(shortfall([buy, early], "EEE")), JSON.stringify({ date: "2026-05-01", available: 0 }));
  const later = { ...early, date: "2026-05-20" };
  assert.equal(shortfall([buy, later], "EEE"), null);
  // A back-dated sell must not leave a later sell uncovered.
  const laterFull = { date: "2026-05-20", seq: 3, side: "sell", ticker: "EEE", lots: 5, price: 1200, fee: 0 };
  const middle = { date: "2026-05-15", seq: 4, side: "sell", ticker: "EEE", lots: 1, price: 1100, fee: 0 };
  assert.equal(JSON.stringify(shortfall([buy, laterFull, middle], "EEE")), JSON.stringify({ date: "2026-05-20", available: 4 }));
});

test("journalMath counts uncovered lots so old gaps do not block new sells", () => {
  const { win } = loadModule("journal.js");
  const { shortfalls } = win.journalMath;
  const oldGap = { date: "2026-01-05", seq: 1, side: "sell", ticker: "FFF", lots: 2, price: 1000, fee: 0 };
  const buy = { date: "2026-02-01", seq: 2, side: "buy", ticker: "FFF", lots: 3, price: 1000, fee: 0 };
  const covered = { date: "2026-03-01", seq: 3, side: "sell", ticker: "FFF", lots: 3, price: 1200, fee: 0 };
  const tooMany = { ...covered, lots: 4 };
  assert.equal(shortfalls([oldGap, buy], "FFF").missing, 2);
  assert.equal(shortfalls([oldGap, buy, covered], "FFF").missing, 2);
  assert.equal(shortfalls([oldGap, buy, tooMany], "FFF").missing, 3);
});

/* ---------------- finance recurring schedule ---------------- */

test("financeMath clamps day 31 to the last day in short months", () => {
  const { win } = loadModule("finance.js");
  const m = win.financeMath;
  assert.equal(m.schedDate("2026-02", 31), "2026-02-28");  // non-leap February
  assert.equal(m.schedDate("2024-02", 31), "2024-02-29");  // leap February
  assert.equal(m.schedDate("2026-04", 31), "2026-04-30");  // 30-day month
  assert.equal(m.schedDate("2026-01", 31), "2026-01-31");  // 31-day month
});

test("financeMath catch-up posts every missed month with no duplicates", () => {
  const { win } = loadModule("finance.js");
  const m = win.financeMath;
  // Start Jan 2026, never posted, day 31, today in mid April 2026.
  const due = m.dueSchedule({ startYM: "2026-01", lastYM: "", day: 31 }, "2026-04-15");
  assert.deepEqual(Array.from(due, (d) => d.date), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  // April 31 clamps to 2026-04-30 which is after today 04-15, so it is not yet due.

  // Already posted through Feb: catch-up only March.
  const due2 = m.dueSchedule({ startYM: "2026-01", lastYM: "2026-02", day: 31 }, "2026-04-15");
  assert.deepEqual(Array.from(due2, (d) => d.date), ["2026-03-31"]);

  // Re-running after fully caught up yields nothing (no double posting on reload).
  const due3 = m.dueSchedule({ startYM: "2026-01", lastYM: "2026-03", day: 31 }, "2026-04-15");
  assert.equal(due3.length, 0);
});

test("financeMath day-31 recurring does not post current month until the clamped date arrives", () => {
  const { win } = loadModule("finance.js");
  const m = win.financeMath;
  // Today is 2026-02-27, day 31 -> clamped to 2026-02-28 which is still in the future.
  const due = m.dueSchedule({ startYM: "2026-02", lastYM: "", day: 31 }, "2026-02-27");
  assert.equal(due.length, 0);
  // On 2026-02-28 it becomes due.
  const due2 = m.dueSchedule({ startYM: "2026-02", lastYM: "", day: 31 }, "2026-02-28");
  assert.deepEqual(Array.from(due2, (d) => d.date), ["2026-02-28"]);
});
