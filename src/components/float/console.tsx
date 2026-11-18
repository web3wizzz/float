import { useEffect, useState } from "react";
import { format } from "date-fns";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, http, useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Address } from "viem";
import { chainId, configured, contracts, explorerUrl, faucetUrl, aevumTestnet, isHexAddress, rpcUrl, tusd8, tusd8Decimals, vaultAddress } from "@/lib/float/config";
import { DEFAULT_AGENT, DIRECTORY, labelOf, shortAddr } from "@/lib/float/directory";
import {
  HOUR_MS,
  available,
  buyX402,
  confirmInvoice,
  createSchedule,
  deposit,
  disputeInvoice,
  executeSchedule,
  explainPolicy,
  freshLedger,
  fundInvoice,
  markDelivered,
  pay,
  registerAgent,
  replayProof,
  resolveInvoice,
  revokeAgent,
  setGlobalPaused,
  setPaused,
  spentInWindow,
  withdraw,
  type FeedItem,
  type Ledger,
  type Result,
} from "@/lib/float/ledger";
import { describeAction, parseUtterance, type AgentAction } from "@/lib/float/parse";
import {
  createScheduleOnVault,
  depositToVault,
  executeScheduleOnVault,
  fundInvoiceOnVault,
  pauseAgentOnVault,
  pauseVaultOnVault,
  payFromVault,
  registerOnVault,
  revokeOnVault,
  wholeToBase,
  withdrawFromVault,
  type TxResult,
} from "../../../packages/sdk/src/vault.ts";

type Tab = "vault" | "agents" | "pay" | "activity";
type Role = "owner" | "agent" | "payee" | "arbiter";
type Mode = "simulation" | "live";

interface Receipt {
  id: number;
  ok: boolean;
  title: string;
  detail: string;
  hashes: string[];
}

const queryClient = new QueryClient();
const wagmiConfig = createConfig({
  chains: [aevumTestnet],
  connectors: [injected()],
  transports: { [aevumTestnet.id]: http(rpcUrl) },
  ssr: true,
});

const KEY = "float-ledger-v1";
const field =
  "min-h-11 w-full rounded-lg border border-line bg-paper px-3 font-mono text-sm text-ink outline-none focus-visible:border-seal";
const primary =
  "min-h-11 rounded-lg bg-seal px-4 text-sm font-medium text-paper disabled:opacity-40";
const ghost =
  "min-h-11 rounded-lg border border-line bg-surface px-4 text-sm text-ink disabled:opacity-40";
const dangerBtn =
  "min-h-11 rounded-lg border border-line px-4 text-sm text-stamp disabled:opacity-40";

function loadLedger(raw: string | null): Ledger {
  if (!raw) return freshLedger();
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    if (!parsed || !Array.isArray(parsed.invoices) || !Array.isArray(parsed.agents)) return freshLedger();
    const base = freshLedger();
    return {
      ...base,
      ...parsed,
      x402: parsed.x402 && parsed.x402.length > 0 ? parsed.x402 : base.x402,
      usedProofs: parsed.usedProofs ?? [],
      feed: parsed.feed ?? [],
    };
  } catch {
    return freshLedger();
  }
}

export function Console() {
  const [ledger, setLedger] = useState<Ledger>(freshLedger);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("vault");
  const [role, setRole] = useState<Role>("owner");
  const [amount, setAmount] = useState("1000");
  const [perTx, setPerTx] = useState("150");
  const [daily, setDaily] = useState("400");
  const [allow, setAllow] = useState<string[]>([DIRECTORY[0].address, DIRECTORY[1].address]);
  const [utterance, setUtterance] = useState("pay Acme Studio 120 tUSD8 for invoice INV-0142");
  const [pending, setPending] = useState<AgentAction | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [schedPayee, setSchedPayee] = useState(DIRECTORY[0].address);
  const [schedAmt, setSchedAmt] = useState("5");
  const [schedEvery, setSchedEvery] = useState(String(HOUR_MS));
  const [lastProof, setLastProof] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("simulation");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState(false);
  const { address: wallet, chainId: walletChain, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: aevumTestnet.id });
  const { data: walletClient } = useWalletClient({ chainId: aevumTestnet.id });

  const live = mode === "live";

  useEffect(() => {
    setLedger(loadLedger(localStorage.getItem(KEY)));
    setNow(Date.now());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(KEY, JSON.stringify(ledger));
  }, [ledger, ready]);

  const clock = now == null ? null : now + ledger.offsetMs;
  const agent = ledger.agents.find((a) => a.active) ?? ledger.agents[0];
  const spent = agent && clock != null ? spentInWindow(agent, clock) : 0;
  const left = agent ? Math.max(0, agent.dailyLimit - spent) : 0;

  function at(): number {
    return (now ?? Date.now()) + ledger.offsetMs;
  }

  function apply(result: Result, extra?: string) {
    setLedger(result.ledger);
    setNote(extra ?? result.message);
    if (result.proof) setLastProof(result.proof);
  }

  function record(entry: Omit<Receipt, "id">) {
    setReceipts((prev) => [{ ...entry, id: Date.now() }, ...prev].slice(0, 12));
    setNote(entry.detail);
    if (!entry.ok) setTab("activity");
  }

  async function liveSend(
    title: string,
    run: (pc: NonNullable<typeof publicClient>, wc: NonNullable<typeof walletClient>) => Promise<TxResult>,
  ) {
    if (!publicClient || !walletClient) {
      record({ ok: false, title, detail: "Connect a wallet on Aevum before sending a transaction.", hashes: [] });
      return;
    }
    if (walletChain !== chainId) {
      try {
        await switchChainAsync({ chainId });
      } catch (err) {
        record({ ok: false, title, detail: err instanceof Error ? err.message : "Could not switch to Aevum.", hashes: [] });
        return;
      }
    }
    setBusy(true);
    try {
      const result = await run(publicClient, walletClient);
      if (result.ok) {
        record({ ok: true, title, detail: result.hashes.map((hash) => `${explorerUrl}/tx/${hash}`).join(" "), hashes: [...result.hashes] });
      } else {
        record({ ok: false, title, detail: result.reason, hashes: [] });
      }
    } catch (err) {
      record({ ok: false, title, detail: err instanceof Error ? err.message : "reverted", hashes: [] });
    } finally {
      setBusy(false);
    }
  }

  function asAddress(value: string): Address {
    if (!isHexAddress(value)) throw new Error(`Not an address: ${value}`);
    return value;
  }

  function asRole(expected: Role) {
    if (role !== expected) setRole(expected);
    return true;
  }

  function onDeposit(value = Number(amount)) {
    if (!asRole("owner")) return;
    if (live) {
      void liveSend("Deposit", (pc, wc) => depositToVault(pc, wc, wholeToBase(value)));
      return;
    }
    apply(deposit(ledger, value, at()));
  }

  function onWithdraw() {
    if (!asRole("owner")) return;
    if (live) {
      void liveSend("Withdraw", (pc, wc) => withdrawFromVault(pc, wc, wholeToBase(Number(amount))));
      return;
    }
    apply(withdraw(ledger, Number(amount), at()));
  }

  function onRegister() {
    if (!asRole("owner")) return;
    if (live) {
      void liveSend("Approve agent", (pc, wc) =>
        registerOnVault(pc, wc, asAddress(DEFAULT_AGENT.address), wholeToBase(Number(perTx)), wholeToBase(Number(daily)), allow.filter(isHexAddress)),
      );
      return;
    }
    apply(
      registerAgent(
        ledger,
        {
          perTxLimit: Number(perTx),
          dailyLimit: Number(daily),
          allow,
          allowAny: false,
        },
        at(),
      ),
    );
  }

  function onFundInvoice(id: string) {
    if (!asRole("agent")) return;
    if (live) {
      const inv = ledger.invoices.find((item) => item.id === id);
      void liveSend(`Fund ${id}`, (pc, wc) => fundInvoiceOnVault(pc, wc, BigInt(inv?.numericId ?? 1)));
      return;
    }
    apply(fundInvoice(ledger, id, at()));
  }

  function onBuy() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Buy oracle", (pc, wc) => payFromVault(pc, wc, asAddress(DIRECTORY[1].address), wholeToBase(25), "x402"));
      return;
    }
    const result = buyX402(ledger, "oracle", at());
    apply(result);
    if (!result.ok) setTab("activity");
  }

  function onNorthwind() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Try Northwind", (pc, wc) => payFromVault(pc, wc, asAddress(DIRECTORY[2].address), wholeToBase(10), "northwind"));
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[2].address, amount: 10, memo: "northwind" }, at()));
    setTab("activity");
  }

  function onBlock() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Over per-tx", (pc, wc) => payFromVault(pc, wc, asAddress(DIRECTORY[0].address), wholeToBase(180), "over per-tx"));
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[0].address, amount: 180, memo: "over per-tx" }, at()));
    setTab("activity");
  }

  function onRevoke() {
    if (!asRole("owner")) return;
    if (live) {
      void liveSend("Revoke", (pc, wc) => revokeOnVault(pc, wc, asAddress(agent?.address ?? DEFAULT_AGENT.address)));
      return;
    }
    apply(revokeAgent(ledger, at()));
  }

  function runAction(action: AgentAction) {
    if (live) {
      void runLiveAction(action);
      return;
    }
    const ts = at();
    if (action.type === "balance") {
      setNote(
        agent
          ? `Vault ${ledger.balance} tUSD8 · ${available(ledger)} free · ${ledger.reserved} reserved · ${agent.label} has ${left} left today.`
          : `Vault ${ledger.balance} tUSD8. No agent approved yet.`,
      );
      return;
    }
    if (action.type === "pause") {
      if (!asRole("owner")) return;
      apply(setPaused(ledger, !(agent?.paused ?? false), ts));
      return;
    }
    if (action.type === "revoke") {
      onRevoke();
      return;
    }
    if (action.type === "x402") {
      onBuy();
      return;
    }
    if (action.type === "pay") {
      if (!asRole("agent")) return;
      if (action.memo?.startsWith("INV-")) {
        const inv = ledger.invoices.find((i) => i.id === action.memo);
        if (inv && inv.status === "open" && inv.amount === action.amount) {
          apply(fundInvoice(ledger, inv.id, ts));
          setTab("pay");
          return;
        }
      }
      apply(pay(ledger, { payee: action.payee, amount: action.amount, memo: action.memo ?? "" }, ts));
      return;
    }
    if (!asRole(role === "agent" ? "agent" : "owner")) return;
    apply(
      createSchedule(
        ledger,
        {
          payee: action.payee,
          amount: action.amount,
          intervalMs: action.everyMs,
          maxRuns: action.maxRuns,
          memo: action.memo ?? "recurring",
          byAgent: role === "agent",
        },
        ts,
      ),
    );
    setTab("agents");
  }

  async function runLiveAction(action: AgentAction) {
    const who = asAddress(agent?.address ?? DEFAULT_AGENT.address);
    if (action.type === "balance") {
      const deployed = vaultAddress();
      setNote(deployed ? `Live vault ${deployed} on Aevum ${chainId}. The contract is the balance, not this sentence.` : "Vault address is empty. Nothing was sent.");
      return;
    }
    if (action.type === "pause") {
      await liveSend("Pause agent", (pc, wc) => pauseAgentOnVault(pc, wc, who, true));
      return;
    }
    if (action.type === "revoke") {
      await liveSend("Revoke", (pc, wc) => revokeOnVault(pc, wc, who));
      return;
    }
    if (action.type === "x402") {
      await liveSend("Buy oracle", (pc, wc) => payFromVault(pc, wc, asAddress(DIRECTORY[1].address), wholeToBase(25), "x402"));
      return;
    }
    if (action.type === "pay") {
      if (action.memo?.startsWith("INV-")) {
        const inv = ledger.invoices.find((item) => item.id === action.memo);
        await liveSend(`Fund ${action.memo}`, (pc, wc) => fundInvoiceOnVault(pc, wc, BigInt(inv?.numericId ?? 1)));
        return;
      }
      await liveSend("Pay", (pc, wc) => payFromVault(pc, wc, asAddress(action.payee), wholeToBase(action.amount), action.memo ?? ""));
      return;
    }
    await liveSend("Schedule", (pc, wc) =>
      createScheduleOnVault(
        pc,
        wc,
        who,
        asAddress(action.payee),
        wholeToBase(action.amount),
        BigInt(Math.max(3600, Math.floor(action.everyMs / 1000))),
        action.maxRuns,
        action.memo ?? "recurring",
      ),
    );
  }

  const northwindRejected =
    ledger.feed.some((item) => /PayeeNotAllowed/.test(item.detail)) || receipts.some((item) => /PayeeNotAllowed/.test(item.detail));
  const capRejected =
    ledger.feed.some((item) => /Per-transaction/.test(item.detail)) || receipts.some((item) => /PerTxLimitExceeded|Per-transaction/.test(item.detail));

  const steps = [
    { id: "fund", label: "Fund the vault", detail: "1,000 tUSD8", done: !live && (ledger.balance > 0 || ledger.feed.some((f) => f.title.startsWith("Deposited"))), run: () => onDeposit(1000) },
    { id: "agent", label: "Approve payables-1", detail: "150 per tx · 400 / day", done: !live && ledger.agents.length > 0, run: () => onRegister() },
    {
      id: "invoice",
      label: "Pay INV-0142",
      detail: "120 into escrow",
      done: !live && ledger.invoices[0]?.status !== "open",
      run: () => onFundInvoice("INV-0142"),
    },
    { id: "x402", label: "Buy the oracle", detail: "402 · 25 tUSD8", done: !live && ledger.x402[0].purchases.length > 0, run: onBuy },
    { id: "northwind", label: "Try Northwind", detail: "PayeeNotAllowed", done: northwindRejected, run: onNorthwind },
    { id: "block", label: "Hit the per-tx cap", detail: "180 is refused", done: capRejected, run: onBlock },
    { id: "revoke", label: "Revoke the agent", detail: "Spend stops immediately", done: !live && ledger.agents.some((a) => !a.active), run: onRevoke },
  ];
  const nextStep = steps.find((s) => !s.done);

  return (
    <main className="min-h-screen bg-paper text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-seal font-display text-sm font-medium text-paper">Fl</div>
            <div>
              <p className="font-display text-sm font-medium tracking-tight">Float</p>
              <p className="text-xs text-muted">Give your agents a float, not your keys.</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex rounded-lg border border-line p-1" role="group" aria-label="Ledger mode">
              <button type="button" aria-pressed={!live} onClick={() => setMode("simulation")} className={`min-h-11 rounded-md px-3 text-sm ${!live ? "bg-seal text-paper" : "text-muted"}`}>
                Simulation
              </button>
              <button type="button" aria-pressed={live} onClick={() => setMode("live")} className={`min-h-11 rounded-md px-3 text-sm ${live ? "bg-seal text-paper" : "text-muted"}`}>
                Live (Aevum)
              </button>
            </div>
            <p className="text-right font-mono text-xs text-muted">
              {clock == null ? "—" : format(clock, "MMM d · HH:mm")}
              {!live && ledger.offsetMs !== 0 ? <span className="block text-treasury">sim +{Math.round(ledger.offsetMs / HOUR_MS)}h</span> : null}
            </p>
          </div>
        </div>
      </header>

      <div className={`border-b border-line ${live ? "bg-surface" : "bg-stamp/10"}`}>
        <p className="mx-auto max-w-6xl px-4 py-2 text-sm text-ink">
          {live
            ? configured
              ? `Live (Aevum). Chain ${chainId}. Each action is simulated, then sent. A blocked action shows the contract revert.`
              : `Live (Aevum). Chain ${chainId}. Vault address is empty, so sends stop before a fake transaction.`
            : "Simulation. This ledger is local and labelled as such. It is not a transaction on Aevum."}
        </p>
      </div>

      {note ? (
        <div className="border-b border-line bg-surface">
          <p className="mx-auto max-w-6xl px-4 py-2 text-sm text-ink">{note}</p>
        </div>
      ) : null}

      <div className="mx-auto grid max-w-6xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <section className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted">Vault</p>
            <p className="mt-1 font-mono text-4xl font-medium tracking-tight">{ledger.balance.toLocaleString("en-US")}</p>
            <p className="font-mono text-xs text-muted">tUSD8 · {available(ledger)} free · {ledger.reserved} reserved for schedules</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {(["owner", "agent", "payee", "arbiter"] as Role[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={role === r}
                  onClick={() => setRole(r)}
                  className={`min-h-11 rounded-lg px-3 text-sm capitalize ${role === r ? "bg-seal text-paper" : "border border-line text-muted"}`}
                >
                  {r}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Acting as {role}. The vault checks the caller, not the sentence you type.</p>
          </section>

          <div className="mt-4 flex gap-2 overflow-x-auto">
            {(
              [
                ["vault", "Vault"],
                ["agents", "Agents"],
                ["pay", "Pay"],
                ["activity", "Activity"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`min-h-11 shrink-0 rounded-lg px-4 text-sm ${tab === id ? "bg-seal text-paper" : "border border-line text-muted"} ${id === "activity" ? "lg:hidden" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "vault" ? (
            <div className="mt-4 space-y-4">
              <section className="rounded-lg border border-line p-4">
                <h2 className="text-sm font-medium">Operator path</h2>
                <ol className="mt-3 space-y-2">
                  {steps.map((step, i) => {
                    const current = step.id === nextStep?.id;
                    return (
                      <li key={step.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2">
                        <div className="min-w-0">
                          <p className={`text-sm ${step.done ? "text-muted" : "text-ink"}`}>
                            <span className="mr-2 font-mono text-xs text-muted">{step.done ? "ok" : String(i + 1).padStart(2, "0")}</span>
                            {step.label}
                          </p>
                          <p className="truncate pl-7 text-xs text-muted">{step.detail}</p>
                        </div>
                        {current ? (
                          <button type="button" className={primary} disabled={!ready || busy} onClick={step.run}>
                            Run
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </section>

              <section className="rounded-lg border border-line p-4">
                <h2 className="text-sm font-medium">Move funds</h2>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <label className="sr-only" htmlFor="amount">
                    Amount
                  </label>
                  <input id="amount" inputMode="numeric" className={field} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} />
                  <button type="button" className={primary} disabled={!ready} onClick={() => onDeposit()}>
                    Deposit
                  </button>
                  <button type="button" className={ghost} disabled={!ready} onClick={onWithdraw}>
                    Withdraw
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={ghost}
                    disabled={live}
                    onClick={() => {
                      setLedger({ ...ledger, offsetMs: ledger.offsetMs + 25 * HOUR_MS });
                      setNote("Simulation clock jumped 25 hours. Yesterday’s spend has rolled out of the window.");
                    }}
                  >
                    Advance 25h
                  </button>
                  <button
                    type="button"
                    className={dangerBtn}
                    disabled={busy}
                    onClick={() => {
                      if (!asRole("owner")) return;
                      if (live) {
                        void liveSend(ledger.globalPaused ? "Resume vault" : "Pause vault", (pc, wc) => pauseVaultOnVault(pc, wc, !ledger.globalPaused));
                        return;
                      }
                      apply(setGlobalPaused(ledger, !ledger.globalPaused, at()));
                    }}
                  >
                    {ledger.globalPaused ? "Resume vault" : "Pause vault"}
                  </button>
                  <button
                    type="button"
                    className={ghost}
                    onClick={() => {
                      localStorage.removeItem(KEY);
                      setLedger(freshLedger());
                      setPending(null);
                      setLastProof(null);
                      setNote("Sandbox reset. Chain config is unchanged.");
                    }}
                  >
                    Reset sandbox
                  </button>
                </div>
              </section>

              <section className="rounded-lg border border-line p-4">
                <h2 className="text-sm font-medium">Aevum</h2>
                <p className="mt-1 text-sm text-muted">
                  {configured
                    ? "Vault address is set. Live mode writes to that contract."
                    : "Chain settings are loaded. The vault, escrow, router, and auth addresses are still empty — deploy, then record them in the SDK config. Live mode will not invent a transaction."}
                </p>
                <dl className="mt-3 space-y-2 font-mono text-xs">
                  <ConfigRow k="chain" v={String(chainId)} />
                  <ConfigRow k="rpc" v={rpcUrl} />
                  <ConfigRow k="explorer" v={explorerUrl} />
                  <ConfigRow k="faucet" v={faucetUrl} />
                  <ConfigRow k="token" v={tusd8} />
                  <ConfigRow k="decimals" v={String(tusd8Decimals)} />
                  <ConfigRow k="vault" v={contracts.vault || "not deployed"} />
                  <ConfigRow k="wallet" v={isConnected ? `${shortAddr(wallet ?? "")} · ${walletChain ?? "—"}` : "not connected"} />
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  {isConnected ? null : (
                    <button
                      type="button"
                      className={primary}
                      disabled={isPending || connectors.length === 0}
                      onClick={() => {
                        const connector = connectors[0];
                        if (connector) void connect({ connector, chainId });
                      }}
                    >
                      Connect wallet
                    </button>
                  )}
                  {isConnected && walletChain !== chainId ? (
                    <button type="button" className={ghost} onClick={() => void switchChainAsync({ chainId })}>
                      Switch to Aevum
                    </button>
                  ) : null}
                </div>
              </section>
            </div>
          ) : null}

          {tab === "agents" ? (
            <div className="mt-4 space-y-4">
              <section className="rounded-lg border border-line p-4">
                <h2 className="text-sm font-medium">Approve an agent</h2>
                <p className="mt-1 font-mono text-xs text-muted">
                  {DEFAULT_AGENT.label} · {shortAddr(DEFAULT_AGENT.address)}
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-muted">
                    Per transaction
                    <input className={`${field} mt-1`} inputMode="numeric" value={perTx} onChange={(e) => setPerTx(e.target.value.replace(/[^\d]/g, ""))} />
                  </label>
                  <label className="text-xs text-muted">
                    Rolling day
                    <input className={`${field} mt-1`} inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value.replace(/[^\d]/g, ""))} />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {DIRECTORY.map((p) => {
                    const on = allow.includes(p.address);
                    return (
                      <button
                        key={p.address}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setAllow(on ? allow.filter((a) => a !== p.address) : [...allow, p.address])}
                        className={`min-h-11 rounded-lg border px-3 text-sm ${on ? "border-seal bg-seal text-paper" : "border-line text-ink"}`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <button type="button" className={`${primary} mt-3`} disabled={!ready} onClick={onRegister}>
                  {agent?.active ? "Update policy" : "Approve agent"}
                </button>
              </section>

              {agent ? (
                <section className="rounded-lg border border-line p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-medium">{agent.label}</h2>
                      <p className="font-mono text-xs text-muted">{shortAddr(agent.address)}</p>
                    </div>
                    <span className={`font-mono text-xs ${agent.active && !agent.paused ? "text-treasury" : "text-stamp"}`}>
                      {!agent.active ? "revoked" : agent.paused ? "paused" : ledger.globalPaused ? "vault paused" : "live"}
                    </span>
                  </div>
                  <p className="mt-3 font-mono text-sm">
                    {left} left today · cap {agent.dailyLimit} · per tx {agent.perTxLimit}
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                    <div className="h-full bg-seal" style={{ width: `${agent.dailyLimit === 0 ? 0 : Math.min(100, (spent / agent.dailyLimit) * 100)}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Allowlist: {agent.allowAny ? "any payee" : agent.allow.map((a) => labelOf(a)).join(", ") || "empty"}
                  </p>
                  {clock != null && agent.active ? (
                    <p className="mt-1 text-xs text-muted">
                      {explainPolicy(agent, DIRECTORY[0].address, 180, clock, ledger.globalPaused) ?? "180 tUSD8 to Acme would clear."}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={ghost}
                      disabled={!agent.active || busy}
                      onClick={() => {
                        if (!asRole("owner")) return;
                        if (live) {
                          void liveSend(agent.paused ? "Resume agent" : "Pause agent", (pc, wc) => pauseAgentOnVault(pc, wc, asAddress(agent.address), !agent.paused));
                          return;
                        }
                        apply(setPaused(ledger, !agent.paused, at()));
                      }}
                    >
                      {agent.paused ? "Resume" : "Pause"}
                    </button>
                    <button type="button" className={dangerBtn} disabled={!agent.active} onClick={onRevoke}>
                      Revoke
                    </button>
                    <button type="button" className={ghost} onClick={onBlock}>
                      Try 180
                    </button>
                  </div>
                </section>
              ) : (
                <p className="rounded-lg border border-line px-4 py-6 text-sm text-muted">No agent yet. Approve payables-1 and the key can only spend inside that policy.</p>
              )}

              <section className="rounded-lg border border-line p-4">
                <h2 className="text-sm font-medium">Recurring</h2>
                <p className="mt-1 text-sm text-muted">A keeper calls execute when due. A late call pays once, then waits a full interval — missed runs are not caught up.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <label className="text-xs text-muted">
                    Amount
                    <input className={`${field} mt-1`} inputMode="numeric" value={schedAmt} onChange={(e) => setSchedAmt(e.target.value.replace(/[^\d]/g, ""))} />
                  </label>
                  <label className="text-xs text-muted">
                    Payee
                    <select className={`${field} mt-1`} value={schedPayee} onChange={(e) => setSchedPayee(e.target.value)}>
                      {DIRECTORY.map((p) => (
                        <option key={p.address} value={p.address}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-muted">
                    Every
                    <select className={`${field} mt-1`} value={schedEvery} onChange={(e) => setSchedEvery(e.target.value)}>
                      <option value={String(HOUR_MS)}>hour</option>
                      <option value={String(24 * HOUR_MS)}>day</option>
                      <option value={String(7 * 24 * HOUR_MS)}>week</option>
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className={`${primary} mt-3`}
                  disabled={!ready}
                  onClick={() => {
                    if (!asRole("owner")) return;
                    const runs = Number(schedEvery) >= 7 * 24 * HOUR_MS ? 12 : 6;
                    if (live) {
                      void liveSend("Add schedule", (pc, wc) =>
                        createScheduleOnVault(
                          pc,
                          wc,
                          asAddress(agent?.address ?? DEFAULT_AGENT.address),
                          asAddress(schedPayee),
                          wholeToBase(Number(schedAmt)),
                          BigInt(Math.floor(Number(schedEvery) / 1000)),
                          runs,
                          "recurring",
                        ),
                      );
                      return;
                    }
                    apply(
                      createSchedule(
                        ledger,
                        { payee: schedPayee, amount: Number(schedAmt), intervalMs: Number(schedEvery), maxRuns: runs, memo: "recurring", byAgent: false },
                        at(),
                      ),
                    );
                  }}
                >
                  Add schedule
                </button>
                <ul className="mt-4 space-y-2">
                  {ledger.schedules.length === 0 ? <li className="text-sm text-muted">No schedules.</li> : null}
                  {ledger.schedules.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
                      <div>
                        <p className="text-sm">
                          #{s.id} · {s.amount} tUSD8 → {labelOf(s.payee)}
                        </p>
                        <p className="font-mono text-xs text-muted">
                          {s.runs}/{s.maxRuns} · {s.active ? "active" : "closed"}
                        </p>
                      </div>
                      {s.active ? (
                        <button
                          type="button"
                          className={ghost}
                          disabled={busy}
                          onClick={() => {
                            if (live) {
                              void liveSend(`Execute #${s.id}`, (pc, wc) => executeScheduleOnVault(pc, wc, BigInt(s.id)));
                              return;
                            }
                            apply(executeSchedule(ledger, s.id, at()));
                          }}
                        >
                          Execute
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : null}

          {tab === "pay" ? (
            <div className="mt-4 space-y-4">
              <section className="rounded-lg border border-line p-4">
                <h2 className="text-sm font-medium">Invoices</h2>
                <ul className="mt-3 space-y-3">
                  {ledger.invoices.map((inv) => (
                    <li key={inv.id} className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="font-mono text-sm">{inv.id}</p>
                        <p className={`font-mono text-xs ${inv.status === "released" ? "text-treasury" : inv.status === "disputed" || inv.status === "refunded" ? "text-stamp" : "text-muted"}`}>
                          {inv.status}
                        </p>
                      </div>
                      <p className="mt-1 text-sm">{inv.metadata}</p>
                      <p className="font-mono text-xs text-muted">
                        {inv.amount} tUSD8 · {labelOf(inv.payee)} · due {format(inv.due, "MMM d")}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {inv.status === "open" ? (
                          <button type="button" className={primary} onClick={() => onFundInvoice(inv.id)}>
                            Agent funds escrow
                          </button>
                        ) : null}
                        {inv.status === "funded" ? (
                          <button type="button" className={primary} onClick={() => asRole("payee") && apply(markDelivered(ledger, inv.id, at()))}>
                            Mark delivered
                          </button>
                        ) : null}
                        {inv.status === "delivered" ? (
                          <button type="button" className={primary} onClick={() => asRole("owner") && apply(confirmInvoice(ledger, inv.id, at()))}>
                            Confirm release
                          </button>
                        ) : null}
                        {inv.status === "funded" || inv.status === "delivered" ? (
                          <button type="button" className={ghost} onClick={() => { asRole(role === "owner" ? "owner" : "payee"); apply(disputeInvoice(ledger, inv.id, at())); }}>
                            Dispute
                          </button>
                        ) : null}
                        {inv.status === "disputed" ? (
                          <>
                            <button type="button" className={primary} onClick={() => asRole("arbiter") && apply(resolveInvoice(ledger, inv.id, true, at()))}>
                              Arbiter pays
                            </button>
                            <button type="button" className={ghost} onClick={() => asRole("arbiter") && apply(resolveInvoice(ledger, inv.id, false, at()))}>
                              Arbiter refunds
                            </button>
                          </>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="rounded-lg border border-line p-4">
                <h2 className="text-sm font-medium">x402 · DataRelay oracle</h2>
                <p className="mt-1 text-sm text-muted">The resource answers 402 with a price. The agent pays from the vault, retries with the tx proof, and the server refuses a reused proof.</p>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-paper p-3 font-mono text-xs leading-relaxed text-muted">
{`GET /v1/oracle
← 402  price 25 tUSD8  base ${wholeToBase(25).toString()}  payTo ${shortAddr(DIRECTORY[1].address)}
← token tUSD8  chain ${chainId}  decimals ${tusd8Decimals}`}
                </pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={primary} onClick={onBuy}>
                    Agent buys
                  </button>
                  <button
                    type="button"
                    className={ghost}
                    disabled={!lastProof}
                    onClick={() => lastProof && apply(replayProof(ledger, lastProof, at()))}
                  >
                    Replay proof
                  </button>
                </div>
                {ledger.x402[0].purchases[0] ? (
                  <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-treasury">{ledger.x402[0].purchases[0].body}</p>
                ) : null}
              </section>
            </div>
          ) : null}

          {tab === "activity" ? (
            <div className="mt-4 space-y-4 lg:hidden">
              {receipts.length > 0 ? (
                <ul className="rounded-lg border border-line p-3">
                  {receipts.map((item) => (
                    <li key={item.id} className="border-b border-line py-3 last:border-b-0">
                      <p className={`text-sm ${item.ok ? "text-ink" : "text-stamp"}`}>{item.title}</p>
                      {item.hashes.length === 0 ? <p className="mt-1 text-sm text-muted">{item.detail}</p> : null}
                      {item.hashes.map((hash) => (
                        <a key={hash} className="mt-1 block truncate font-mono text-xs text-seal" href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">
                          {hash}
                        </a>
                      ))}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Feed feed={ledger.feed} clock={clock} />
            </div>
          ) : null}
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-4 space-y-4">
            {receipts.length > 0 ? (
              <div className="rounded-lg border border-line bg-surface p-4">
                <h2 className="text-sm font-medium">Chain receipts</h2>
                <ul>
                  {receipts.map((item) => (
                    <li key={item.id} className="border-b border-line py-3 last:border-b-0">
                      <p className={`text-sm ${item.ok ? "text-ink" : "text-stamp"}`}>{item.title}</p>
                      {item.hashes.length === 0 ? <p className="mt-1 text-sm text-muted">{item.detail}</p> : null}
                      {item.hashes.map((hash) => (
                        <a key={hash} className="mt-1 block truncate font-mono text-xs text-seal" href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">
                          {hash}
                        </a>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-medium">{live ? "Simulation feed" : "Feed"}</h2>
              <Feed feed={ledger.feed} clock={clock} />
            </div>
          </div>
        </aside>
      </div>

      <form
        className="sticky bottom-0 border-t border-line bg-paper px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseUtterance(utterance);
          if (parsed.error || !parsed.action) {
            setPending(null);
            setNote(parsed.error ?? "Nothing to run.");
            return;
          }
          setPending(parsed.action);
          setNote(null);
        }}
      >
        <div className="mx-auto max-w-6xl">
          {pending ? (
            <div className="mb-3 rounded-lg border border-line bg-surface p-3">
              <p className="font-mono text-xs text-muted">Parsed intent. A model cannot submit this. Execute uses the same policy path as the buttons.</p>
              <pre className="mt-2 overflow-x-auto font-mono text-xs text-ink">{JSON.stringify(pending, null, 2)}</pre>
              <p className="mt-2 text-sm">{describeAction(pending)}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primary}
                  onClick={() => {
                    runAction(pending);
                    setPending(null);
                  }}
                >
                  Execute
                </button>
                <button type="button" className={ghost} onClick={() => setPending(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          <label className="text-xs text-muted" htmlFor="ask">
            Tell the agent
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              id="ask"
              className={field}
              value={utterance}
              onChange={(e) => setUtterance(e.target.value)}
              placeholder="pay Acme Studio 120 tUSD8 for invoice INV-0142"
            />
            <button type="submit" className={primary}>
              Parse
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}

function ConfigRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5">
      <dt className="text-muted">{k}</dt>
      <dd className="truncate text-ink">{v || "—"}</dd>
    </div>
  );
}

function Feed({ feed, clock }: { feed: FeedItem[]; clock: number | null }) {
  if (feed.length === 0) {
    return <p className="py-6 text-sm text-muted">No payments yet. Fund the vault, approve an agent, then let it try.</p>;
  }
  return (
    <ul>
      {feed.map((item) => (
        <li key={item.id} className="feed-item border-b border-line py-3 last:border-b-0">
          <div className="flex items-baseline justify-between gap-3">
            <p className={`text-sm ${item.ok ? "text-ink" : "text-stamp"}`}>{item.title}</p>
            <time className="shrink-0 font-mono text-xs text-muted">{clock == null ? "" : rel(item.ts, clock)}</time>
          </div>
          <p className="mt-1 text-sm text-muted">{item.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function rel(ts: number, clock: number): string {
  const mins = Math.round((clock - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function FloatApp() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Console />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
