import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createConfig,
  http,
  useAccount,
  useConnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
  WagmiProvider,
} from "wagmi";
import { injected } from "wagmi/connectors";
import type { Address } from "viem";
import { chainId, explorerUrl, isHexAddress, rpcUrl, aevumTestnet } from "@/lib/float/config";
import { DEFAULT_AGENT, DIRECTORY, shortAddr } from "@/lib/float/directory";
import {
  DAY_MS,
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
  type Ledger,
  type Result,
} from "@/lib/float/ledger";
import { parseUtterance, type AgentAction } from "@/lib/float/parse";
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
import { digits } from "./format";
import {
  ConsoleView,
  type Banner,
  type Mode,
  type Receipt,
  type Role,
  type Screen,
  type Step,
} from "./view";

export type { Screen };

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
    if (!parsed || !Array.isArray(parsed.invoices) || !Array.isArray(parsed.agents))
      return freshLedger();
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

export function Console({
  screen,
  onScreen,
}: {
  screen: Screen;
  onScreen: (screen: Screen) => void;
}) {
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
  const [banner, setBanner] = useState<Banner | null>(null);
  const [schedPayee, setSchedPayee] = useState(DIRECTORY[0].address);
  const [schedAmt, setSchedAmt] = useState("5");
  const [schedEvery, setSchedEvery] = useState(String(HOUR_MS));
  const [sendPayee, setSendPayee] = useState(DIRECTORY[0].address);
  const [sendAmt, setSendAmt] = useState("10");
  const [sendMemo, setSendMemo] = useState("");
  const [lastProof, setLastProof] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("simulation");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "revoke" | "reset">(null);
  const [theme, setTheme] = useState<"day" | "night" | null>(null);
  const [intro, setIntro] = useState(true);
  const { address: wallet, chainId: walletChain, isConnected } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: aevumTestnet.id });
  const { data: walletClient } = useWalletClient({ chainId: aevumTestnet.id });

  const live = mode === "live";

  useEffect(() => {
    setLedger(loadLedger(localStorage.getItem(KEY)));
    setNow(Date.now());
    setReady(true);
    setTheme(document.documentElement.dataset.theme === "night" ? "night" : "day");
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setIntro(false), 320);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(KEY, JSON.stringify(ledger));
  }, [ledger, ready]);

  useEffect(() => {
    if (connectError) setBanner({ tone: "bad", text: connectError.message });
  }, [connectError]);

  useEffect(() => {
    const titles: Record<Screen, string> = {
      home: "Float",
      send: "Send — Float",
      invoices: "Invoices — Float",
      agents: "Agents — Float",
      activity: "Activity — Float",
    };
    document.title = titles[screen];
  }, [screen]);

  const clock = now == null ? null : now + ledger.offsetMs;
  const agent = ledger.agents.find((item) => item.active) ?? ledger.agents[0];
  const spent = agent && clock != null ? spentInWindow(agent, clock) : 0;
  const left = agent ? Math.max(0, agent.dailyLimit - spent) : 0;

  function at(): number {
    return (now ?? Date.now()) + ledger.offsetMs;
  }

  function say(text: string, tone: Banner["tone"] = "info") {
    setBanner({ text, tone });
  }

  function apply(result: Result, extra?: string) {
    setLedger(result.ledger);
    say(extra ?? result.message, result.ok ? "ok" : "bad");
    if (result.proof) setLastProof(result.proof);
  }

  function record(entry: Omit<Receipt, "id">) {
    setReceipts((prev) => [{ ...entry, id: Date.now() }, ...prev].slice(0, 12));
    say(entry.detail, entry.ok ? "ok" : "bad");
    if (!entry.ok) onScreen("activity");
  }

  async function liveSend(
    title: string,
    run: (
      pc: NonNullable<typeof publicClient>,
      wc: NonNullable<typeof walletClient>,
    ) => Promise<TxResult>,
  ) {
    if (!publicClient || !walletClient) {
      record({
        ok: false,
        title,
        detail: "Connect a wallet on Aevum before sending a transaction.",
        hashes: [],
      });
      return;
    }
    if (walletChain !== chainId) {
      try {
        await switchChainAsync({ chainId });
      } catch (err) {
        record({
          ok: false,
          title,
          detail: err instanceof Error ? err.message : "Could not switch to Aevum.",
          hashes: [],
        });
        return;
      }
    }
    setBusy(true);
    try {
      const result = await run(publicClient, walletClient);
      if (result.ok) {
        record({
          ok: true,
          title,
          detail: result.hashes.map((hash) => `${explorerUrl}/tx/${hash}`).join(" "),
          hashes: [...result.hashes],
        });
      } else {
        record({ ok: false, title, detail: result.reason, hashes: [] });
      }
    } catch (err) {
      record({
        ok: false,
        title,
        detail: err instanceof Error ? err.message : "reverted",
        hashes: [],
      });
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
    const expiry = !live && expiryDays !== "0" ? at() + Number(expiryDays) * DAY_MS : 0;
    if (live) {
      void liveSend("Approve agent", (pc, wc) =>
        registerOnVault(
          pc,
          wc,
          asAddress(DEFAULT_AGENT.address),
          wholeToBase(Number(perTx)),
          wholeToBase(Number(daily)),
          allow.filter(isHexAddress),
        ),
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
      void liveSend(`Fund ${id}`, (pc, wc) =>
        fundInvoiceOnVault(pc, wc, BigInt(inv?.numericId ?? 1)),
      );
      return;
    }
    apply(fundInvoice(ledger, id, at()));
  }

  function onBuy() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Buy oracle", (pc, wc) =>
        payFromVault(pc, wc, asAddress(DIRECTORY[1].address), wholeToBase(25), "x402"),
      );
      return;
    }
    const result = buyX402(ledger, "oracle", at());
    apply(result);
    if (!result.ok) onScreen("activity");
  }

  function onNorthwind() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Try Northwind", (pc, wc) =>
        payFromVault(pc, wc, asAddress(DIRECTORY[2].address), wholeToBase(10), "northwind"),
      );
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[2].address, amount: 10, memo: "northwind" }, at()));
    onScreen("activity");
  }

  function onBlock() {
    if (!asRole("agent")) return;
    if (live) {
      void liveSend("Over per-tx", (pc, wc) =>
        payFromVault(pc, wc, asAddress(DIRECTORY[0].address), wholeToBase(180), "over per-tx"),
      );
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[0].address, amount: 180, memo: "over per-tx" }, at()));
    onScreen("activity");
  }

  function doRevoke() {
    if (!asRole("owner")) return;
    if (live) {
      void liveSend("Revoke", (pc, wc) =>
        revokeOnVault(pc, wc, asAddress(agent?.address ?? DEFAULT_AGENT.address)),
      );
      return;
    }
    apply(revokeAgent(ledger, at()));
  }

  function onSend() {
    if (!asRole("agent")) return;
    const value = Number(sendAmt);
    if (live) {
      void liveSend("Pay", (pc, wc) =>
        payFromVault(pc, wc, asAddress(sendPayee), wholeToBase(value), sendMemo),
      );
      return;
    }
    apply(pay(ledger, { payee: sendPayee, amount: value, memo: sendMemo }, at()));
  }

  function runAction(action: AgentAction) {
    if (live) {
      void runLiveAction(action);
      return;
    }
    const ts = at();
    if (action.type === "balance") {
      say(
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
      setConfirm("revoke");
      return;
    }
    if (action.type === "x402") {
      onBuy();
      return;
    }
    if (action.type === "pay") {
      if (!asRole("agent")) return;
      if (action.memo?.startsWith("INV-")) {
        const inv = ledger.invoices.find((item) => item.id === action.memo);
        if (inv && inv.status === "open" && inv.amount === action.amount) {
          apply(fundInvoice(ledger, inv.id, ts));
          onScreen("invoices");
          return;
        }
      }
      apply(
        pay(ledger, { payee: action.payee, amount: action.amount, memo: action.memo ?? "" }, ts),
      );
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
    onScreen("agents");
  }

  async function runLiveAction(action: AgentAction) {
    const who = asAddress(agent?.address ?? DEFAULT_AGENT.address);
    if (action.type === "balance") {
      say("The contract is the balance. This screen shows the sandbox ledger.");
      return;
    }
    if (action.type === "pause") {
      await liveSend("Pause agent", (pc, wc) => pauseAgentOnVault(pc, wc, who, true));
      return;
    }
    if (action.type === "revoke") {
      setConfirm("revoke");
      return;
    }
    if (action.type === "x402") {
      await liveSend("Buy oracle", (pc, wc) =>
        payFromVault(pc, wc, asAddress(DIRECTORY[1].address), wholeToBase(25), "x402"),
      );
      return;
    }
    if (action.type === "pay") {
      if (action.memo?.startsWith("INV-")) {
        const inv = ledger.invoices.find((item) => item.id === action.memo);
        await liveSend(`Fund ${action.memo}`, (pc, wc) =>
          fundInvoiceOnVault(pc, wc, BigInt(inv?.numericId ?? 1)),
        );
        return;
      }
      await liveSend("Pay", (pc, wc) =>
        payFromVault(
          pc,
          wc,
          asAddress(action.payee),
          wholeToBase(action.amount),
          action.memo ?? "",
        ),
      );
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

  function onParse() {
    const parsed = parseUtterance(utterance);
    if (parsed.error || !parsed.action) {
      setPending(null);
      say(parsed.error ?? "Nothing to run.", "bad");
      return;
    }
    setPending(parsed.action);
    setBanner(null);
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "night" ? "day" : "night";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("float-theme", next);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next === "night" ? "#0E1916" : "#E4E8E2");
    setTheme(next);
  }

  const northwindRejected =
    ledger.feed.some((item) => /PayeeNotAllowed/.test(item.detail)) ||
    receipts.some((item) => /PayeeNotAllowed/.test(item.detail));
  const capRejected =
    ledger.feed.some((item) => /Per-transaction/.test(item.detail)) ||
    receipts.some((item) => /PerTxLimitExceeded|Per-transaction/.test(item.detail));

  const steps: Step[] = [
    {
      id: "fund",
      label: "Fund the vault",
      detail: "1,000 tUSD8",
      done:
        !live &&
        (ledger.balance > 0 || ledger.feed.some((item) => item.title.startsWith("Deposited"))),
      current: false,
    },
    {
      id: "agent",
      label: "Approve payables-1",
      detail: "150 per transaction, 400 a day",
      done: !live && ledger.agents.length > 0,
      current: false,
    },
    {
      id: "invoice",
      label: "Pay INV-0142",
      detail: "120 into escrow",
      done: !live && ledger.invoices[0]?.status !== "open",
      current: false,
    },
    {
      id: "x402",
      label: "Buy the oracle",
      detail: "402 at 25 tUSD8",
      done: !live && ledger.x402[0].purchases.length > 0,
      current: false,
    },
    {
      id: "northwind",
      label: "Try Northwind",
      detail: "PayeeNotAllowed",
      done: northwindRejected,
      current: false,
    },
    {
      id: "block",
      label: "Hit the per-transaction cap",
      detail: "180 is refused",
      done: capRejected,
      current: false,
    },
    {
      id: "revoke",
      label: "Revoke the agent",
      detail: "Spend stops immediately",
      done: !live && ledger.agents.some((item) => !item.active),
      current: false,
    },
  ];
  const nextId = steps.find((step) => !step.done)?.id;
  for (const step of steps) step.current = step.id === nextId;

  const policyLine =
    agent && clock != null && agent.active
      ? (explainPolicy(agent, DIRECTORY[0].address, 180, clock, ledger.globalPaused) ??
        "180 tUSD8 to Acme Studio would clear.")
      : null;

  return (
    <ConsoleView
      screen={screen}
      ready={ready}
      live={live}
      theme={theme}
      onToggleTheme={toggleTheme}
      onMode={setMode}
      clock={clock}
      offsetMs={live ? 0 : ledger.offsetMs}
      banner={banner}
      busy={busy}
      intro={intro}
      role={role}
      onRole={setRole}
      ledger={ledger}
      agent={agent}
      spent={spent}
      left={left}
      policyLine={policyLine}
      walletConnected={Boolean(ready && isConnected)}
      walletLabel={isConnected ? `${shortAddr(wallet ?? "")} on chain ${walletChain ?? "—"}` : ""}
      wrongChain={Boolean(isConnected && walletChain !== chainId)}
      connecting={isPending}
      onConnect={() => {
        const connector = connectors[0];
        if (!connector) {
          say("No browser wallet in this window. Simulation still runs.", "bad");
          return;
        }
        void connect({ connector, chainId });
      }}
      onSwitchChain={() => void switchChainAsync({ chainId })}
      steps={steps}
      onRunStep={(id) => {
        if (id === "fund") onDeposit(1000);
        else if (id === "agent") onRegister();
        else if (id === "invoice") onFundInvoice("INV-0142");
        else if (id === "x402") onBuy();
        else if (id === "northwind") onNorthwind();
        else if (id === "block") onBlock();
        else if (id === "revoke") setConfirm("revoke");
      }}
      amount={amount}
      onAmount={(value) => setAmount(digits(value))}
      onDeposit={() => onDeposit()}
      onWithdraw={onWithdraw}
      onAdvance={() => {
        setLedger({ ...ledger, offsetMs: ledger.offsetMs + 25 * HOUR_MS });
        say("Simulation clock jumped 25 hours. Yesterday’s spend has rolled out of the window.");
      }}
      onToggleVaultPause={() => {
        if (!asRole("owner")) return;
        if (live) {
          void liveSend(ledger.globalPaused ? "Resume vault" : "Pause vault", (pc, wc) =>
            pauseVaultOnVault(pc, wc, !ledger.globalPaused),
          );
          return;
        }
        apply(setGlobalPaused(ledger, !ledger.globalPaused, at()));
      }}
      confirm={confirm}
      onAskConfirm={setConfirm}
      onCancelConfirm={() => setConfirm(null)}
      onConfirm={() => {
        const which = confirm;
        setConfirm(null);
        if (which === "revoke") doRevoke();
        if (which === "reset") {
          localStorage.removeItem(KEY);
          setLedger(freshLedger());
          setPending(null);
          setLastProof(null);
          say("Sandbox reset. Chain config is unchanged.");
        }
      }}
      sendPayee={sendPayee}
      onSendPayee={setSendPayee}
      sendAmt={sendAmt}
      onSendAmt={(value) => setSendAmt(digits(value))}
      sendMemo={sendMemo}
      onSendMemo={setSendMemo}
      onSend={onSend}
      utterance={utterance}
      onUtterance={setUtterance}
      onParse={onParse}
      pending={pending}
      onExecute={() => {
        if (!pending) return;
        runAction(pending);
        setPending(null);
      }}
      onDismiss={() => setPending(null)}
      perTx={perTx}
      onPerTx={(value) => setPerTx(digits(value))}
      daily={daily}
      onDaily={(value) => setDaily(digits(value))}
      expiryDays={expiryDays}
      onExpiryDays={setExpiryDays}
      allow={allow}
      onToggleAllow={(address) =>
        setAllow(
          allow.includes(address) ? allow.filter((item) => item !== address) : [...allow, address],
        )
      }
      onRegister={onRegister}
      onPauseAgent={() => {
        if (!agent) return;
        if (!asRole("owner")) return;
        if (live) {
          void liveSend(agent.paused ? "Resume agent" : "Pause agent", (pc, wc) =>
            pauseAgentOnVault(pc, wc, asAddress(agent.address), !agent.paused),
          );
          return;
        }
        apply(setPaused(ledger, !agent.paused, at()));
      }}
      onTryCap={onBlock}
      schedAmt={schedAmt}
      onSchedAmt={(value) => setSchedAmt(digits(value))}
      schedPayee={schedPayee}
      onSchedPayee={setSchedPayee}
      schedEvery={schedEvery}
      onSchedEvery={setSchedEvery}
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
            {
              payee: schedPayee,
              amount: Number(schedAmt),
              intervalMs: Number(schedEvery),
              maxRuns: runs,
              memo: "recurring",
              byAgent: false,
            },
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
      onFund={onFundInvoice}
      onDelivered={(id) => {
        if (!asRole("payee")) return;
        apply(markDelivered(ledger, id, at()));
      }}
      onConfirmInvoice={(id) => {
        if (!asRole("owner")) return;
        apply(confirmInvoice(ledger, id, at()));
      }}
      onDispute={(id) => {
        asRole(role === "owner" ? "owner" : "payee");
        apply(disputeInvoice(ledger, id, at()));
      }}
      onArbiter={(id, release) => {
        if (!asRole("arbiter")) return;
        apply(resolveInvoice(ledger, id, release, at()));
      }}
      onBuy={onBuy}
      onReplay={() => {
        if (lastProof) apply(replayProof(ledger, lastProof, at()));
      }}
      lastProof={lastProof}
      receipts={receipts}
    />
  );
}

export function FloatApp({
  screen,
  onScreen,
}: {
  screen: Screen;
  onScreen: (screen: Screen) => void;
}) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Console screen={screen} onScreen={onScreen} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
