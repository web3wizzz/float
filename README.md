# Float

Give your agents a float, not your keys.

Float is a tUSD8 vault for the Aevum Builder Challenge. The owner deposits the stablecoin and writes a policy. An agent can pay only inside that policy: a per-transaction cap, a rolling day, an allowlist, an expiry, and pause or revoke. A sentence — from a person or from a parser — is only an intent. The vault is the authority.

Network: **Aevum testnet, chain id 44005**. Not QDay Origin (44003). Native gas is tQDAY, 18 decimals. RPC, explorer, faucet, and the tUSD8 address live in one file: `packages/sdk/src/config.ts`. The token decimals there are marked **UNVERIFIED**. Do not copy the token address into another file.

Vault, escrow, router, and auth addresses in that file are empty until you deploy. Live mode refuses to invent a transaction while they are empty.

## Contracts

From `contracts/` (OpenZeppelin and forge-std are installed locally, not committed):

```
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-commit
forge build
forge test
```

`forge test` includes a case where a schedule is 10 hours late: one execution charges once, an immediate second call reverts `NotDue`, and the next interval is the second charge (`runs == 2`).

Local deploy (Anvil account #0 is the default key, local only):

```
anvil
cd contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

That writes `contracts/deployments/latest.json`. If `TUSD8_ADDRESS` is unset, the script deploys `MockTUSD8`. Do not deploy the mock on Aevum. After a real deploy, paste the addresses into `packages/sdk/src/config.ts` only.

## CLI

Node 22. The binary is `float`. The keystore is scrypt + AES-256-GCM. The private key is never printed. The password is `FLOAT_PASSWORD` or a TTY prompt, never an argv value.

```
export FLOAT_PASSWORD='choose-one'
float init --json
float link --json
float admin deposit 1000 --json
float admin approve --per-tx 150 --daily 400 --allow "Acme Studio,DataRelay" --json
float invoice pay agent/invoices/INV-0142.json --json
float pay "Acme Studio" 180 --memo over --json
float chat "pay Northwind 10 tUSD8" --yes --json
float x402 --json
float mcp
```

`chat` only parses the sentence into a typed intent. `--yes` submits that intent through the same policy checks. Northwind is rejected with `PayeeNotAllowed`.

See SECURITY.md and DEMO.md.
