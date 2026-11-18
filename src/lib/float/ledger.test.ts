import assert from "node:assert/strict";
import test from "node:test";
import { DIRECTORY } from "./directory.ts";
import {
  HOUR_MS,
  available,
  buyX402,
  cancelSchedule,
  confirmInvoice,
  createSchedule,
  deposit,
  executeSchedule,
  freshLedger,
  fundInvoice,
  markDelivered,
  pay,
  registerAgent,
  replayProof,
  refundInvoice,
  revokeAgent,
  setGlobalPaused,
  setPaused,
  spentInWindow,
  withdraw,
} from "./ledger.ts";
import { parseUtterance } from "./parse.ts";

const T0 = Date.parse("2026-11-17T12:00:00Z");
const acme = DIRECTORY[0].address;
const relay = DIRECTORY[1].address;

function funded() {
  const d = deposit(freshLedger(), 1000, T0);
  const r = registerAgent(d.ledger, { perTxLimit: 150, dailyLimit: 400, allow: [acme, relay] }, T0);
  assert.equal(r.ok, true);
  return r.ledger;
}

test("pays inside policy and blocks per-tx, allowlist, and daily", () => {
  let ledger = funded();
  const ok = pay(ledger, { payee: acme, amount: 120, memo: "INV-0142" }, T0);
  assert.equal(ok.ok, true);
  assert.equal(ok.ledger.balance, 880);
  ledger = ok.ledger;
  const over = pay(ledger, { payee: acme, amount: 180, memo: "too big" }, T0);
  assert.equal(over.ok, false);
  assert.match(over.message, /Per-transaction/);
  assert.equal(over.ledger.balance, 880);
  const stranger = pay(ledger, { payee: DIRECTORY[2].address, amount: 10, memo: "nope" }, T0);
  assert.equal(stranger.ok, false);
  const more = pay(ledger, { payee: acme, amount: 150, memo: "a" }, T0);
  ledger = more.ledger;
  const more2 = pay(ledger, { payee: acme, amount: 150, memo: "b" }, T0);
  assert.equal(more2.ok, false);
  assert.match(more2.message, /Daily/);
  assert.equal(spentInWindow(more.ledger.agents[0], T0), 270);
});

test("rolling window drops spend after 24 hours", () => {
  let ledger = funded();
  ledger = pay(ledger, { payee: acme, amount: 150, memo: "h" }, T0).ledger;
  const later = T0 + 24 * HOUR_MS;
  assert.equal(spentInWindow(ledger.agents[0], later), 0);
  const again = pay(ledger, { payee: acme, amount: 150, memo: "next" }, later);
  assert.equal(again.ok, true);
});

test("missed schedule intervals charge once", () => {
  let ledger = funded();
  const created = createSchedule(ledger, { payee: acme, amount: 50, intervalMs: HOUR_MS, maxRuns: 5, memo: "rent" }, T0);
  assert.equal(created.ok, true);
  ledger = created.ledger;
  assert.equal(ledger.reserved, 250);
  const late = T0 + 10 * HOUR_MS;
  const first = executeSchedule(ledger, 1, late);
  assert.equal(first.ok, true);
  ledger = first.ledger;
  assert.equal(ledger.balance, 950);
  assert.equal(ledger.schedules[0].runs, 1);
  const twice = executeSchedule(ledger, 1, late);
  assert.equal(twice.ok, false);
  assert.match(twice.message, /already executed|Not due/i);
  assert.equal(twice.ledger.balance, 950);
  const next = executeSchedule(ledger, 1, late + HOUR_MS);
  assert.equal(next.ok, true);
  assert.equal(next.ledger.schedules[0].runs, 2);
});

test("withdraw cannot eat schedule reserve", () => {
  let ledger = funded();
  ledger = createSchedule(ledger, { payee: acme, amount: 100, intervalMs: HOUR_MS, maxRuns: 2, memo: "r" }, T0).ledger;
  const bad = withdraw(ledger, 900, T0);
  assert.equal(bad.ok, false);
  const ok = withdraw(ledger, 800, T0);
  assert.equal(ok.ok, true);
  assert.equal(available(ok.ledger), 0);
  assert.equal(ok.ledger.balance, 200);
});

test("cancel releases reserve", () => {
  let ledger = funded();
  ledger = createSchedule(ledger, { payee: acme, amount: 40, intervalMs: HOUR_MS, maxRuns: 3, memo: "r" }, T0).ledger;
  ledger = cancelSchedule(ledger, 1, T0).ledger;
  assert.equal(ledger.reserved, 0);
  assert.equal(ledger.schedules[0].active, false);
});

test("escrow fund, deliver, release", () => {
  let ledger = funded();
  ledger = fundInvoice(ledger, "INV-0142", T0).ledger;
  assert.equal(ledger.invoices[0].status, "funded");
  assert.equal(ledger.balance, 880);
  ledger = markDelivered(ledger, "INV-0142", T0).ledger;
  ledger = confirmInvoice(ledger, "INV-0142", T0).ledger;
  assert.equal(ledger.invoices[0].status, "released");
  assert.equal(ledger.balance, 880);
});

test("northwind invoice is blocked by the allowlist", () => {
  const ledger = funded();
  const blocked = fundInvoice(ledger, "INV-0201", T0);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /allowlist/);
});

test("x402 proof is single use", () => {
  let ledger = funded();
  const bought = buyX402(ledger, "oracle", T0);
  assert.equal(bought.ok, true);
  assert.ok(bought.proof);
  ledger = bought.ledger;
  assert.equal(ledger.balance, 975);
  const replay = replayProof(ledger, bought.proof!, T0);
  assert.equal(replay.ok, false);
  assert.match(replay.message, /already used/);
  assert.equal(replay.ledger.balance, 975);
});

test("revoked agent cannot pay", () => {
  let ledger = funded();
  ledger = revokeAgent(ledger, T0).ledger;
  const after = pay(ledger, { payee: acme, amount: 10, memo: "no" }, T0);
  assert.equal(after.ok, false);
  assert.match(after.message, /revoked/);
});

test("agent schedules share one daily reserve", () => {
  let ledger = funded();
  const first = createSchedule(ledger, { payee: acme, amount: 100, intervalMs: HOUR_MS, maxRuns: 2, memo: "a", byAgent: true }, T0);
  assert.equal(first.ok, true);
  ledger = first.ledger;
  const second = createSchedule(ledger, { payee: acme, amount: 100, intervalMs: HOUR_MS, maxRuns: 2, memo: "b", byAgent: true }, T0);
  assert.equal(second.ok, true);
  const third = createSchedule(second.ledger, { payee: acme, amount: 50, intervalMs: HOUR_MS, maxRuns: 1, memo: "c", byAgent: true }, T0);
  assert.equal(third.ok, false);
  assert.match(third.message, /daily limit/i);
  const owner = createSchedule(second.ledger, { payee: acme, amount: 100, intervalMs: HOUR_MS, maxRuns: 4, memo: "o" }, T0);
  assert.equal(owner.ok, true);
  const ran = executeSchedule(second.ledger, 1, T0);
  assert.equal(ran.ok, true);
  const freed = createSchedule(ran.ledger, { payee: acme, amount: 100, intervalMs: HOUR_MS, maxRuns: 1, memo: "d", byAgent: true }, T0);
  assert.equal(freed.ok, true);
});

test("paused or globally paused agent cannot open a schedule", () => {
  let ledger = funded();
  ledger = setPaused(ledger, true, T0).ledger;
  const paused = createSchedule(ledger, { payee: acme, amount: 10, intervalMs: HOUR_MS, maxRuns: 1, memo: "a", byAgent: true }, T0);
  assert.equal(paused.ok, false);
  const owner = createSchedule(ledger, { payee: acme, amount: 10, intervalMs: HOUR_MS, maxRuns: 1, memo: "a" }, T0);
  assert.equal(owner.ok, true);
  ledger = setPaused(funded(), false, T0).ledger;
  ledger = setGlobalPaused(ledger, true, T0).ledger;
  const global = createSchedule(ledger, { payee: acme, amount: 10, intervalMs: HOUR_MS, maxRuns: 1, memo: "a", byAgent: true }, T0);
  assert.equal(global.ok, false);
});

test("delivery after the due date cannot block a refund", () => {
  let ledger = funded();
  ledger = fundInvoice(ledger, "INV-0142", T0).ledger;
  const late = Date.parse("2026-12-02T00:00:00Z");
  const delivered = markDelivered(ledger, "INV-0142", late);
  assert.equal(delivered.ok, false);
  assert.match(delivered.message, /due date/i);
  const refunded = refundInvoice(ledger, "INV-0142", late);
  assert.equal(refunded.ok, true);
  assert.equal(refunded.ledger.balance, 1000);
  const fundedLate = fundInvoice(funded(), "INV-0142", late);
  assert.equal(fundedLate.ok, false);
});

test("parser emits schema-valid actions", () => {
  const payAction = parseUtterance("pay Acme Studio 120 tUSD8 for invoice INV-0142");
  assert.equal(payAction.action?.type, "pay");
  if (payAction.action?.type === "pay") {
    assert.equal(payAction.action.amount, 120);
    assert.equal(payAction.action.memo, "INV-0142");
    assert.equal(payAction.action.payee, acme);
  }
  const weekly = parseUtterance("send 5 tUSD8 to DataRelay every week");
  assert.equal(weekly.action?.type, "schedule");
  if (weekly.action?.type === "schedule") assert.equal(weekly.action.everyMs, 7 * 86400000);
  assert.equal(parseUtterance("buy the oracle").action?.type, "x402");
  assert.ok(parseUtterance("wire something vague").error);
});
