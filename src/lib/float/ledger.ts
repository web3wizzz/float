import { DEFAULT_AGENT, DIRECTORY, labelOf } from "./directory.ts";

/** Sandbox clock uses millisecond timestamps. One bucket == one hour, 24 buckets == rolling day. */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const CONFIRM_WINDOW_MS = 3 * DAY_MS;
export const MIN_INTERVAL_MS = HOUR_MS;

export type InvoiceStatus = "open" | "funded" | "delivered" | "disputed" | "released" | "refunded";

export interface Bucket {
  hour: number;
  amount: number;
}

export interface Agent {
  address: string;
  label: string;
  perTxLimit: number;
  dailyLimit: number;
  /** Unix ms. 0 = no expiry. */
  expiry: number;
  allowAny: boolean;
  allow: string[];
  paused: boolean;
  active: boolean;
  buckets: Bucket[];
}

export interface Schedule {
  id: number;
  agent: string;
  payee: string;
  amount: number;
  intervalMs: number;
  nextRun: number;
  maxRuns: number;
  runs: number;
  active: boolean;
  memo: string;
  /** True when the agent opened it. Those reservations share one daily cap. */
  fromAgent?: boolean;
}

export interface Invoice {
  id: string;
  numericId: number;
  payee: string;
  amount: number;
  due: number;
  metadata: string;
  status: InvoiceStatus;
  fundedAt?: number;
  deliveredAt?: number;
}

export interface FeedItem {
  id: string;
  ts: number;
  ok: boolean;
  kind: "vault" | "policy" | "pay" | "blocked" | "escrow" | "schedule" | "x402";
  title: string;
  detail: string;
  /** "you" for the account holder, otherwise the agent label. */
  actor?: string;
}

export interface X402Resource {
  id: string;
  path: string;
  title: string;
  price: number;
  payTo: string;
  body: string;
  usedProofs: string[];
  purchases: { proof: string; ts: number; body: string }[];
}

export interface Ledger {
  balance: number;
  reserved: number;
  globalPaused: boolean;
  agents: Agent[];
  schedules: Schedule[];
  invoices: Invoice[];
  feed: FeedItem[];
  nextSchedule: number;
  nextFeed: number;
  offsetMs: number;
  x402: X402Resource[];
  /** Proofs that already unlocked a resource. */
  usedProofs: string[];
}

export interface Result {
  ledger: Ledger;
  ok: boolean;
  message: string;
  proof?: string;
}

const DUE_A = Date.parse("2026-12-01T00:00:00Z");
const DUE_B = Date.parse("2026-12-11T00:00:00Z");

export function freshLedger(): Ledger {
  return {
    balance: 0,
    reserved: 0,
    globalPaused: false,
    agents: [],
    schedules: [],
    invoices: [
      {
        id: "INV-0142",
        numericId: 1,
        payee: DIRECTORY[0].address,
        amount: 120,
        due: DUE_A,
        metadata: "Acme Studio — brand system",
        status: "open",
      },
      {
        id: "INV-0201",
        numericId: 2,
        payee: DIRECTORY[2].address,
        amount: 80,
        due: DUE_B,
        metadata: "Northwind — edge hosting",
        status: "open",
      },
    ],
    feed: [],
    nextSchedule: 1,
    nextFeed: 1,
    offsetMs: 0,
    usedProofs: [],
    x402: [
      {
        id: "oracle",
        path: "/v1/oracle",
        title: "DataRelay market snapshot",
        price: 25,
        payTo: DIRECTORY[1].address,
        body: "AEVUM mid 1.0001 tUSD8 · 24h volume 4.2M · funding +0.01%",
        usedProofs: [],
        purchases: [],
      },
    ],
  };
}

export function nowOf(ledger: Ledger, realNow = Date.now()): number {
  return realNow + ledger.offsetMs;
}

export function available(ledger: Ledger): number {
  return Math.max(0, ledger.balance - ledger.reserved);
}

export function hourIndex(ts: number): number {
  return Math.floor(ts / HOUR_MS);
}

export function spentInWindow(agent: Agent, now: number): number {
  const hour = hourIndex(now);
  return agent.buckets.reduce((sum, b) => (b.amount > 0 && hour < b.hour + 24 ? sum + b.amount : sum), 0);
}

function clone(ledger: Ledger): Ledger {
  return structuredClone(ledger);
}

function push(ledger: Ledger, now: number, item: Omit<FeedItem, "id" | "ts">): void {
  ledger.feed.unshift({ ...item, id: `f${ledger.nextFeed++}`, ts: now });
  ledger.feed = ledger.feed.slice(0, 40);
}

function findAgent(ledger: Ledger, address?: string): Agent | undefined {
  if (address) return ledger.agents.find((a) => a.address.toLowerCase() === address.toLowerCase() || a.label.toLowerCase() === address.toLowerCase());
  return ledger.agents.find((a) => a.active) ?? ledger.agents[0];
}

function addSpend(agent: Agent, amount: number, now: number): void {
  const hour = hourIndex(now);
  const kept = agent.buckets.filter((b) => hour < b.hour + 24 && b.hour !== hour);
  const prev = agent.buckets.find((b) => b.hour === hour);
  kept.push({ hour, amount: (prev && hour < prev.hour + 24 ? prev.amount : 0) + amount });
  agent.buckets = kept;
}

/** Policy gate shared by pay, escrow funding, schedules, and x402. */
export function explainPolicy(agent: Agent, payee: string, amount: number, now: number, globalPaused: boolean): string | null {
  if (globalPaused) return "Vault is paused.";
  if (!agent.active) return "Agent is revoked.";
  if (agent.paused) return "Agent is paused.";
  if (agent.expiry !== 0 && now > agent.expiry) return "Agent policy has expired.";
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) return "Amount must be a positive whole number of tUSD8.";
  if (amount > agent.perTxLimit) return `Per-transaction limit is ${agent.perTxLimit} tUSD8.`;
  const allowed = agent.allowAny || agent.allow.some((a) => a.toLowerCase() === payee.toLowerCase());
  if (!allowed) return `PayeeNotAllowed: ${labelOf(payee)} is not on the allowlist.`;
  const spent = spentInWindow(agent, now);
  if (spent + amount > agent.dailyLimit) {
    return `Daily limit. ${spent} spent in the rolling day, ${amount} requested, cap ${agent.dailyLimit}.`;
  }
  return null;
}

function ignoredScheduleReason(reason: string, byAgent: boolean): boolean {
  if (reason.startsWith("Daily limit.")) return true;
  if (!byAgent && (reason === "Vault is paused." || reason === "Agent is paused.")) return true;
  return false;
}

function outstandingAgentReserve(ledger: Ledger, agent: string): number {
  const who = agent.toLowerCase();
  return ledger.schedules.reduce((sum, schedule) => {
    if (!schedule.active || !schedule.fromAgent || schedule.agent.toLowerCase() !== who) return sum;
    return sum + schedule.amount * (schedule.maxRuns - schedule.runs);
  }, 0);
}

function fail(ledger: Ledger, now: number, kind: FeedItem["kind"], title: string, detail: string): Result {
  const next = clone(ledger);
  push(next, now, { ok: false, kind, title, detail });
  return { ledger: next, ok: false, message: detail };
}

export function deposit(ledger: Ledger, amount: number, now: number): Result {
  if (!Number.isInteger(amount) || amount <= 0) return fail(ledger, now, "blocked", "Deposit rejected", "Enter a positive whole number of tUSD8.");
  const next = clone(ledger);
  next.balance += amount;
  push(next, now, { ok: true, kind: "vault", title: `Deposited ${amount} tUSD8`, detail: `Vault balance ${next.balance}.` });
  return { ledger: next, ok: true, message: `Deposited ${amount} tUSD8.` };
}

export function withdraw(ledger: Ledger, amount: number, now: number): Result {
  if (!Number.isInteger(amount) || amount <= 0) return fail(ledger, now, "blocked", "Withdraw rejected", "Enter a positive whole number of tUSD8.");
  if (amount > ledger.balance || ledger.balance - amount < ledger.reserved) {
    return fail(ledger, now, "blocked", "Withdraw rejected", `That would cut into ${ledger.reserved} tUSD8 reserved for schedules.`);
  }
  const next = clone(ledger);
  next.balance -= amount;
  push(next, now, { ok: true, kind: "vault", title: `Withdrew ${amount} tUSD8`, detail: `Vault balance ${next.balance}.` });
  return { ledger: next, ok: true, message: `Withdrew ${amount} tUSD8.` };
}

/** A person paying from their own balance. No agent mandate is consulted. */
export function sendAsYou(
  ledger: Ledger,
  input: { payee: string; amount: number; memo: string; kind?: FeedItem["kind"]; fromReserve?: boolean; title?: string },
  now: number,
): Result {
  if (ledger.globalPaused) return fail(ledger, now, "blocked", "Vault is paused", "Resume the vault before sending.");
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return fail(ledger, now, "blocked", "Send rejected", "Enter a positive whole number of tUSD8.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.payee)) return fail(ledger, now, "blocked", "Send rejected", "Recipient must be an address.");
  const next = clone(ledger);
  if (input.fromReserve) {
    if (next.reserved < input.amount) return fail(ledger, now, "blocked", "Reserve short", "Schedule reserve is smaller than this run.");
    next.reserved -= input.amount;
  } else if (input.amount > available(next)) {
    return fail(ledger, now, "blocked", "Not enough to send", `${available(next)} tUSD8 is free. ${next.reserved} is reserved for schedules.`);
  }
  next.balance -= input.amount;
  const title = input.title ?? `Sent ${input.amount} tUSD8 to ${labelOf(input.payee)}`;
  push(next, now, { ok: true, kind: input.kind ?? "pay", title, detail: input.memo || "No memo.", actor: "you" });
  return { ledger: next, ok: true, message: title };
}

export function registerAgent(
  ledger: Ledger,
  input: { address?: string; label?: string; perTxLimit: number; dailyLimit: number; allow: string[]; allowAny?: boolean; expiry?: number },
  now: number,
): Result {
  const address = input.address || DEFAULT_AGENT.address;
  const label = input.label || DEFAULT_AGENT.label;
  if (!Number.isInteger(input.perTxLimit) || !Number.isInteger(input.dailyLimit) || input.perTxLimit <= 0 || input.dailyLimit <= 0) {
    return fail(ledger, now, "blocked", "Policy rejected", "Limits must be positive whole numbers.");
  }
  if (input.perTxLimit > input.dailyLimit) return fail(ledger, now, "blocked", "Policy rejected", "Per-transaction limit cannot exceed the daily limit.");
  const next = clone(ledger);
  const existing = next.agents.findIndex((a) => a.address.toLowerCase() === address.toLowerCase());
  const agent: Agent = {
    address,
    label,
    perTxLimit: input.perTxLimit,
    dailyLimit: input.dailyLimit,
    expiry: input.expiry ?? 0,
    allowAny: Boolean(input.allowAny),
    allow: input.allow,
    paused: false,
    active: true,
    buckets: [],
  };
  if (existing >= 0) next.agents[existing] = agent;
  else next.agents.push(agent);
  push(next, now, {
    ok: true,
    kind: "policy",
    title: `Approved ${label}`,
    detail: `${input.perTxLimit} per tx · ${input.dailyLimit} rolling day · ${input.allowAny ? "any payee" : `${input.allow.length} allowed`}.`,
  });
  return { ledger: next, ok: true, message: `Approved ${label}.` };
}

export function setPaused(ledger: Ledger, paused: boolean, now: number, agentId?: string): Result {
  const next = clone(ledger);
  const agent = findAgent(next, agentId);
  if (!agent || !agent.active) return fail(ledger, now, "blocked", "No active agent", "Approve an agent first.");
  agent.paused = paused;
  push(next, now, { ok: true, kind: "policy", title: paused ? `Paused ${agent.label}` : `Resumed ${agent.label}`, detail: paused ? "Spends are blocked until you resume." : "Spends are allowed again." });
  return { ledger: next, ok: true, message: paused ? "Agent paused." : "Agent resumed." };
}

export function setGlobalPaused(ledger: Ledger, paused: boolean, now: number): Result {
  const next = clone(ledger);
  next.globalPaused = paused;
  push(next, now, { ok: true, kind: "policy", title: paused ? "Vault paused" : "Vault resumed", detail: "Owner can still withdraw." });
  return { ledger: next, ok: true, message: paused ? "Vault paused." : "Vault resumed." };
}

export function revokeAgent(ledger: Ledger, now: number, agentId?: string): Result {
  const next = clone(ledger);
  const agent = findAgent(next, agentId);
  if (!agent || !agent.active) return fail(ledger, now, "blocked", "Nothing to revoke", "That agent is not active.");
  agent.active = false;
  agent.paused = true;
  push(next, now, { ok: false, kind: "policy", title: `Revoked ${agent.label}`, detail: "Further payments from this agent are rejected." });
  return { ledger: next, ok: true, message: `Revoked ${agent.label}.` };
}

export function advance(ledger: Ledger, ms: number): Ledger {
  const next = clone(ledger);
  next.offsetMs += ms;
  return next;
}

export interface PayInput {
  agent?: string;
  payee: string;
  amount: number;
  memo: string;
  kind?: FeedItem["kind"];
  fromReserve?: boolean;
  title?: string;
}

export function pay(ledger: Ledger, input: PayInput, now: number): Result {
  const next = clone(ledger);
  const agent = findAgent(next, input.agent);
  if (!agent) return fail(ledger, now, "blocked", "No agent", "Approve an agent before it can pay.");
  const reason = explainPolicy(agent, input.payee, input.amount, now, next.globalPaused);
  if (reason) return fail(ledger, now, "blocked", `Blocked · ${input.amount} tUSD8 to ${labelOf(input.payee)}`, reason);
  if (input.fromReserve) {
    if (next.reserved < input.amount) return fail(ledger, now, "blocked", "Reserve short", "Schedule reserve is smaller than this run.");
    next.reserved -= input.amount;
  } else if (input.amount > available(next)) {
    return fail(ledger, now, "blocked", "Insufficient available balance", `${available(next)} tUSD8 is free. ${next.reserved} is reserved for schedules.`);
  }
  addSpend(agent, input.amount, now);
  next.balance -= input.amount;
  const title = input.title ?? `Paid ${input.amount} tUSD8 to ${labelOf(input.payee)}`;
  push(next, now, { ok: true, kind: input.kind ?? "pay", title, detail: input.memo || "No memo." });
  return { ledger: next, ok: true, message: title };
}

export function createSchedule(
  ledger: Ledger,
  input: { agent?: string; payee: string; amount: number; intervalMs: number; maxRuns: number; memo: string; byAgent?: boolean; byYou?: boolean },
  now: number,
): Result {
  const next = clone(ledger);
  if (input.byYou) {
    if (next.globalPaused) return fail(ledger, now, "blocked", "Vault is paused", "Resume the vault before scheduling.");
    if (!Number.isInteger(input.amount) || input.amount <= 0) return fail(ledger, now, "blocked", "Schedule rejected", "Enter a positive whole number of tUSD8.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.payee)) return fail(ledger, now, "blocked", "Schedule rejected", "Recipient must be an address.");
    if (!Number.isInteger(input.maxRuns) || input.maxRuns <= 0) return fail(ledger, now, "blocked", "Schedule rejected", "Set a max number of runs.");
    if (input.intervalMs < MIN_INTERVAL_MS) return fail(ledger, now, "blocked", "Schedule rejected", "Minimum interval is 1 hour.");
    const obligation = input.amount * input.maxRuns;
    if (obligation > available(next)) return fail(ledger, now, "blocked", "Schedule rejected", "Vault balance cannot cover the reserved runs.");
    next.reserved += obligation;
    const id = next.nextSchedule++;
    next.schedules.push({
      id,
      agent: "",
      payee: input.payee,
      amount: input.amount,
      intervalMs: input.intervalMs,
      nextRun: now,
      maxRuns: input.maxRuns,
      runs: 0,
      active: true,
      memo: input.memo,
    });
    push(next, now, {
      ok: true,
      kind: "schedule",
      title: `Schedule #${id} · ${input.amount} tUSD8`,
      detail: `${labelOf(input.payee)} · every ${Math.round(input.intervalMs / HOUR_MS)}h · ${input.maxRuns} runs · ${obligation} reserved.`,
      actor: "you",
    });
    return { ledger: next, ok: true, message: `Schedule #${id} created.` };
  }
  const agent = findAgent(next, input.agent);
  if (!agent || !agent.active) return fail(ledger, now, "blocked", "Schedule rejected", "No active agent.");
  const byAgent = input.byAgent === true;
  const reason = explainPolicy(agent, input.payee, input.amount, now, next.globalPaused);
  if (reason && !ignoredScheduleReason(reason, byAgent)) return fail(ledger, now, "blocked", "Schedule rejected", reason);
  if (input.amount > agent.perTxLimit) return fail(ledger, now, "blocked", "Schedule rejected", `Per-transaction limit is ${agent.perTxLimit}.`);
  if (!Number.isInteger(input.maxRuns) || input.maxRuns <= 0) return fail(ledger, now, "blocked", "Schedule rejected", "Set a max number of runs.");
  if (input.intervalMs < MIN_INTERVAL_MS) return fail(ledger, now, "blocked", "Schedule rejected", "Minimum interval is 1 hour.");
  const obligation = input.amount * input.maxRuns;
  if (byAgent && outstandingAgentReserve(next, agent.address) + obligation > agent.dailyLimit) {
    return fail(ledger, now, "blocked", "Schedule rejected", "An agent cannot reserve more than its daily limit.");
  }
  if (obligation > next.balance || next.reserved > next.balance - obligation) {
    return fail(ledger, now, "blocked", "Schedule rejected", "Vault balance cannot cover the reserved runs.");
  }
  next.reserved += obligation;
  const id = next.nextSchedule++;
  next.schedules.push({
    id,
    agent: agent.address,
    payee: input.payee,
    amount: input.amount,
    intervalMs: input.intervalMs,
    nextRun: now,
    maxRuns: input.maxRuns,
    runs: 0,
    active: true,
    memo: input.memo,
    fromAgent: byAgent,
  });
  push(next, now, {
    ok: true,
    kind: "schedule",
    title: `Schedule #${id} · ${input.amount} tUSD8`,
    detail: `${labelOf(input.payee)} · every ${Math.round(input.intervalMs / HOUR_MS)}h · ${input.maxRuns} runs · ${obligation} reserved.`,
  });
  return { ledger: next, ok: true, message: `Schedule #${id} created.` };
}

export function executeSchedule(ledger: Ledger, id: number, now: number): Result {
  const peek = ledger.schedules.find((s) => s.id === id);
  if (!peek) return fail(ledger, now, "blocked", "Unknown schedule", "That schedule does not exist.");
  if (!peek.active) return fail(ledger, now, "blocked", "Schedule inactive", "It is cancelled or finished.");
  if (peek.runs >= peek.maxRuns) return fail(ledger, now, "blocked", "Schedule finished", "Max runs reached.");
  if (now < peek.nextRun) {
    return fail(ledger, now, "blocked", "Not due", "This run was already executed. Missed intervals are not charged twice.");
  }
  const paid = peek.agent
    ? pay(ledger, { agent: peek.agent, payee: peek.payee, amount: peek.amount, memo: peek.memo || `schedule #${id}`, kind: "schedule", fromReserve: true }, now)
    : sendAsYou(ledger, { payee: peek.payee, amount: peek.amount, memo: peek.memo || `schedule #${id}`, kind: "schedule", fromReserve: true, title: `Sent ${peek.amount} tUSD8 to ${labelOf(peek.payee)}` }, now);
  if (!paid.ok) return paid;
  const next = paid.ledger;
  const schedule = next.schedules.find((s) => s.id === id)!;
  schedule.runs += 1;
  schedule.nextRun = now + schedule.intervalMs;
  if (schedule.runs >= schedule.maxRuns) schedule.active = false;
  return { ledger: next, ok: true, message: `Schedule #${id} ran (${schedule.runs}/${schedule.maxRuns}). Next run is one interval after now, not one per missed period.` };
}

export function cancelSchedule(ledger: Ledger, id: number, now: number): Result {
  const next = clone(ledger);
  const schedule = next.schedules.find((s) => s.id === id);
  if (!schedule || !schedule.active) return fail(ledger, now, "blocked", "Schedule inactive", "Nothing to cancel.");
  const remaining = schedule.amount * (schedule.maxRuns - schedule.runs);
  schedule.active = false;
  next.reserved -= remaining;
  push(next, now, { ok: true, kind: "schedule", title: `Cancelled schedule #${id}`, detail: `Released ${remaining} tUSD8 of reserve.` });
  return { ledger: next, ok: true, message: `Cancelled schedule #${id}.` };
}

export function fundInvoice(ledger: Ledger, invoiceId: string, now: number, agentId?: string): Result {
  const invoice = ledger.invoices.find((i) => i.id.toLowerCase() === invoiceId.toLowerCase() || String(i.numericId) === invoiceId);
  if (!invoice) return fail(ledger, now, "blocked", "Unknown invoice", invoiceId);
  if (invoice.status !== "open") return fail(ledger, now, "blocked", "Invoice not open", `${invoice.id} is ${invoice.status}.`);
  if (now >= invoice.due) return fail(ledger, now, "blocked", "Invoice past due", "The due date has passed, so this invoice cannot be funded.");
  const asYou = agentId === "you";
  const paid = asYou
    ? sendAsYou(ledger, { payee: invoice.payee, amount: invoice.amount, memo: invoice.id, kind: "escrow", title: `Escrow hold · ${invoice.amount} tUSD8 for ${invoice.id}` }, now)
    : pay(ledger, { agent: agentId, payee: invoice.payee, amount: invoice.amount, memo: invoice.id, kind: "escrow", title: `Escrow hold · ${invoice.amount} tUSD8 for ${invoice.id}` }, now);
  if (!paid.ok) return paid;
  const next = paid.ledger;
  const inv = next.invoices.find((i) => i.id === invoice.id)!;
  inv.status = "funded";
  inv.fundedAt = now;
  push(next, now, { ok: true, kind: "escrow", title: `Escrow funded · ${inv.id}`, detail: `${inv.amount} tUSD8 held until delivery is confirmed.` });
  return { ledger: next, ok: true, message: `${inv.id} funded into escrow.` };
}

export function markDelivered(ledger: Ledger, invoiceId: string, now: number): Result {
  const next = clone(ledger);
  const inv = next.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== "funded") return fail(ledger, now, "blocked", "Cannot mark delivered", "Invoice must be funded first.");
  if (now >= inv.due) return fail(ledger, now, "blocked", "Due date passed", "Delivery after the due date cannot block a refund.");
  inv.status = "delivered";
  inv.deliveredAt = now;
  push(next, now, { ok: true, kind: "escrow", title: `${inv.id} marked delivered`, detail: "Payer can confirm, or it auto-releases after 3 days." });
  return { ledger: next, ok: true, message: `${inv.id} marked delivered.` };
}

export function confirmInvoice(ledger: Ledger, invoiceId: string, now: number): Result {
  const next = clone(ledger);
  const inv = next.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== "delivered") return fail(ledger, now, "blocked", "Cannot release", "Delivery has to be marked first.");
  inv.status = "released";
  push(next, now, { ok: true, kind: "escrow", title: `Released ${inv.id}`, detail: `${inv.amount} tUSD8 sent to ${labelOf(inv.payee)}.` });
  return { ledger: next, ok: true, message: `${inv.id} released.` };
}

export function refundInvoice(ledger: Ledger, invoiceId: string, now: number): Result {
  const next = clone(ledger);
  const inv = next.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== "funded") return fail(ledger, now, "blocked", "Cannot refund", "Only a funded, undelivered invoice can be refunded.");
  if (now < inv.due) return fail(ledger, now, "blocked", "Too early", "Refund opens at the due date if nothing was delivered.");
  inv.status = "refunded";
  next.balance += inv.amount;
  push(next, now, { ok: true, kind: "escrow", title: `Refunded ${inv.id}`, detail: `${inv.amount} tUSD8 returned to the vault.` });
  return { ledger: next, ok: true, message: `${inv.id} refunded.` };
}

export function openInvoice(
  ledger: Ledger,
  input: { id: string; payee: string; amount: number; metadata: string; due?: number },
  now: number,
): Result {
  const id = input.id.trim();
  if (!id) return fail(ledger, now, "blocked", "Invoice rejected", "Give the invoice an id.");
  if (ledger.invoices.some((item) => item.id.toLowerCase() === id.toLowerCase())) {
    return fail(ledger, now, "blocked", "Invoice rejected", `${id} already exists.`);
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) return fail(ledger, now, "blocked", "Invoice rejected", "Amount must be a positive whole number of tUSD8.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.payee)) return fail(ledger, now, "blocked", "Invoice rejected", "Payee must be an address.");
  const next = clone(ledger);
  const numericId = next.invoices.reduce((max, item) => Math.max(max, item.numericId), 0) + 1;
  next.invoices.unshift({
    id,
    numericId,
    payee: input.payee,
    amount: input.amount,
    due: input.due ?? now + 14 * DAY_MS,
    metadata: input.metadata.trim() || "Payment request",
    status: "open",
  });
  push(next, now, {
    ok: true,
    kind: "escrow",
    title: `Invoice ${id}`,
    detail: `${input.amount} tUSD8 to ${labelOf(input.payee)}.`,
    actor: "you",
  });
  return { ledger: next, ok: true, message: `${id} is open.` };
}

export function disputeInvoice(ledger: Ledger, invoiceId: string, now: number): Result {
  const next = clone(ledger);
  const inv = next.invoices.find((i) => i.id === invoiceId);
  if (!inv || (inv.status !== "funded" && inv.status !== "delivered")) return fail(ledger, now, "blocked", "Cannot dispute", "Nothing in flight to dispute.");
  inv.status = "disputed";
  push(next, now, { ok: false, kind: "escrow", title: `${inv.id} disputed`, detail: "Only the arbiter can resolve this." });
  return { ledger: next, ok: true, message: `${inv.id} flagged for the arbiter.` };
}

export function resolveInvoice(ledger: Ledger, invoiceId: string, releaseToPayee: boolean, now: number): Result {
  const next = clone(ledger);
  const inv = next.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== "disputed") return fail(ledger, now, "blocked", "Not disputed", "The arbiter only resolves disputed invoices.");
  if (releaseToPayee) {
    inv.status = "released";
    push(next, now, { ok: true, kind: "escrow", title: `Arbiter released ${inv.id}`, detail: `${inv.amount} tUSD8 to ${labelOf(inv.payee)}.` });
  } else {
    inv.status = "refunded";
    next.balance += inv.amount;
    push(next, now, { ok: true, kind: "escrow", title: `Arbiter refunded ${inv.id}`, detail: `${inv.amount} tUSD8 back to the vault.` });
  }
  return { ledger: next, ok: true, message: releaseToPayee ? "Released to payee." : "Refunded to vault." };
}

export function proofFor(feedId: string): string {
  return `0xpay${feedId}`;
}

export function buyX402(ledger: Ledger, resourceId: string, now: number): Result {
  const resource = ledger.x402.find((r) => r.id === resourceId);
  if (!resource) return fail(ledger, now, "blocked", "Unknown resource", resourceId);
  const paid = pay(ledger, { payee: resource.payTo, amount: resource.price, memo: resource.path, kind: "x402" }, now);
  if (!paid.ok) return { ...paid, message: `402 accepted, payment blocked. ${paid.message}` };
  const next = paid.ledger;
  const res = next.x402.find((r) => r.id === resourceId)!;
  const feedId = next.feed[0]?.id ?? "x";
  const proof = proofFor(feedId);
  res.usedProofs.push(proof);
  res.purchases.unshift({ proof, ts: now, body: res.body });
  next.usedProofs.push(proof);
  push(next, now, { ok: true, kind: "x402", title: `x402 · ${res.title}`, detail: `Proof ${proof} unlocked the response. One proof, one use.` });
  return { ledger: next, ok: true, message: res.body, proof };
}

export function replayProof(ledger: Ledger, proof: string, now: number): Result {
  if (!ledger.usedProofs.includes(proof)) return fail(ledger, now, "blocked", "Unknown proof", "The resource server has no record of that payment.");
  return fail(ledger, now, "blocked", "Replay rejected", `Proof ${proof} was already used. A second request cannot spend it again.`);
}
