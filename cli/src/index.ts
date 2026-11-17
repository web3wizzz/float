import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Wallet } from "ethers";
import { decryptKey, encryptKey, type KeystoreFile } from "./keystore.ts";
import { DIRECTORY, resolvePayee } from "../../src/lib/float/directory.ts";
import { available, buyX402, createSchedule, deposit, freshLedger, fundInvoice, pay, registerAgent, revokeAgent, setPaused, spentInWindow, type Ledger } from "../../src/lib/float/ledger.ts";
import { describeAction, parseUtterance, type AgentAction } from "../../src/lib/float/parse.ts";
import { contracts } from "../../packages/sdk/src/config.ts";
import { serveMcp } from "./mcp.ts";

const HOME = new URL("../../data/", import.meta.url);
const KEY_PATH = new URL("keystore.json", HOME);
const LEDGER_PATH = new URL("sandbox-ledger.json", HOME);

interface Flags {
  json: boolean;
  yes: boolean;
  memo?: string;
  every?: string;
  perTx?: number;
  daily?: number;
  allow?: string;
  force: boolean;
}

function parseArgs(args: string[]): { cmd: string[]; flags: Flags } {
  const cmd: string[] = [];
  const flags: Flags = { json: false, yes: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--memo") flags.memo = args[++i];
    else if (a === "--every") flags.every = args[++i];
    else if (a === "--per-tx") flags.perTx = Number(args[++i]);
    else if (a === "--daily") flags.daily = Number(args[++i]);
    else if (a === "--allow") flags.allow = args[++i];
    else cmd.push(a);
  }
  return { cmd, flags };
}

function out(flags: Flags, payload: unknown, human: string) {
  if (flags.json) stdout.write(`${JSON.stringify(payload)}\n`);
  else stdout.write(`${human}\n`);
}

function fail(flags: Flags, message: string): never {
  if (flags.json) stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  else stdout.write(`${message}\n`);
  process.exit(1);
}

function ensureData() {
  mkdirSync(HOME, { recursive: true });
}

function readLedger(): Ledger {
  ensureData();
  if (!existsSync(LEDGER_PATH)) return freshLedger();
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
}

function writeLedger(ledger: Ledger) {
  ensureData();
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

async function password(): Promise<string> {
  if (process.env.FLOAT_PASSWORD) return process.env.FLOAT_PASSWORD;
  if (!stdin.isTTY) fail({ json: false, yes: false, force: false }, "Set FLOAT_PASSWORD. Refusing to prompt without a TTY.");
  const rl = createInterface({ input: stdin, output: stdout });
  const value = await rl.question("Keystore password: ");
  rl.close();
  if (!value) fail({ json: false, yes: false, force: false }, "Empty password.");
  return value;
}

function readKeystore(): KeystoreFile {
  if (!existsSync(KEY_PATH)) fail({ json: false, yes: false, force: false }, "No keystore. Run: float init");
  return JSON.parse(readFileSync(KEY_PATH, "utf8")) as KeystoreFile;
}

function everyMs(raw: string): number {
  const t = raw.trim().toLowerCase();
  if (t === "7d" || t === "week" || t === "1w") return 7 * 86400000;
  if (t === "1d" || t === "day") return 86400000;
  if (t === "1h" || t === "hour") return 3600000;
  const m = t.match(/^(\d+)(h|d|w)$/);
  if (!m) throw new Error(`Bad interval ${raw}. Use 1h, 1d, or 7d.`);
  const n = Number(m[1]);
  if (m[2] === "h") return n * 3600000;
  if (m[2] === "d") return n * 86400000;
  return n * 7 * 86400000;
}

async function unlock(flags: Flags): Promise<string> {
  const file = readKeystore();
  const pass = process.env.FLOAT_PASSWORD;
  if (!pass) {
    if (!stdin.isTTY) fail(flags, "Set FLOAT_PASSWORD. Refusing to prompt without a TTY.");
    const rl = createInterface({ input: stdin, output: stdout });
    const value = await rl.question("Keystore password: ");
    rl.close();
    if (!value) fail(flags, "Empty password.");
    const pk = decryptKey(file, value);
    const addr = new Wallet(pk).address;
    if (addr.toLowerCase() !== file.address.toLowerCase()) fail(flags, "Keystore address mismatch.");
    return file.address;
  }
  const pk = decryptKey(file, pass);
  const addr = new Wallet(pk).address;
  if (addr.toLowerCase() !== file.address.toLowerCase()) fail(flags, "Keystore address mismatch.");
  return file.address;
}

async function main() {
  const { cmd, flags } = parseArgs(argv.slice(2));
  const [a, b, c] = cmd;
  if (!a || a === "help" || a === "--help") {
    out(flags, { ok: true, commands: ["init", "link", "balance", "policy", "pay", "invoice pay", "schedule add", "chat", "x402", "mcp", "admin"] }, [
      "float init",
      "float link <vaultAddress>",
      "float balance | policy",
      "float pay <payee> <amount> --memo \"...\"",
      "float invoice pay <file|id>",
      "float schedule add <payee> <amount> --every 7d",
      "float chat \"pay Acme Studio 120 tUSD8 for invoice INV-0142\"",
      "float x402",
      "float mcp",
      "Sandbox owner helpers: float admin deposit <n> | admin approve --per-tx 150 --daily 400 --allow \"Acme Studio,DataRelay\"",
    ].join("\n"));
    return;
  }

  if (a === "mcp") {
    await serveMcp({ readLedger, writeLedger });
    return;
  }

  if (a === "init") {
    ensureData();
    if (existsSync(KEY_PATH) && !flags.force) fail(flags, "Keystore already exists. Pass --force to replace it.");
    const pass = await password();
    const wallet = Wallet.createRandom();
    const file = encryptKey(wallet.privateKey, pass, wallet.address);
    writeFileSync(KEY_PATH, JSON.stringify(file, null, 2));
    out(flags, { ok: true, address: wallet.address, keystore: "data/keystore.json" }, `Agent address ${wallet.address}\nKeystore written. The private key was not printed.`);
    return;
  }

  if (a === "link") {
    const vault = b || contracts.vault || "(deploy Float, then set contracts.vault in packages/sdk/src/config.ts)";
    const ks = readKeystore();
    const text = [
      `Agent ${ks.address}`,
      `Ask the vault owner to approve this address on ${vault}.`,
      `cast send ${vault} "registerAgent(address,uint128,uint128,uint64,bool)" ${ks.address} <perTx> <daily> 0 false`,
    ].join("\n");
    out(flags, { ok: true, address: ks.address, vault, action: "registerAgent" }, text);
    return;
  }

  if (a === "balance") {
    const ledger = readLedger();
    out(flags, { ok: true, balance: ledger.balance, available: available(ledger), reserved: ledger.reserved, mode: "sandbox" }, `Vault ${ledger.balance} tUSD8 · ${available(ledger)} free · ${ledger.reserved} reserved`);
    return;
  }

  if (a === "policy") {
    const ledger = readLedger();
    const agent = ledger.agents.find((x) => x.active);
    if (!agent) fail(flags, "No active agent in the sandbox ledger.");
    const now = Date.now() + ledger.offsetMs;
    const spent = spentInWindow(agent, now);
    out(
      flags,
      { ok: true, agent: agent.address, label: agent.label, perTxLimit: agent.perTxLimit, dailyLimit: agent.dailyLimit, spent, remaining: agent.dailyLimit - spent, allow: agent.allow, paused: agent.paused },
      `${agent.label} remaining ${agent.dailyLimit - spent} / ${agent.dailyLimit} today · per tx ${agent.perTxLimit}`,
    );
    return;
  }

  if (a === "admin" && b === "deposit") {
    const amount = Number(c);
    const result = deposit(readLedger(), amount, Date.now());
    if (!result.ok) fail(flags, result.message);
    writeLedger(result.ledger);
    out(flags, { ok: true, balance: result.ledger.balance }, result.message);
    return;
  }

  if (a === "admin" && b === "approve") {
    const names = (flags.allow ?? "Acme Studio,DataRelay").split(",").map((s) => s.trim());
    const allow = names.map((n) => {
      const hit = resolvePayee(n);
      if (!hit) fail(flags, `Unknown payee ${n}`);
      return hit.address;
    });
    const ks = existsSync(KEY_PATH) ? readKeystore() : null;
    const result = registerAgent(
      readLedger(),
      { address: ks?.address, label: "payables-1", perTxLimit: flags.perTx ?? 150, dailyLimit: flags.daily ?? 400, allow },
      Date.now(),
    );
    if (!result.ok) fail(flags, result.message);
    writeLedger(result.ledger);
    out(flags, { ok: true, agent: result.ledger.agents.at(-1)?.address }, result.message);
    return;
  }

  if (a === "pay") {
    if (!b || !c) fail(flags, "Usage: float pay <payee> <amount> --memo \"...\"");
    await unlock(flags);
    const payee = resolvePayee(b);
    if (!payee) fail(flags, `Unknown payee ${b}. Known: ${DIRECTORY.map((d) => d.label).join(", ")}`);
    const result = pay(readLedger(), { payee: payee.address, amount: Number(c), memo: flags.memo ?? "" }, Date.now());
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, payee: payee.address, amount: Number(c), balance: result.ledger.balance }, result.message);
    return;
  }

  if (a === "invoice" && b === "pay") {
    if (!c) fail(flags, "Usage: float invoice pay <file|id>");
    let id = c;
    if (existsSync(c)) {
      const file = JSON.parse(readFileSync(c, "utf8")) as { id?: string };
      if (!file.id) fail(flags, "Invoice file needs an id.");
      id = file.id;
    }
    await unlock(flags);
    const result = fundInvoice(readLedger(), id, Date.now());
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, invoice: id, balance: result.ledger.balance }, result.message);
    return;
  }

  if (a === "schedule" && b === "add") {
    if (!c || !cmd[3]) fail(flags, "Usage: float schedule add <payee> <amount> --every 7d");
    const payee = resolvePayee(c);
    if (!payee) fail(flags, `Unknown payee ${c}`);
    await unlock(flags);
    const interval = everyMs(flags.every ?? "7d");
    const result = createSchedule(
      readLedger(),
      { payee: payee.address, amount: Number(cmd[3]), intervalMs: interval, maxRuns: interval >= 7 * 86400000 ? 12 : 24, memo: flags.memo ?? "recurring", byAgent: true },
      Date.now(),
    );
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, message: result.message }, result.message);
    return;
  }

  if (a === "x402") {
    await unlock(flags);
    const result = buyX402(readLedger(), "oracle", Date.now());
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, proof: result.proof, body: result.message }, `${result.message}\nproof ${result.proof}`);
    return;
  }

  if (a === "chat") {
    const text = cmd.slice(1).join(" ");
    if (!text) fail(flags, "Usage: float chat \"...\"");
    const parsed = parseUtterance(text);
    if (!parsed.action) fail(flags, parsed.error ?? "No action.");
    const summary = describeAction(parsed.action);
    if (!flags.yes) {
      out(
        flags,
        { ok: true, dryRun: true, source: "parser", action: parsed.action, summary },
        `${summary}\nParser only — no model. Re-run with --yes. The vault still enforces the policy.`,
      );
      return;
    }
    await executeParsed(flags, parsed.action);
    return;
  }

  fail(flags, `Unknown command ${cmd.join(" ")}. Try float help.`);
}

async function executeParsed(flags: Flags, action: AgentAction) {
  const now = Date.now();
  if (action.type === "balance") {
    const ledger = readLedger();
    const agent = ledger.agents.find((x) => x.active);
    const spent = agent ? spentInWindow(agent, now + ledger.offsetMs) : 0;
    out(
      flags,
      { ok: true, source: "parser", balance: ledger.balance, available: available(ledger), reserved: ledger.reserved, spent },
      `Vault ${ledger.balance} tUSD8 · ${available(ledger)} free · ${ledger.reserved} reserved`,
    );
    return;
  }
  if (action.type === "pause") {
    const result = setPaused(readLedger(), true, now);
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, source: "parser", message: result.message }, result.message);
    return;
  }
  if (action.type === "revoke") {
    const result = revokeAgent(readLedger(), now);
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, source: "parser", message: result.message }, result.message);
    return;
  }
  if (action.type === "x402") {
    await unlock(flags);
    const result = buyX402(readLedger(), action.resource, now);
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, source: "parser", proof: result.proof, message: result.message }, result.message);
    return;
  }
  if (action.type === "schedule") {
    await unlock(flags);
    const result = createSchedule(
      readLedger(),
      { payee: action.payee, amount: action.amount, intervalMs: action.everyMs, maxRuns: action.maxRuns, memo: action.memo ?? "recurring", byAgent: true },
      now,
    );
    writeLedger(result.ledger);
    if (!result.ok) fail(flags, result.message);
    out(flags, { ok: true, source: "parser", message: result.message }, result.message);
    return;
  }
  await unlock(flags);
  const result = action.memo?.startsWith("INV-")
    ? fundInvoice(readLedger(), action.memo, now)
    : pay(readLedger(), { payee: action.payee, amount: action.amount, memo: action.memo ?? "" }, now);
  writeLedger(result.ledger);
  if (!result.ok) fail(flags, result.message);
  out(flags, { ok: true, source: "parser", message: result.message }, result.message);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "failed";
  stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
});
