import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { available, pay, spentInWindow, type Ledger } from "../../src/lib/float/ledger.ts";
import { resolvePayee } from "../../src/lib/float/directory.ts";

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const tools = [
  {
    name: "float_balance",
    description: "Vault balance, free balance, and reserve in the sandbox ledger.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "float_policy",
    description: "Active agent limits and remaining rolling-day budget.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "float_pay",
    description: "Pay a directory payee if policy allows. The contract rules still apply.",
    inputSchema: {
      type: "object",
      properties: {
        payee: { type: "string" },
        amount: { type: "integer" },
        memo: { type: "string" },
      },
      required: ["payee", "amount"],
    },
  },
];

export async function serveMcp(ctx: { readLedger: () => Ledger; writeLedger: (ledger: Ledger) => void }) {
  const rl = createInterface({ input: stdin, terminal: false });
  const send = (msg: unknown) => stdout.write(`${JSON.stringify(msg)}\n`);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: Rpc;
    try {
      req = JSON.parse(line) as Rpc;
    } catch {
      continue;
    }
    const id = req.id ?? null;
    if (req.method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "float", version: "0.1.0" } } });
      continue;
    }
    if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
      continue;
    }
    if (req.method === "tools/call") {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      const ledger = ctx.readLedger();
      if (name === "float_balance") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ balance: ledger.balance, available: available(ledger), reserved: ledger.reserved }) }] } });
        continue;
      }
      if (name === "float_policy") {
        const agent = ledger.agents.find((a) => a.active);
        const spent = agent ? spentInWindow(agent, Date.now() + ledger.offsetMs) : 0;
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(agent ? { ...agent, buckets: undefined, spent, remaining: agent.dailyLimit - spent } : { error: "no agent" }) }] } });
        continue;
      }
      if (name === "float_pay") {
        const payee = resolvePayee(String(args.payee ?? ""));
        if (!payee) {
          send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Unknown payee" }] } });
          continue;
        }
        const result = pay(ledger, { payee: payee.address, amount: Number(args.amount), memo: String(args.memo ?? "") }, Date.now());
        ctx.writeLedger(result.ledger);
        send({ jsonrpc: "2.0", id, result: { isError: !result.ok, content: [{ type: "text", text: result.message }] } });
        continue;
      }
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
      continue;
    }
    if (req.method === "notifications/initialized" || req.id == null) continue;
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}
