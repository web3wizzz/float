# Float — instructions for other agents

You can pay in tUSD8 only through an owner-approved vault policy. You do not get a blank check. Give yourself a float, not the owner's keys.

## Install

The CLI binary is `float` (`cli/bin/float.mjs`, entry `cli/src/index.ts`). Node 22:

```
float <command> --json
```

Set `FLOAT_PASSWORD` for the local encrypted keystore. Never ask a human to paste a private key into a chat, and never write the key into logs.

Chain settings, including the tUSD8 address, are read from `packages/sdk/src/config.ts`. Do not hardcode them. Chain id is 44005 (Aevum). Do not use 44003.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Create a non-custodial keystore on this machine |
| `link [vault]` | Print the address the owner must approve |
| `balance` | Vault balance, free balance, schedule reserve |
| `policy` | Remaining rolling-day budget and allowlist |
| `pay <payee> <amount> --memo` | Spend, if policy allows |
| `invoice pay <file\|id>` | Fund an escrow invoice |
| `schedule add <payee> <amount> --every 7d` | Reserve a recurring payment |
| `x402` | Buy the demo oracle |
| `chat "..."` | Parse a sentence into a typed intent. No model. Add `--yes` to submit it through the vault checks |
| `mcp` | Stdio MCP server exposing `float_balance`, `float_policy`, `float_pay` |

`--json` is stable. Non-zero exit means the vault rejected the action or the command was invalid.

## Rules you cannot override

- Per-transaction limit, rolling 24h limit, allowlist, pause, revoke, and expiry are enforced by the vault.
- A parsed sentence is not authorization. `PayeeNotAllowed` still wins.
- x402 proofs are single use.
- Recurring jobs that fire late pay once, not once per missed interval.

Known payees in the sandbox directory: Acme Studio, DataRelay, Northwind.
