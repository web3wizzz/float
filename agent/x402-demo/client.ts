/**
 * Agent side of the simplified x402 demo.
 * On 402 it pays through the sandbox vault (policy still applies) and retries
 * with X-Payment-Proof. A second retry with the same proof is rejected.
 */
import { buyX402, type Ledger } from "../../src/lib/float/ledger.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const base = process.env.X402_URL ?? "http://127.0.0.1:8787";
const ledgerPath = new URL("../../data/sandbox-ledger.json", import.meta.url);

function readLedger(): Ledger {
  if (!existsSync(ledgerPath)) throw new Error("No sandbox ledger. Fund and approve an agent first.");
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
}

async function main() {
  const first = await fetch(`${base}/v1/oracle`);
  const challenge = await first.json();
  if (first.status !== 402) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "expected 402", status: first.status, challenge })}\n`);
    process.exit(1);
  }
  const paid = buyX402(readLedger(), "oracle", Date.now());
  mkdirSync(new URL("../../data/", import.meta.url), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(paid.ledger, null, 2));
  if (!paid.ok || !paid.proof) {
    process.stdout.write(`${JSON.stringify({ ok: false, stage: "policy", error: paid.message, challenge })}\n`);
    process.exit(1);
  }
  const second = await fetch(`${base}/v1/oracle`, { headers: { "X-Payment-Proof": paid.proof } });
  const body = await second.json();
  const replay = await fetch(`${base}/v1/oracle`, { headers: { "X-Payment-Proof": paid.proof } });
  const replayBody = await replay.json();
  process.stdout.write(
    `${JSON.stringify({ ok: second.status === 200 && replay.status === 402, status: second.status, body, replayStatus: replay.status, replayBody, proof: paid.proof }, null, 2)}\n`,
  );
  if (second.status !== 200 || replay.status !== 402) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : "failed"}\n`);
  process.exit(1);
});
