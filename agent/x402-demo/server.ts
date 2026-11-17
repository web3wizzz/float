/**
 * Simplified x402-style resource server.
 * Differs from the official spec: the proof is a raw id in `X-Payment-Proof`,
 * there is no facilitator `/verify` + `/settle` split, and amounts here are
 * whole tUSD8. Chain id and the token address are imported from the SDK config,
 * not copied into this file.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Ledger } from "../../src/lib/float/ledger.ts";
import { DIRECTORY } from "../../src/lib/float/directory.ts";
import { chainId, tusd8, tusd8Decimals } from "../../packages/sdk/src/config.ts";

const PORT = Number(process.env.X402_PORT ?? 8787);
const ROOT = new URL("../../data/", import.meta.url);
const LEDGER = new URL("sandbox-ledger.json", ROOT);
const USED = new URL("x402-served.json", ROOT);
const PRICE = 25;
const PAY_TO = DIRECTORY[1].address;

function readUsed(): string[] {
  if (!existsSync(USED)) return [];
  return JSON.parse(readFileSync(USED, "utf8")) as string[];
}

function paymentOk(proof: string): { ok: boolean; reason: string } {
  const used = readUsed();
  if (used.includes(proof)) return { ok: false, reason: "proof already used" };
  if (!existsSync(LEDGER)) return { ok: false, reason: "no settlement ledger" };
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
  const hit = ledger.x402.find((r) => r.path === "/v1/oracle")?.purchases.find((p) => p.proof === proof);
  if (!hit) return { ok: false, reason: "proof does not match a settled oracle payment" };
  used.push(proof);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(USED, JSON.stringify(used, null, 2));
  return { ok: true, reason: "settled" };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(raw);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/v1/oracle") {
    send(res, 404, { error: "not found" });
    return;
  }
  const proof = req.headers["x-payment-proof"];
  if (typeof proof !== "string" || proof.length === 0) {
    res.setHeader("x-payment-required", "true");
    send(res, 402, {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: `eip155:${chainId}`,
          maxAmountRequired: String(PRICE),
          resource: "/v1/oracle",
          payTo: PAY_TO,
          asset: tusd8,
          extra: { token: "tUSD8", decimals: tusd8Decimals, decimalsStatus: "UNVERIFIED", note: "sandbox amounts are whole tUSD8, not base units" },
        },
      ],
    });
    return;
  }
  const check = paymentOk(proof);
  if (!check.ok) {
    send(res, 402, { error: check.reason });
    return;
  }
  send(res, 200, { snapshot: "AEVUM mid 1.0001 tUSD8 · 24h volume 4.2M · funding +0.01%", proof });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`x402 demo listening on ${PORT}\n`);
});
