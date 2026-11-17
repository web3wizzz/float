import { z } from "zod";
import { resolvePayee } from "./directory.ts";

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pay"),
    payee: z.string().min(1),
    amount: z.number().int().positive(),
    memo: z.string().optional(),
  }),
  z.object({
    type: z.literal("schedule"),
    payee: z.string().min(1),
    amount: z.number().int().positive(),
    everyMs: z.number().int().positive(),
    maxRuns: z.number().int().positive(),
    memo: z.string().optional(),
  }),
  z.object({ type: z.literal("x402"), resource: z.string().min(1) }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("revoke") }),
  z.object({ type: z.literal("balance") }),
]);

export type AgentAction = z.infer<typeof actionSchema>;

function everyToMs(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (["week", "weekly", "7d", "a week"].includes(t)) return 7 * 86400000;
  if (["day", "daily", "1d", "a day"].includes(t)) return 86400000;
  if (["hour", "hourly", "1h"].includes(t)) return 3600000;
  const m = t.match(/^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit.startsWith("h")) return n * 3600000;
  if (unit.startsWith("d")) return n * 86400000;
  return n * 7 * 86400000;
}

function amountOf(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The only natural-language path. Turns text into a typed intent.
 * Nothing here can move funds — the caller must submit the intent through
 * the same policy checks as the buttons. There is no model call.
 */
export function parseUtterance(text: string): { action?: AgentAction; error?: string } {
  const input = text.trim().replace(/\s+/g, " ");
  if (!input) return { error: "Say what the agent should do." };

  if (/^(balance|vault balance|how much is in the vault)\b/i.test(input)) {
    return { action: actionSchema.parse({ type: "balance" }) };
  }
  if (/^pause\b/i.test(input)) return { action: actionSchema.parse({ type: "pause" }) };
  if (/^revoke\b/i.test(input)) return { action: actionSchema.parse({ type: "revoke" }) };
  if (/\b(oracle|market snapshot|x402)\b/i.test(input) && /\b(buy|purchase|get|fetch)\b/i.test(input)) {
    return { action: actionSchema.parse({ type: "x402", resource: "oracle" }) };
  }

  const schedule = input.match(/^(?:send|pay|schedule)\s+(\d+)\s*t?usd8?\s+to\s+(.+?)\s+every\s+(.+)$/i);
  if (schedule) {
    const amount = amountOf(schedule[1]);
    const payee = resolvePayee(schedule[2]);
    const everyMs = everyToMs(schedule[3].replace(/\.$/, ""));
    if (!amount) return { error: "Amount must be a whole number of tUSD8." };
    if (!payee) return { error: `Unknown payee “${schedule[2]}”. Use Acme Studio, DataRelay, or Northwind.` };
    if (!everyMs) return { error: "Could not read the interval. Try “every week” or “every 7d”." };
    return { action: actionSchema.parse({ type: "schedule", payee: payee.address, amount, everyMs, maxRuns: everyMs >= 7 * 86400000 ? 12 : 24, memo: "recurring" }) };
  }

  const pay = input.match(/^pay\s+(.+?)\s+(\d+)\s*t?usd8?(?:\s+for\s+invoice\s+(\S+))?$/i);
  if (pay) {
    const payee = resolvePayee(pay[1]);
    const amount = amountOf(pay[2]);
    if (!payee) return { error: `Unknown payee “${pay[1]}”.` };
    if (!amount) return { error: "Amount must be a whole number of tUSD8." };
    return { action: actionSchema.parse({ type: "pay", payee: payee.address, amount, memo: pay[3] }) };
  }

  const send = input.match(/^send\s+(\d+)\s*t?usd8?\s+to\s+(.+)$/i);
  if (send) {
    const amount = amountOf(send[1]);
    const payee = resolvePayee(send[2]);
    if (!amount) return { error: "Amount must be a whole number of tUSD8." };
    if (!payee) return { error: `Unknown payee “${send[2]}”.` };
    return { action: actionSchema.parse({ type: "pay", payee: payee.address, amount }) };
  }

  return { error: "Could not read that. Try “pay Acme Studio 120 tUSD8 for invoice INV-0142”." };
}

export function describeAction(action: AgentAction): string {
  switch (action.type) {
    case "pay":
      return `Pay ${action.amount} tUSD8 to ${action.payee}${action.memo ? ` · ${action.memo}` : ""}. The vault still enforces limits.`;
    case "schedule":
      return `Schedule ${action.amount} tUSD8 to ${action.payee} every ${Math.round(action.everyMs / 3600000)}h, up to ${action.maxRuns} runs.`;
    case "x402":
      return "Buy the DataRelay oracle. The agent pays the 402 price only if policy allows it.";
    case "pause":
      return "Pause the active agent. In-flight schedules will fail the policy check until you resume.";
    case "revoke":
      return "Revoke the active agent. This is immediate.";
    case "balance":
      return "Show vault balance, reserve, and what the agent has left today.";
  }
}
