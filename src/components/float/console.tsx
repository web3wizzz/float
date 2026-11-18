import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
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
  type Agent,
  type FeedItem,
  type Ledger,
  type Result,
} from "@/lib/float/ledger";
import { describeAction, parseUtterance, type AgentAction } from "@/lib/float/parse";
import type { ConsoleTab } from "@/lib/float/tabs";
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
import { fieldClass, formatClock, formatDay, money, NAV } from "./format";
import { Btn, Empty, Field, Mark, NavLink, Rule, Sheet } from "./ui";

type Role = "owner" | "agent" | "payee" | "arbiter";
type Mode = "simulation" | "live";
type Confirm = "revoke" | "reset" | null;

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

function agentState(agent: Agent, globalPaused: boolean): string {
  if (!agent.active) return "Revoked";
  if (globalPaused) return "Vault paused";
  if (agent.paused) return "Paused";
  return "Can spend";
}

export function Console({ tab }: { tab: ConsoleTab }) {
  const navigate = useNavigate();
  const [ledger, setLedger] = useState<Ledger>(freshLedger);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [role, setRole] = useState<Role>("owner");
  const [amount, setAmount] = useState("1000");
  const [perTx, setPerTx] = useState("150");
  const [daily, setDaily] = useState("400");
  const [expiryDays, setExpiryDays] = useState("0");
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
  const [busyTitle, setBusyTitle] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirm>(null);
  const { address: wallet, chainId: walletChain, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: aevumTestnet.id });
  const { data: walletClient } = useWalletClient({ chainId: aevumTestnet.id });

  const live = mode === "live";

  function go(next: ConsoleTab) {
    void navigate({ to: "/", search: { tab: next } });
  }

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
    if (!entry.ok) go("activity");
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
    setBusyTitle(title);
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
      setBusyTitle(null);
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
    const expiry = expiryDays === "0" ? 0 : at() + Number(expiryDays) * 24 * HOUR_MS;
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
          expiry,
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
    if (!result.ok) go("activity");
  }

  function onNorthwind() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Try Northwind", (pc, wc) => payFromVault(pc, wc, asAddress(DIRECTORY[2].address), wholeToBase(10), "northwind"));
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[2].address, amount: 10, memo: "northwind" }, at()));
    go("activity");
  }

  function onBlock() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Over per-tx", (pc, wc) => payFromVault(pc, wc, asAddress(DIRECTORY[0].address), wholeToBase(180), "over per-tx"));
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[0].address, amount: 180, memo: "over per-tx" }, at()));
    go("activity");
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
          ? `Vault ${ledger.balance} tUSD8. ${available(ledger)} free. ${ledger.reserved} reserved. ${agent.label} has ${left} left today.`
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
          go("invoices");
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
    go("send");
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
    { id: "agent", label: "Approve payables-1", detail: "150 per transaction, 400 a day", done: !live && ledger.agents.length > 0, run: () => onRegister() },
    { id: "invoice", label: "Pay INV-0142", detail: "120 into escrow", done: !live && ledger.invoices[0]?.status !== "open", run: () => onFundInvoice("INV-0142") },
    { id: "x402", label: "Buy the oracle", detail: "402, 25 tUSD8", done: !live && ledger.x402[0].purchases.length > 0, run: onBuy },
    { id: "northwind", label: "Try Northwind", detail: "PayeeNotAllowed", done: northwindRejected, run: onNorthwind },
    { id: "block", label: "Hit the per-tx cap", detail: "180 is refused", done: capRejected, run: onBlock },
    { id: "revoke", label: "Revoke the agent", detail: "Spend stops immediately", done: !live && ledger.agents.some((a) => !a.active), run: onRevoke },
  ];
  const nextStep = steps.find((s) => !s.done);

  function connectWallet() {
    const connector = connectors[0];
    if (connector) void connect({ connector, chainId });
  }

  function togglePauseAgent() {
    if (!agent) return;
    if (!asRole("owner")) return;
    if (live) {
      void liveSend(agent.paused ? "Resume agent" : "Pause agent", (pc, wc) => pauseAgentOnVault(pc, wc, asAddress(agent.address), !agent.paused));
      return;
    }
    apply(setPaused(ledger, !agent.paused, at()));
  }

  function toggleVault() {
    if (!asRole("owner")) return;
    if (live) {
      void liveSend(ledger.globalPaused ? "Resume vault" : "Pause vault", (pc, wc) => pauseVaultOnVault(pc, wc, !ledger.globalPaused));
      return;
    }
    apply(setGlobalPaused(ledger, !ledger.globalPaused, at()));
  }

  const modeCopy = live
    ? configured
      ? `Live on Aevum, chain ${chainId}. Each action is simulated, then sent. A blocked action shows the contract revert.`
      : `Live on Aevum, chain ${chainId}. The vault address is empty, so sends stop before a transaction.`
    : "Simulation. This ledger stays on this device. It is not a transaction on Aevum.";

  return (
    <div className="relative min-h-screen bg-abyss text-foam lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <a href="#vault" className="skip">
        Skip to vault
      </a>
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto border-r border-line bg-panel px-4 py-5 lg:flex">
        <Brand />
        <div className="mt-6">
          <ModeSwitch live={live} onChange={setMode} />
        </div>
        <RoleSelect role={role} onChange={setRole} />
        <p className="num mt-3 text-xs text-mist">{clock == null ? "—" : formatClock(clock)}</p>
        {!live && ledger.offsetMs !== 0 ? (
          <p className="text-xs text-signal">Simulation clock plus {Math.round(ledger.offsetMs / HOUR_MS)} hours</p>
        ) : null}
        <nav className="mt-6 flex flex-col gap-1" aria-label="Sections">
          {NAV.map((item) => (
            <NavLink key={item.id} {...item} current={tab === item.id} layout="side" />
          ))}
        </nav>
        <div className="mt-auto pt-6">
          <WalletControls
            isConnected={isConnected}
            isPending={isPending}
            connectors={connectors.length}
            wallet={wallet}
            walletChain={walletChain}
            onConnect={connectWallet}
            onSwitch={() => void switchChainAsync({ chainId })}
          />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="border-b border-line bg-panel px-4 py-3 lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <Brand compact />
            <WalletControls
              compact
              isConnected={isConnected}
              isPending={isPending}
              connectors={connectors.length}
              wallet={wallet}
              walletChain={walletChain}
              onConnect={connectWallet}
              onSwitch={() => void switchChainAsync({ chainId })}
            />
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_8.5rem] gap-2">
            <ModeSwitch live={live} onChange={setMode} />
            <RoleSelect role={role} onChange={setRole} compact />
          </div>
        </header>

        <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-28 lg:px-8 lg:pt-8 lg:pb-12">
          <p className="text-sm text-mist">{modeCopy}</p>
          <div aria-live="polite">
            {busyTitle ? <p className="mt-3 text-sm text-foam">Sending {busyTitle}…</p> : null}
            {note ? (
              <div role="status" className="mt-3 flex items-start justify-between gap-3 border border-line bg-panel px-3 py-2">
                <p className="min-w-0 text-sm text-foam">{note}</p>
                <button type="button" className="pressable min-h-11 shrink-0 px-2 text-sm text-mist" onClick={() => setNote(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}
          </div>
          {ledger.globalPaused ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-bad bg-panel px-3 py-3">
              <p className="text-sm text-foam">The vault is paused. Agents cannot spend until you resume it.</p>
              <Btn tone="desk" variant="danger" disabled={busy} onClick={toggleVault}>
                Resume vault
              </Btn>
            </div>
          ) : null}

          <main id="vault" className="mt-4" aria-busy={!ready || busy}>
            {!ready ? (
              <SkeletonSheet />
            ) : tab === "home" ? (
              <HomeSheet
                ledger={ledger}
                live={live}
                isConnected={isConnected}
                wallet={wallet}
                walletChain={walletChain}
                agent={agent}
                spent={spent}
                left={left}
                clock={clock}
                steps={steps}
                nextId={nextStep?.id}
                busy={busy}
                confirming={confirming}
                onConfirm={setConfirming}
                onPauseAgent={togglePauseAgent}
                onRevoke={onRevoke}
                onTryCap={onBlock}
              />
            ) : tab === "send" ? (
              <SendSheet
                amount={amount}
                setAmount={setAmount}
                busy={busy}
                live={live}
                ready={ready}
                globalPaused={ledger.globalPaused}
                onDeposit={() => onDeposit()}
                onWithdraw={onWithdraw}
                onToggleVault={toggleVault}
                onAdvance={() => {
                  setLedger({ ...ledger, offsetMs: ledger.offsetMs + 25 * HOUR_MS });
                  setNote("Simulation clock jumped 25 hours. Yesterday’s spend has rolled out of the window.");
                }}
                confirming={confirming}
                onConfirm={setConfirming}
                onReset={() => {
                  localStorage.removeItem(KEY);
                  setLedger(freshLedger());
                  setPending(null);
                  setLastProof(null);
                  setNote("Sandbox reset. Chain config is unchanged.");
                }}
                utterance={utterance}
                setUtterance={setUtterance}
                pending={pending}
                onParse={() => {
                  const parsed = parseUtterance(utterance);
                  if (parsed.error || !parsed.action) {
                    setPending(null);
                    setNote(parsed.error ?? "Nothing to run.");
                    return;
                  }
                  setPending(parsed.action);
                  setNote(null);
                }}
                onExecute={() => {
                  if (!pending) return;
                  runAction(pending);
                  setPending(null);
                }}
                onDismiss={() => setPending(null)}
                schedAmt={schedAmt}
                setSchedAmt={setSchedAmt}
                schedPayee={schedPayee}
                setSchedPayee={setSchedPayee}
                schedEvery={schedEvery}
                setSchedEvery={setSchedEvery}
                schedules={ledger.schedules}
                clock={clock}
                onAddSchedule={() => {
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
                onExecuteSchedule={(id) => {
                  if (live) {
                    void liveSend(`Execute #${id}`, (pc, wc) => executeScheduleOnVault(pc, wc, BigInt(id)));
                    return;
                  }
                  apply(executeSchedule(ledger, id, at()));
                }}
              />
            ) : tab === "invoices" ? (
              <InvoiceSheet
                ledger={ledger}
                busy={busy}
                lastProof={lastProof}
                onFund={onFundInvoice}
                onDelivered={(id) => asRole("payee") && apply(markDelivered(ledger, id, at()))}
                onConfirm={(id) => asRole("owner") && apply(confirmInvoice(ledger, id, at()))}
                onDispute={(id) => {
                  asRole(role === "owner" ? "owner" : "payee");
                  apply(disputeInvoice(ledger, id, at()));
                }}
                onPay={(id) => asRole("arbiter") && apply(resolveInvoice(ledger, id, true, at()))}
                onRefund={(id) => asRole("arbiter") && apply(resolveInvoice(ledger, id, false, at()))}
                onBuy={onBuy}
                onReplay={() => lastProof && apply(replayProof(ledger, lastProof, at()))}
              />
            ) : tab === "agents" ? (
              <AgentsSheet
                agent={agent}
                perTx={perTx}
                setPerTx={setPerTx}
                daily={daily}
                setDaily={setDaily}
                expiryDays={expiryDays}
                setExpiryDays={setExpiryDays}
                allow={allow}
                setAllow={setAllow}
                live={live}
                ready={ready}
                busy={busy}
                spent={spent}
                left={left}
                clock={clock}
                globalPaused={ledger.globalPaused}
                confirming={confirming}
                onConfirm={setConfirming}
                onRegister={onRegister}
                onPause={togglePauseAgent}
                onRevoke={onRevoke}
                onTryCap={onBlock}
              />
            ) : (
              <ActivitySheet feed={ledger.feed} receipts={receipts} clock={clock} />
            )}
          </main>
        </div>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-panel px-1 pt-1 lg:hidden"
        style={{ paddingBottom: "max(0.25rem, env(safe-area-inset-bottom))" }}
        aria-label="Sections"
      >
        {NAV.map((item) => (
          <NavLink key={item.id} {...item} current={tab === item.id} layout="bar" />
        ))}
      </nav>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" search={{ tab: "home" }} className="flex min-w-0 items-center gap-3">
      <Mark className="size-10 shrink-0" />
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold tracking-tight text-foam" translate="no">
          Float
        </span>
        {compact ? null : (
          <span className="mt-0.5 block text-xs leading-snug text-mist">Give your agents a float, not your keys.</span>
        )}
      </span>
    </Link>
  );
}

function ModeSwitch({ live, onChange }: { live: boolean; onChange: (mode: Mode) => void }) {
  return (
    <div role="group" aria-label="Ledger mode" className="grid grid-cols-2 gap-1 rounded-md border border-line p-1">
      <button
        type="button"
        aria-pressed={!live}
        onClick={() => onChange("simulation")}
        className={`pressable min-h-11 rounded-[4px] px-2 text-sm font-medium ${!live ? "bg-signal text-signal-ink" : "text-mist"}`}
      >
        Simulation
      </button>
      <button
        type="button"
        aria-pressed={live}
        onClick={() => onChange("live")}
        className={`pressable min-h-11 rounded-[4px] px-2 text-sm font-medium ${live ? "bg-signal text-signal-ink" : "text-mist"}`}
      >
        Live
      </button>
    </div>
  );
}

function RoleSelect({
  role,
  onChange,
  compact = false,
}: {
  role: Role;
  onChange: (role: Role) => void;
  compact?: boolean;
}) {
  return (
    <label className={`${compact ? "" : "mt-4 block"} text-xs text-mist`}>
      {compact ? <span className="sr-only">Acting as</span> : "Acting as"}
      <select
        name="role"
        aria-label={compact ? "Acting as" : undefined}
        className="mt-1 min-h-11 w-full rounded-md border border-line bg-abyss px-2 text-sm text-foam"
        value={role}
        onChange={(e) => onChange(e.target.value as Role)}
      >
        <option value="owner">Owner</option>
        <option value="agent">Agent</option>
        <option value="payee">Payee</option>
        <option value="arbiter">Arbiter</option>
      </select>
    </label>
  );
}

function WalletControls({
  isConnected,
  isPending,
  connectors,
  wallet,
  walletChain,
  onConnect,
  onSwitch,
  compact = false,
}: {
  isConnected: boolean;
  isPending: boolean;
  connectors: number;
  wallet?: string;
  walletChain?: number;
  onConnect: () => void;
  onSwitch: () => void;
  compact?: boolean;
}) {
  if (!isConnected && connectors === 0) {
    return (
      <div>
        <Btn tone="desk" variant="secondary" disabled className={compact ? "px-3" : "w-full"}>
          No wallet in this browser
        </Btn>
        {compact ? null : <p className="mt-2 text-xs text-mist">Install a wallet that injects into this browser, then connect.</p>}
      </div>
    );
  }
  if (!isConnected) {
    return (
      <Btn tone="desk" disabled={isPending} onClick={onConnect} className={compact ? "px-3" : "w-full"}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </Btn>
    );
  }
  return (
    <div className={compact ? "text-right" : ""}>
      <p className="font-mono text-xs text-foam" translate="no">
        {shortAddr(wallet ?? "")}
      </p>
      <p className="text-xs text-mist">Chain {walletChain ?? "unknown"}</p>
      {walletChain !== chainId ? (
        <Btn tone="desk" variant="secondary" className="mt-2 w-full" onClick={onSwitch}>
          Switch to Aevum
        </Btn>
      ) : null}
    </div>
  );
}

function SkeletonSheet() {
  return (
    <Sheet label="Loading the vault">
      <div className="skeleton h-4 w-28 rounded-sm" />
      <div className="skeleton mt-4 h-12 w-48 rounded-sm" />
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="skeleton h-12 rounded-sm" />
        <div className="skeleton h-12 rounded-sm" />
      </div>
      <div className="skeleton mt-8 h-24 rounded-sm" />
      <p className="sr-only">Loading the vault…</p>
    </Sheet>
  );
}

function HomeSheet(props: {
  ledger: Ledger;
  live: boolean;
  isConnected: boolean;
  wallet?: string;
  walletChain?: number;
  agent: Agent | undefined;
  spent: number;
  left: number;
  clock: number | null;
  steps: { id: string; label: string; detail: string; done: boolean; run: () => void }[];
  nextId?: string;
  busy: boolean;
  confirming: Confirm;
  onConfirm: (value: Confirm) => void;
  onPauseAgent: () => void;
  onRevoke: () => void;
  onTryCap: () => void;
}) {
  const { ledger, live, isConnected, wallet, walletChain, agent } = props;
  const walletLine = live
    ? isConnected
      ? `Wallet ${shortAddr(wallet ?? "")}, chain ${walletChain ?? "unknown"}. This figure is the sandbox ledger, not the contract balance.`
      : "No wallet connected. This figure is the sandbox ledger, not the contract balance."
    : "Sandbox ledger on this device.";

  return (
    <Sheet>
      <h1 className="text-sm font-medium text-slip-muted">Vault balance</h1>
      <p className="num mt-2 text-5xl font-semibold tracking-tight text-ink sm:text-6xl">{money(ledger.balance)}</p>
      <p className="mt-1 text-sm text-slip-muted" translate="no">
        tUSD8
      </p>
      <dl className="mt-6 flex gap-10 border-t border-line-slip pt-4">
        <div>
          <dt className="text-sm text-slip-muted">Free</dt>
          <dd className="num text-xl font-medium text-ink">{money(available(ledger))}</dd>
        </div>
        <div>
          <dt className="text-sm text-slip-muted">Reserved</dt>
          <dd className="num text-xl font-medium text-ink">{money(ledger.reserved)}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-slip-muted">{walletLine}</p>

      <Rule title="Mandate">
        <Mandate
          agent={agent}
          spent={props.spent}
          left={props.left}
          clock={props.clock}
          globalPaused={ledger.globalPaused}
          busy={props.busy}
          confirming={props.confirming}
          onConfirm={props.onConfirm}
          onPauseAgent={props.onPauseAgent}
          onRevoke={props.onRevoke}
          onTryCap={props.onTryCap}
          invite
        />
      </Rule>

      <Rule title="Operator path">
        <ol>
          {props.steps.map((step, index) => {
            const current = step.id === props.nextId;
            return (
              <li key={step.id} className="flex items-center justify-between gap-3 border-b border-line-slip py-3 last:border-b-0">
                <div className="min-w-0">
                  <p className={`text-sm ${step.done ? "text-slip-muted" : "text-ink"}`}>
                    <span className="num mr-2 inline-block w-4 text-slip-muted">{index + 1}</span>
                    {step.label}
                  </p>
                  <p className="truncate pl-6 text-xs text-slip-muted">{step.detail}</p>
                </div>
                {step.done ? <span className="text-sm font-medium text-good-ink">Done</span> : null}
                {current ? (
                  <Btn disabled={props.busy} onClick={step.run} aria-label={`Run ${step.label}`}>
                    Run
                  </Btn>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Rule>

      <Rule title="Network">
        <dl className="space-y-2 font-mono text-xs">
          <ConfigRow k="Chain" v={String(chainId)} />
          <ConfigRow k="RPC" v={rpcUrl} />
          <ConfigRow k="Token" v={`${tusd8}, ${tusd8Decimals} decimals`} />
          <ConfigRow k="Vault" v={contracts.vault || "Not deployed"} />
          <ConfigRow k="Escrow" v={contracts.escrow || "Not deployed"} />
          <ConfigRow k="Router" v={contracts.router || "Not deployed"} />
          <ConfigRow k="Auth" v={contracts.auth || "Not deployed"} />
        </dl>
        <p className="mt-3 text-sm text-slip-muted">
          {configured
            ? "The vault address is set. Live mode writes to that contract."
            : "Chain settings are loaded. Deploy the contracts, then record the addresses in the SDK config. Live mode will not invent a transaction."}
        </p>
        <p className="mt-2 flex flex-wrap gap-4 text-sm">
          <a className="text-ink underline decoration-line-slip underline-offset-4" href={explorerUrl} target="_blank" rel="noreferrer">
            Explorer
          </a>
          <a className="text-ink underline decoration-line-slip underline-offset-4" href={faucetUrl} target="_blank" rel="noreferrer">
            Faucet
          </a>
        </p>
      </Rule>
    </Sheet>
  );
}

function Mandate({
  agent,
  spent,
  left,
  clock,
  globalPaused,
  busy,
  confirming,
  onConfirm,
  onPauseAgent,
  onRevoke,
  onTryCap,
  ledgerPaused,
  invite = false,
}: {
  agent: Agent | undefined;
  spent: number;
  left: number;
  clock: number | null;
  globalPaused?: boolean;
  ledgerPaused?: boolean;
  busy: boolean;
  confirming: Confirm;
  onConfirm: (value: Confirm) => void;
  onPauseAgent: () => void;
  onRevoke: () => void;
  onTryCap: () => void;
  invite?: boolean;
}) {
  const paused = globalPaused ?? ledgerPaused ?? false;
  if (!agent) {
    return (
      <div>
        <Empty title="No agent can spend yet.">
          Approve payables-1 with a per-transaction cap, a daily limit, and an allowlist. Pause or revoke that right whenever you want the key to stop.
        </Empty>
        {invite ? (
          <Link to="/" search={{ tab: "agents" }} className="pressable btn-slip mt-3 inline-flex min-h-11 items-center rounded-md border border-line-slip px-4 text-sm font-medium text-ink">
            Approve an agent
          </Link>
        ) : null}
      </div>
    );
  }
  const ratio = agent.dailyLimit === 0 ? 0 : Math.min(1, spent / agent.dailyLimit);
  const capAt = agent.dailyLimit === 0 ? 0 : Math.min(1, agent.perTxLimit / agent.dailyLimit);
  const expired = agent.expiry !== 0 && clock != null && clock > agent.expiry;
  const state = agentState(agent, paused);
  const calm = state === "Can spend";
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink" translate="no">
            {agent.label}
          </p>
          <p className="font-mono text-xs text-slip-muted" translate="no">
            {shortAddr(agent.address)}
          </p>
        </div>
        <p className={`text-sm font-medium ${calm ? "text-good-ink" : "text-bad-ink"}`}>{state}</p>
      </div>
      <p className="num mt-4 text-2xl font-medium text-ink">
        {money(left)} <span className="text-base font-normal text-slip-muted">left today</span>
      </p>
      <div
        className="relative mt-3 h-2 bg-line-slip"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={agent.dailyLimit}
        aria-valuenow={spent}
        aria-label="Daily limit used"
      >
        <div className="waterline h-full bg-ink" style={{ transform: `scaleX(${ratio})` }} />
        <span className="absolute top-[-4px] h-4 w-0.5 bg-signal" style={{ left: `${capAt * 100}%` }} aria-hidden="true" />
      </div>
      <p className="mt-2 text-xs text-slip-muted">The fill is the rolling day. The mark is one payment, the per-transaction cap.</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slip-muted">Per transaction</dt>
          <dd className="num font-medium text-ink">{money(agent.perTxLimit)}</dd>
        </div>
        <div>
          <dt className="text-slip-muted">Daily limit</dt>
          <dd className="num font-medium text-ink">
            {money(spent)} of {money(agent.dailyLimit)}
          </dd>
        </div>
        <div>
          <dt className="text-slip-muted">Expiry</dt>
          <dd className={`font-medium ${expired ? "text-bad-ink" : "text-ink"}`}>
            {agent.expiry === 0 ? "No expiry" : expired ? `Expired ${formatDay(agent.expiry)}` : formatDay(agent.expiry)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-slip-muted">
        Allowlist: {agent.allowAny ? "any payee" : agent.allow.map((item) => labelOf(item)).join(", ") || "empty"}
      </p>
      {clock != null && agent.active ? (
        <p className="mt-2 text-sm text-ink">
        {(() => {
          const reason = explainPolicy(agent, DIRECTORY[0].address, 180, clock, paused);
          return reason ? `180 tUSD8 to Acme would be refused. ${reason}` : "180 tUSD8 to Acme would clear.";
        })()}
      </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Btn variant="secondary" disabled={!agent.active || busy} onClick={onPauseAgent}>
          {agent.paused ? "Resume agent" : "Pause agent"}
        </Btn>
        {confirming === "revoke" ? (
          <>
            <Btn
              variant="danger"
              onClick={() => {
                onConfirm(null);
                onRevoke();
              }}
            >
              Confirm revoke
            </Btn>
            <Btn variant="secondary" onClick={() => onConfirm(null)}>
              Cancel
            </Btn>
          </>
        ) : (
          <Btn variant="danger" disabled={!agent.active} onClick={() => onConfirm("revoke")}>
            Revoke agent
          </Btn>
        )}
        <Btn variant="secondary" disabled={busy} onClick={onTryCap}>
          Try 180 tUSD8
        </Btn>
      </div>
    </div>
  );
}

function ConfigRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-slip py-1.5">
      <dt className="font-sans text-slip-muted">{k}</dt>
      <dd className="min-w-0 truncate text-ink" translate="no">
        {v || "—"}
      </dd>
    </div>
  );
}

function SendSheet(props: {
  amount: string;
  setAmount: (value: string) => void;
  busy: boolean;
  live: boolean;
  ready: boolean;
  globalPaused: boolean;
  onDeposit: () => void;
  onWithdraw: () => void;
  onToggleVault: () => void;
  onAdvance: () => void;
  confirming: Confirm;
  onConfirm: (value: Confirm) => void;
  onReset: () => void;
  utterance: string;
  setUtterance: (value: string) => void;
  pending: AgentAction | null;
  onParse: () => void;
  onExecute: () => void;
  onDismiss: () => void;
  schedAmt: string;
  setSchedAmt: (value: string) => void;
  schedPayee: string;
  setSchedPayee: (value: string) => void;
  schedEvery: string;
  setSchedEvery: (value: string) => void;
  schedules: Ledger["schedules"];
  clock: number | null;
  onAddSchedule: () => void;
  onExecuteSchedule: (id: number) => void;
}) {
  return (
    <Sheet>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Send</h1>
      <p className="mt-1 text-sm text-slip-muted">Move tUSD8 in or out, or tell the agent what to pay. The vault still enforces the mandate.</p>
      <Rule title="Move funds">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field id="amount" label="Amount">
              <input
                id="amount"
                name="amount"
                inputMode="numeric"
                autoComplete="off"
                className={fieldClass}
                value={props.amount}
                onChange={(e) => props.setAmount(e.target.value.replace(/[^\d]/g, ""))}
              />
            </Field>
          </div>
          <Btn disabled={!props.ready || props.busy} onClick={props.onDeposit}>
            Deposit
          </Btn>
          <Btn variant="secondary" disabled={!props.ready || props.busy} onClick={props.onWithdraw}>
            Withdraw
          </Btn>
        </div>
      </Rule>
      <Rule title="Tell the agent">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            props.onParse();
          }}
        >
          <Field id="ask" label="Sentence">
            <input
              id="ask"
              name="utterance"
              autoComplete="off"
              spellCheck={false}
              className={fieldClass}
              value={props.utterance}
              placeholder="pay Acme Studio 120 tUSD8…"
              onChange={(e) => props.setUtterance(e.target.value)}
            />
          </Field>
          <Btn type="submit" className="mt-3">
            Parse intent
          </Btn>
        </form>
        {props.pending ? (
          <div className="mt-4 border border-line-slip bg-field p-3">
            <p className="text-sm text-slip-muted">Parsed intent. A model cannot submit this. Execute uses the same policy path as the buttons.</p>
            <pre className="mt-2 overflow-x-auto font-mono text-xs text-ink">{JSON.stringify(props.pending, null, 2)}</pre>
            <p className="mt-2 text-sm text-ink">{describeAction(props.pending)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn onClick={props.onExecute}>Execute</Btn>
              <Btn variant="secondary" onClick={props.onDismiss}>
                Dismiss
              </Btn>
            </div>
          </div>
        ) : null}
      </Rule>
      <Rule title="Schedules">
        <p className="text-sm text-slip-muted">A keeper calls execute when a payment is due. A late call pays once, then waits a full interval. Missed runs are not caught up.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Field id="sched-amt" label="Amount">
            <input id="sched-amt" name="schedule-amount" inputMode="numeric" autoComplete="off" className={fieldClass} value={props.schedAmt} onChange={(e) => props.setSchedAmt(e.target.value.replace(/[^\d]/g, ""))} />
          </Field>
          <Field id="sched-payee" label="Payee">
            <select id="sched-payee" name="schedule-payee" className={fieldClass} value={props.schedPayee} onChange={(e) => props.setSchedPayee(e.target.value)}>
              {DIRECTORY.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="sched-every" label="Every">
            <select id="sched-every" name="schedule-every" className={fieldClass} value={props.schedEvery} onChange={(e) => props.setSchedEvery(e.target.value)}>
              <option value={String(HOUR_MS)}>Hour</option>
              <option value={String(24 * HOUR_MS)}>Day</option>
              <option value={String(7 * 24 * HOUR_MS)}>Week</option>
            </select>
          </Field>
        </div>
        <Btn className="mt-3" disabled={!props.ready || props.busy} onClick={props.onAddSchedule}>
          Add schedule
        </Btn>
        <ul className="mt-4">
          {props.schedules.length === 0 ? (
            <li>
              <Empty title="No schedules.">Add one when a payee should be paid on a clock, inside the same caps.</Empty>
            </li>
          ) : null}
          {props.schedules.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line-slip py-3">
              <div className="min-w-0">
                <p className="text-sm text-ink">
                  #{item.id}, {money(item.amount)} tUSD8 to {labelOf(item.payee)}
                </p>
                <p className="font-mono text-xs text-slip-muted">
                  {item.runs} of {item.maxRuns}, {item.active ? "active" : "closed"}
                  {props.clock != null && item.active ? `, next ${formatDay(item.nextRun)}` : ""}
                </p>
              </div>
              {item.active ? (
                <Btn variant="secondary" disabled={props.busy} onClick={() => props.onExecuteSchedule(item.id)}>
                  Execute schedule
                </Btn>
              ) : null}
            </li>
          ))}
        </ul>
      </Rule>
      <Rule title="Vault controls">
        <div className="flex flex-wrap gap-2">
          <Btn variant="secondary" disabled={props.live} onClick={props.onAdvance}>
            Advance 25 hours
          </Btn>
          <Btn variant="danger" disabled={props.busy} onClick={props.onToggleVault}>
            {props.globalPaused ? "Resume vault" : "Pause vault"}
          </Btn>
          {props.confirming === "reset" ? (
            <>
              <Btn
                variant="danger"
                onClick={() => {
                  props.onConfirm(null);
                  props.onReset();
                }}
              >
                Confirm reset
              </Btn>
              <Btn variant="secondary" onClick={() => props.onConfirm(null)}>
                Cancel
              </Btn>
            </>
          ) : (
            <Btn variant="secondary" onClick={() => props.onConfirm("reset")}>
              Reset sandbox
            </Btn>
          )}
        </div>
        {props.live ? <p className="mt-2 text-xs text-slip-muted">The simulation clock only moves in simulation.</p> : null}
      </Rule>
    </Sheet>
  );
}

function InvoiceSheet({
  ledger,
  busy,
  lastProof,
  onFund,
  onDelivered,
  onConfirm,
  onDispute,
  onPay,
  onRefund,
  onBuy,
  onReplay,
}: {
  ledger: Ledger;
  busy: boolean;
  lastProof: string | null;
  onFund: (id: string) => void;
  onDelivered: (id: string) => void;
  onConfirm: (id: string) => void;
  onDispute: (id: string) => void;
  onPay: (id: string) => void;
  onRefund: (id: string) => void;
  onBuy: () => void;
  onReplay: () => void;
}) {
  return (
    <Sheet>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Invoices</h1>
      <p className="mt-1 text-sm text-slip-muted">Escrow holds the funds until the owner confirms, or an arbiter resolves a dispute.</p>
      {ledger.invoices.length === 0 ? (
        <Empty title="No invoices.">Open invoices show up here with the amount, the payee, and the next action.</Empty>
      ) : (
        <ul className="mt-4">
          {ledger.invoices.map((inv) => (
            <li key={inv.id} className="border-t border-line-slip py-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-mono text-sm text-ink" translate="no">
                  {inv.id}
                </p>
                <p className={`text-sm font-medium ${inv.status === "released" ? "text-good-ink" : inv.status === "disputed" || inv.status === "refunded" ? "text-bad-ink" : "text-slip-muted"}`}>
                  {inv.status}
                </p>
              </div>
              <p className="mt-1 text-sm text-ink">{inv.metadata}</p>
              <p className="num text-sm text-slip-muted">
                {money(inv.amount)} tUSD8 to {labelOf(inv.payee)}, due {formatDay(inv.due)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {inv.status === "open" ? (
                  <Btn disabled={busy} onClick={() => onFund(inv.id)}>
                    Fund escrow
                  </Btn>
                ) : null}
                {inv.status === "funded" ? (
                  <Btn disabled={busy} onClick={() => onDelivered(inv.id)}>
                    Mark delivered
                  </Btn>
                ) : null}
                {inv.status === "delivered" ? (
                  <Btn disabled={busy} onClick={() => onConfirm(inv.id)}>
                    Confirm release
                  </Btn>
                ) : null}
                {inv.status === "funded" || inv.status === "delivered" ? (
                  <Btn variant="secondary" disabled={busy} onClick={() => onDispute(inv.id)}>
                    Dispute
                  </Btn>
                ) : null}
                {inv.status === "disputed" ? (
                  <>
                    <Btn disabled={busy} onClick={() => onPay(inv.id)}>
                      Arbiter pays
                    </Btn>
                    <Btn variant="secondary" disabled={busy} onClick={() => onRefund(inv.id)}>
                      Arbiter refunds
                    </Btn>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Rule title="Pay per call">
        <p className="text-sm text-ink">DataRelay oracle</p>
        <p className="mt-1 text-sm text-slip-muted">The resource answers 402 with a price. The agent pays from the vault, retries with the transaction proof, and the server refuses a reused proof.</p>
        <pre className="mt-3 overflow-x-auto border border-line-slip bg-field p-3 font-mono text-xs leading-relaxed text-slip-muted">
{`GET /v1/oracle
← 402  price 25 tUSD8  base ${wholeToBase(25).toString()}  payTo ${shortAddr(DIRECTORY[1].address)}
← token tUSD8  chain ${chainId}  decimals ${tusd8Decimals}`}
        </pre>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn disabled={busy} onClick={onBuy}>
            Buy the oracle
          </Btn>
          <Btn variant="secondary" disabled={!lastProof || busy} onClick={onReplay}>
            Replay proof
          </Btn>
        </div>
        {ledger.x402[0].purchases[0] ? (
          <p className="mt-3 border border-line-slip px-3 py-2 font-mono text-xs text-good-ink">{ledger.x402[0].purchases[0].body}</p>
        ) : (
          <p className="mt-3 text-sm text-slip-muted">No purchase yet. Buy the oracle and the snapshot lands here.</p>
        )}
      </Rule>
    </Sheet>
  );
}

function AgentsSheet(props: {
  agent: Agent | undefined;
  perTx: string;
  setPerTx: (value: string) => void;
  daily: string;
  setDaily: (value: string) => void;
  expiryDays: string;
  setExpiryDays: (value: string) => void;
  allow: string[];
  setAllow: (value: string[]) => void;
  live: boolean;
  ready: boolean;
  busy: boolean;
  spent: number;
  left: number;
  clock: number | null;
  globalPaused: boolean;
  confirming: Confirm;
  onConfirm: (value: Confirm) => void;
  onRegister: () => void;
  onPause: () => void;
  onRevoke: () => void;
  onTryCap: () => void;
}) {
  return (
    <Sheet>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Agents</h1>
      <p className="mt-1 text-sm text-slip-muted">
        <span translate="no">{DEFAULT_AGENT.label}</span> spends only inside the cap, the daily limit, and the allowlist.
      </p>
      <p className="mt-1 font-mono text-xs text-slip-muted" translate="no">
        {shortAddr(DEFAULT_AGENT.address)}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field id="per-tx" label="Per transaction">
          <input id="per-tx" name="per-tx" inputMode="numeric" autoComplete="off" className={fieldClass} value={props.perTx} onChange={(e) => props.setPerTx(e.target.value.replace(/[^\d]/g, ""))} />
        </Field>
        <Field id="daily" label="Daily limit">
          <input id="daily" name="daily" inputMode="numeric" autoComplete="off" className={fieldClass} value={props.daily} onChange={(e) => props.setDaily(e.target.value.replace(/[^\d]/g, ""))} />
        </Field>
        <Field id="expiry" label="Expiry">
          <select id="expiry" name="expiry" className={fieldClass} value={props.expiryDays} onChange={(e) => props.setExpiryDays(e.target.value)}>
            <option value="0">No expiry</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </select>
        </Field>
      </div>
      {props.live ? <p className="mt-2 text-xs text-slip-muted">Live approval does not set an expiry. The contract call sends 0.</p> : null}
      <p className="mt-4 text-sm text-slip-muted">Allowlist</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {DIRECTORY.map((entry) => {
          const on = props.allow.includes(entry.address);
          return (
            <button
              key={entry.address}
              type="button"
              aria-pressed={on}
              onClick={() => props.setAllow(on ? props.allow.filter((item) => item !== entry.address) : [...props.allow, entry.address])}
              className={`pressable min-h-11 rounded-md border px-3 text-sm ${on ? "border-signal bg-signal text-signal-ink" : "border-line-slip text-ink"}`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <Btn className="mt-4" disabled={!props.ready || props.busy} onClick={props.onRegister}>
        {props.agent?.active ? "Update policy" : "Approve agent"}
      </Btn>
      <Rule title="Current mandate">
        <Mandate
          agent={props.agent}
          spent={props.spent}
          left={props.left}
          clock={props.clock}
          globalPaused={props.globalPaused}
          busy={props.busy}
          confirming={props.confirming}
          onConfirm={props.onConfirm}
          onPauseAgent={props.onPause}
          onRevoke={props.onRevoke}
          onTryCap={props.onTryCap}
        />
      </Rule>
    </Sheet>
  );
}

function ActivitySheet({ feed, receipts, clock }: { feed: FeedItem[]; receipts: Receipt[]; clock: number | null }) {
  return (
    <Sheet>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Activity</h1>
      {receipts.length > 0 ? (
        <Rule title="Chain receipts">
          <ul>
            {receipts.map((item) => (
              <li key={item.id} className="border-b border-line-slip py-3 last:border-b-0">
                <p className={`text-sm ${item.ok ? "text-ink" : "text-bad-ink"}`}>{item.title}</p>
                {item.hashes.length === 0 ? <p className="mt-1 text-sm text-slip-muted">{item.detail}</p> : null}
                {item.hashes.map((hash) => (
                  <a key={hash} className="mt-1 block truncate font-mono text-xs text-ink underline decoration-line-slip" href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer" translate="no">
                    {hash}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </Rule>
      ) : null}
      <div className={receipts.length > 0 ? "mt-6 border-t border-line-slip pt-5" : "mt-4"}>
        {receipts.length > 0 ? <h2 className="text-base font-semibold text-ink">Feed</h2> : null}
        {feed.length === 0 ? (
          <Empty title="No payments yet.">Fund the vault, approve an agent, then let it try. Refusals land here too, with the reason.</Empty>
        ) : (
          <ul>
            {feed.map((item) => (
              <li key={item.id} className="feed-item border-b border-line-slip py-3 last:border-b-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className={`text-sm ${item.ok ? "text-ink" : "text-bad-ink"}`}>{item.title}</p>
                  <time className="num shrink-0 text-xs text-slip-muted">{clock == null ? "" : rel(item.ts, clock)}</time>
                </div>
                <p className="mt-1 text-sm text-slip-muted">{item.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
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

export function FloatApp({ tab }: { tab: ConsoleTab }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Console tab={tab} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
