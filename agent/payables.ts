/**
 * Payables agent. Reads an invoice file and asks the vault to fund it.
 * There is no model in this path. The ledger (or the contract, once deployed)
 * accepts or rejects the payment.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fundInvoice, type Ledger } from "../src/lib/float/ledger.ts";

interface InvoiceFile {
  id: string;
  payee: string;
  amount: number;
  memo?: string;
}

const file = process.argv[2] ?? new URL("./invoices/INV-0142.json", import.meta.url);
const ledgerPath = new URL("../data/sandbox-ledger.json", import.meta.url);

function main() {
  const raw = typeof file === "string" ? file : file;
  const invoice = JSON.parse(readFileSync(raw, "utf8")) as InvoiceFile;
  if (!existsSync(ledgerPath)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "No sandbox ledger. Approve the agent and fund the vault first." })}\n`);
    process.exit(1);
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  const result = fundInvoice(ledger, invoice.id, Date.now());
  writeFileSync(ledgerPath, JSON.stringify(result.ledger, null, 2));
  process.stdout.write(`${JSON.stringify({ ok: result.ok, source: "vault", invoice: invoice.id, message: result.message, balance: result.ledger.balance })}\n`);
  if (!result.ok) process.exit(1);
}

main();
