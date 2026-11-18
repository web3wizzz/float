# Security

Float's safety rail is the vault, not the parser and not the CLI. An agent key can only move tUSD8 that an owner already deposited, and only inside a policy the owner can revoke in one transaction.

## Threat model

| Threat | What we do |
| --- | --- |
| Stolen agent key | Per-tx cap, rolling 24h cap, payee allowlist, expiry, pause, revoke. Owner withdraws the rest. |
| Relayer replays a signed intent | EIP-712 digest (domain `Float Vault`), per-agent nonce, deadline. OpenZeppelin ECDSA rejects malleable signatures. |
| Keeper fires a late schedule many times | `executeSchedule` pays once and sets `nextRun = now + interval`. A test warps 10 hours, asserts one charge, asserts the immediate retry reverts, then asserts the next interval is charge number 2. |
| Agent locks the whole vault in schedules | Schedules an agent opens share one cap: their remaining reserve cannot exceed that agent's daily limit. A paused, globally paused, or already-expired agent cannot open one. The owner can still schedule rent above the daily limit. `withdraw` cannot eat the reserve. |
| Invoice past due | Delivery cannot be marked at or after the due date, so a late delivery cannot block the refund or turn into an auto-release. |
| Invoice dispute | Either party can flag. Only the designated arbiter can release or refund. |
| Reentrancy through the token | `ReentrancyGuard` on every value-moving entrypoint. A callback token fails closed. |
| Model tells the agent to pay | The natural-language path only parses into a typed intent. That intent is submitted through the same policy checks as a button. Nothing in the parser can move funds. |
| x402 proof replay | The resource server stores each proof and rejects a second use. |
| Keystore theft | AES-256-GCM with scrypt. The CLI never prints the private key. Password comes from `FLOAT_PASSWORD` or a TTY prompt, not from argv. |

## Invariants tested

- Vault token balance ≥ `reserved`, and balance matches the handler's ghost accounting.
- `reserved` equals the sum of remaining schedule obligations.
- An agent's open schedules reserve at most that agent's daily limit, tracked in `agentReserved`.
- A successful spend is inside the per-tx cap, the rolling day, the allowlist, and an active, unpaused, unexpired policy. Revoked, paused, and expired agents cannot spend. A global pause blocks spends.
- Each schedule run charges once. `runs` does not jump by the number of missed intervals, and an immediate second `executeSchedule` reverts.
- An EIP-712 intent cannot be replayed, tampered, signed by the wrong key, or reused on another chain id or another vault.
- Escrow token balance equals the sum of invoices that are funded, delivered, or disputed.

## Post-quantum

Signature checks sit behind `IAgentAuth.verify(claimedSigner, digest, signature)`. `EcdsaAgentAuth` is the default. A post-quantum verifier replaces that contract via `setAuth`. The interface takes the claimed signer because Dilithium and Falcon do not recover an address.

The digest is still EIP-712 (keccak). A scheme that must hash with a different function has to replace the hasher as well as the verifier.

## Known limitations

- The rolling day is 24 hourly buckets, not a second-accurate window.
- The owner and the arbiter are trusted. There is no on-chain timelock.
- Allowlists are mappings, not enumerated on-chain. Index `PayeeUpdated`.
- `PaymentRouter` only forwards already-signed intents. It does not hold funds. A batch is atomic.
- The x402 demo is not the full spec. See the README.
- Simulation in the CLI and the web console mirrors these rules in TypeScript. It is labelled simulation. It is not a chain.
- Aevum tUSD8 has 6 decimals. The number and the token address are recorded only in `packages/sdk/src/config.ts`. The Foundry mock reports 6, so test amounts written as `150e6` are 150 whole tokens.
- A payee can `dispute` a funded invoice before the due date. That parks it for the arbiter and skips the automatic refund. Delivery at or after the due date is rejected.
- Live mode will not pretend a transaction succeeded when the vault address is empty.
- No formal verification. Tests are unit, fuzz, and Foundry invariant tests, not an audit.
