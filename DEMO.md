# Three-minute demo

The console opens in **Simulation**. Say that out loud. It is a local ledger with the same rules as the contracts, and it is labelled. No wallet is required for this cut. Switch to **Live (Aevum)** only when a vault address has been written into `packages/sdk/src/config.ts` — chain 44005, not 44003.

## 0:00 — The problem

"An agent that can spend a stablecoin is useful. An agent that can empty the account is not. Float gives the agent a float, not your keys. The parser can ask. The contract decides."

## 0:20 — Init and approve

1. Agents tab, `payables-1`. That is the address `float init` creates a keystore for. The key is not printed.
2. Stay on Simulation. Vault tab, actor **owner**. Run step 1: deposit **1,000 tUSD8**.
3. Run step 2: approve the agent at **150 per transaction**, **400 per rolling day**, allowlist **Acme Studio** and **DataRelay**. Northwind stays off the list.

## 1:00 — Agent pays an invoice

Run the invoice step. The agent funds **INV-0142** (120 tUSD8) into escrow. The feed shows the hold.

As **payee**, mark it delivered. As **owner**, confirm. Status becomes released.

## 1:40 — x402

Pay tab. The oracle answers **402** at 25 tUSD8 to DataRelay, on chain 44005. **Agent buys**. Hit **Replay proof**. The second use is rejected.

## 2:10 — Northwind, then the cap

Run **Try Northwind**. The payee is not on the allowlist. Simulation records `PayeeNotAllowed` and the balance does not move. On Live, the same button calls `simulateContract` and shows that revert instead of a hash.

Run **Hit the per-tx cap**. 180 is over 150. The feed turns amber. The balance does not move.

Advance the simulation clock **25h**. Yesterday's spend leaves the window.

## 2:40 — Revoke

Run revoke. A further payment fails immediately.

## The bar

Type `pay Northwind 10 tUSD8` and press Parse. You should see a typed intent and nothing else — no model. Execute submits it through the same path as the button, and the vault still rejects it.

## Optional terminal beat

```
export FLOAT_PASSWORD=demo
float init --json
float admin deposit 1000 --json
float admin approve --per-tx 150 --daily 400 --allow "Acme Studio,DataRelay" --json
float invoice pay agent/invoices/INV-0142.json --json
float pay "Acme Studio" 180 --memo over --json
float chat "pay Northwind 10 tUSD8" --yes --json
```

The last two commands exit non-zero. That is the product working.
