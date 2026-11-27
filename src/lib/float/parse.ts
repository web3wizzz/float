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

function guide(text: string): string {
  const q = text.toLowerCase();
  if (/^(hi|hey|hello|yo|thanks|thank you)\b/.test(q)) {
    return "I’m here. Tell me who to pay, or ask how Float works.";
  }
  if (/\b(what is float|what's float|whats float|who are you|what do you do|what does float|about float|how does float)\b/.test(q) || q === "float" || q === "what is float?") {
    return "Float is a wallet for you and an agent. You deposit tUSD8 and set a limit. The agent can ask to pay. You approve. It never holds the keys.";
  }
  if (/\bphantom\b/.test(q)) {
    return "Phantom cannot add Aevum. Use MetaMask or Rabby, tap the wallet icon, and approve chain 44005.";
  }
  if (/\b(wallet|connect|metamask|rabby|rainbow|coinbase|trust wallet|okx|brave)\b/.test(q)) {
    return "Tap the wallet icon and pick a wallet. MetaMask and Rabby can add Aevum. After you’re connected, Send and Invoice turn on.";
  }
  if (/\binvoice\b/.test(q)) {
    return "An invoice holds tUSD8 until the work is confirmed. Use Invoice on the wallet, or say “pay Acme Studio 120 tUSD8 for invoice INV-0142” when one is open.";
  }
  if (/\b(schedule|recurring|every week|every day|repeat)\b/.test(q)) {
    return "Say “send 5 tUSD8 to DataRelay every week”. I’ll show a review card. It does not repeat until you approve.";
  }
  if (/\b(limit|cap|policy|allowlist|allow list|mandate)\b/.test(q)) {
    return "Each agent has a per-payment cap, a daily cap, and an allowlist. Acme Studio and DataRelay are allowed. Northwind is not. The vault refuses the rest.";
  }
  if (/\b(key|keys|safe|custody|hold the)\b/.test(q)) {
    return "I never hold the keys. I only prepare a payment. The vault checks the policy, and your wallet submits it.";
  }
  if (/\b(aevum|tusd8|chain|network|qday|gas)\b/.test(q)) {
    return "Float settles tUSD8 on Aevum, chain 44005. Gas is tQDAY. A payment on another chain does not count.";
  }
  if (/\b(how (do i|to) (send|pay)|send money|make a payment)\b/.test(q)) {
    return "Say “send 5 tUSD8 to DataRelay”. I’ll ask you to approve. Nothing moves before that.";
  }
  if (/\b(help|what can you|how do you work|what should i)\b/.test(q)) {
    return "I can send tUSD8, schedule a payment, check the balance, or explain a limit. Try “what’s my balance?” or “send 5 tUSD8 to DataRelay”.";
  }
  return "I can send tUSD8, schedule a payment, or explain Float. Try “send 5 tUSD8 to DataRelay”, or ask what a limit does.";
}

/**
 * The only natural-language path. Turns text into a typed intent.
 * Nothing here can move funds — the caller must submit the intent through
 * the same policy checks as the buttons. There is no model call.
 */
export function parseUtterance(text: string): { action?: AgentAction; error?: string } {
  const input = text.trim().replace(/\s+/g, " ");
  if (!input) return { error: "Say what you want to do." };
  const cleaned = input.replace(/^(please|can you|could you)\s+/i, "");

  if (/^(balance|vault balance|how much|what(?:'|’)s my balance)\b/i.test(cleaned) || /\b(my balance|the balance)\b/i.test(cleaned)) {
    return { action: actionSchema.parse({ type: "balance" }) };
  }
  if (/^pause\b/i.test(cleaned)) return { action: actionSchema.parse({ type: "pause" }) };
  if (/^revoke\b/i.test(cleaned)) return { action: actionSchema.parse({ type: "revoke" }) };
  if (/\b(oracle|market snapshot|x402)\b/i.test(cleaned) && /\b(buy|purchase|get|fetch)\b/i.test(cleaned)) {
    return { action: actionSchema.parse({ type: "x402", resource: "oracle" }) };
  }

  const schedule = cleaned.match(/^(?:send|pay|schedule)\s+(\d+)\s*(?:t?usd8)?\s+to\s+(.+?)\s+every\s+(.+)$/i);
  if (schedule) {
    const amount = amountOf(schedule[1]);
    const payee = resolvePayee(schedule[2]);
    const everyMs = everyToMs(schedule[3].replace(/\.$/, ""));
    if (!amount) return { error: "Amount must be a whole number of tUSD8." };
    if (!payee) return { error: `Unknown payee “${schedule[2]}”. Use Acme Studio, DataRelay, or Northwind.` };
    if (!everyMs) return { error: "Could not read the interval. Try “every week” or “every 7d”." };
    return { action: actionSchema.parse({ type: "schedule", payee: payee.address, amount, everyMs, maxRuns: everyMs >= 7 * 86400000 ? 12 : 24, memo: "recurring" }) };
  }

  const pay = cleaned.match(/^pay\s+(.+?)\s+(\d+)\s*(?:t?usd8)?(?:\s+for\s+invoice\s+(\S+))?$/i);
  if (pay) {
    const payee = resolvePayee(pay[1]);
    const amount = amountOf(pay[2]);
    if (!payee) return { error: `Unknown payee “${pay[1]}”. Use Acme Studio, DataRelay, or Northwind.` };
    if (!amount) return { error: "Amount must be a whole number of tUSD8." };
    return { action: actionSchema.parse({ type: "pay", payee: payee.address, amount, memo: pay[3] }) };
  }

  const send = cleaned.match(/^send\s+(\d+)\s*(?:t?usd8)?\s+to\s+(.+)$/i);
  if (send) {
    const amount = amountOf(send[1]);
    const payee = resolvePayee(send[2]);
    if (!amount) return { error: "Amount must be a whole number of tUSD8." };
    if (!payee) return { error: `Unknown payee “${send[2]}”. Use Acme Studio, DataRelay, or Northwind.` };
    return { action: actionSchema.parse({ type: "pay", payee: payee.address, amount }) };
  }

  return { error: guide(input) };
}

export function describeAction(action: AgentAction): string {
  switch (action.type) {
    case "pay":
      return `Send ${action.amount} tUSD8 to ${action.payee}${action.memo ? ` · ${action.memo}` : ""}.`;
    case "schedule":
      return `Send ${action.amount} tUSD8 to ${action.payee} every ${Math.round(action.everyMs / 3600000)}h, up to ${action.maxRuns} times.`;
    case "x402":
      return "Buy the DataRelay oracle with the agent’s mandate. The vault still enforces the limit.";
    case "pause":
      return "Pause the agent. Its spends stop until you resume it.";
    case "revoke":
      return "Revoke the agent. This is immediate.";
    case "balance":
      return "Show your balance, what is reserved, and what each agent has left today.";
  }
}
