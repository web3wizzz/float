import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Activity, ArrowUp, ArrowUpRight, Bot, FileText, MessageSquare, Moon, Repeat, Settings, Sun, Wallet, X } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createConfig, http, useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Address } from "viem";
import { chainId, configured, explorerUrl, aevumTestnet, isHexAddress, rpcUrl, tusd8Decimals } from "@/lib/float/config";
import { DEFAULT_AGENT, DIRECTORY, labelOf, resolvePayee, shortAddr } from "@/lib/float/directory";
import { localAgent, localAgentKey } from "@/lib/float/agent-key";
import {
  HOUR_MS,
  DAY_MS,
  available,
  buyX402,
  cancelSchedule,
  confirmInvoice,
  createSchedule,
  deposit,
  disputeInvoice,
  executeSchedule,
  explainPolicy,
  freshLedger,
  fundInvoice,
  markDelivered,
  openInvoice,
  pay,
  registerAgent,
  replayProof,
  resolveInvoice,
  revokeAgent,
  sendAsYou,
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
  executeAgentIntent,
  executeScheduleOnVault,
  pauseAgentOnVault,
  pauseVaultOnVault,
  payAsOwnerOnVault,
  registerOnVault,
  revokeOnVault,
  readAgentActive,
  readVaultAvailable,
  readVaultPayments,
  wholeToBase,
  withdrawFromVault,
  type TxResult,
} from "../../../packages/sdk/src/vault.ts";

type Tab = "chat" | "home" | "send" | "invoices" | "agents" | "activity";

interface Receipt {
  id: number;
  ok: boolean;
  title: string;
  detail: string;
  hashes: string[];
}

interface ThreadMsg {
  id: number;
  role: "you" | "agent";
  text: string;
  action?: AgentAction;
  decision?: "approved" | "declined";
}

const queryClient = new QueryClient();
const wagmiConfig = createConfig({
  chains: [aevumTestnet],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: { [aevumTestnet.id]: http(rpcUrl) },
  ssr: true,
});

const WALLETS: { id: string; name: string; match: RegExp; open: (page: string) => string | null }[] = [
  { id: "metamask", name: "MetaMask", match: /metamask/i, open: (page) => `https://metamask.app.link/dapp/${page}` },
  {
    id: "phantom",
    name: "Phantom",
    match: /phantom/i,
    open: (page) => {
      const url = encodeURIComponent(`https://${page}`);
      return `https://phantom.app/ul/browse/${url}?ref=${url}`;
    },
  },
  { id: "rabby", name: "Rabby", match: /rabby/i, open: () => null },
  { id: "rainbow", name: "Rainbow", match: /rainbow/i, open: (page) => `https://rnbwapp.com/browser?url=${encodeURIComponent(`https://${page}`)}` },
  { id: "coinbase", name: "Coinbase", match: /coinbase/i, open: (page) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(`https://${page}`)}` },
  { id: "trust", name: "Trust", match: /trust/i, open: (page) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(`https://${page}`)}` },
  {
    id: "okx",
    name: "OKX",
    match: /okx|okex/i,
    open: (page) => `https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encodeURIComponent(`https://${page}`)}`)}`,
  },
  { id: "brave", name: "Brave", match: /brave/i, open: () => null },
];

function WalletGlyph({ id }: { id: string }) {
  return <img src={`/wallets/${id}.svg`} alt="" className="size-10" />;
}
const KEY = "float-ledger-v1";
const NAME_KEY = "float.user-name";
const field =
  "field min-h-11 w-full rounded-lg bg-paper px-3 font-mono text-sm text-ink outline-none";
const THEME_KEY = "float.theme";
const primary =
  "press min-h-12 rounded-xl bg-seal px-4 text-sm font-medium text-on-seal disabled:opacity-40";
const ghost =
  "press min-h-11 rounded-lg bg-surface px-4 text-sm text-ink shadow-plane disabled:opacity-40";
const dangerBtn =
  "press min-h-11 rounded-lg bg-surface px-4 text-sm text-stamp shadow-plane disabled:opacity-40";
const iconBtn =
  "press grid size-11 shrink-0 place-items-center rounded-lg bg-surface text-ink shadow-plane";

const NAV: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "home", label: "Wallet", icon: Wallet },
  { id: "invoices", label: "Invoices", icon: FileText },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "activity", label: "Activity", icon: Activity },
];

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

function formatTusd(amount: number): string {
  return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function whoOf(actor?: string): string {
  if (!actor || actor === "you") return "You";
  return actor;
}

function digits(value: string): string {
  return value.replace(/[^\d]/g, "");
}

export function Console({ surface = "app" }: { surface?: "app" | "tour" }) {
  const [ledger, setLedger] = useState<Ledger>(freshLedger);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [named, setNamed] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [now, setNow] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [fundAmt, setFundAmt] = useState("1000");
  const [perTx, setPerTx] = useState("150");
  const [daily, setDaily] = useState("400");
  const [expiryDays, setExpiryDays] = useState("");
  const [agentLabel, setAgentLabel] = useState(DEFAULT_AGENT.label);
  const [agentAddr, setAgentAddr] = useState(DEFAULT_AGENT.address);
  const [allow, setAllow] = useState<string[]>([DIRECTORY[0].address, DIRECTORY[1].address]);
  const [showAdd, setShowAdd] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [vaultAgents, setVaultAgents] = useState<Record<string, boolean>>({});
  const [settled, setSettled] = useState(0);
  const [utterance, setUtterance] = useState("send 5 tUSD8 to DataRelay every week");
  const [pending, setPending] = useState<AgentAction | null>(null);
  const [thread, setThread] = useState<ThreadMsg[]>([]);
  const composerRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [walletsOpen, setWalletsOpen] = useState(false);
  const [intro, setIntro] = useState(surface === "app");
  const [note, setNote] = useState<string | null>(null);
  const [contact, setContact] = useState(DIRECTORY[1].address);
  const [customPayee, setCustomPayee] = useState("");
  const [sendAmt, setSendAmt] = useState("5");
  const [memo, setMemo] = useState("");
  const [sendMode, setSendMode] = useState<"once" | "repeat">("once");
  const [review, setReview] = useState<{ payee: string; amount: number; memo: string; repeat: boolean } | null>(null);
  const [showRequest, setShowRequest] = useState(false);
  const [draftPayee, setDraftPayee] = useState(DIRECTORY[0].address);
  const [draftAmt, setDraftAmt] = useState("40");
  const [draftMemo, setDraftMemo] = useState("");
  const [lastProof, setLastProof] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [chainPays, setChainPays] = useState<Awaited<ReturnType<typeof readVaultPayments>>>([]);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [slip, setSlip] = useState<{ title: string; amount?: number; who?: string; hash?: string } | null>(null);
  const { address: wallet, chainId: walletChain, connector, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { switchChainAsync } = useSwitchChain();

  async function openAevum() {
    try {
      await switchChainAsync({ chainId });
      return;
    } catch {
      // The wallet does not have Aevum yet. Ask it to add the chain.
    }
    const provider = (await connector?.getProvider()) as { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | undefined;
    if (!provider?.request) {
      setNote("This wallet cannot add Aevum. Use one that allows a custom network.");
      return;
    }
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${chainId.toString(16)}`,
            chainName: aevumTestnet.name,
            nativeCurrency: aevumTestnet.nativeCurrency,
            rpcUrls: [rpcUrl],
            blockExplorerUrls: [explorerUrl],
          },
        ],
      });
      await switchChainAsync({ chainId });
    } catch {
      setNote("This wallet will not add Aevum. Phantom only allows its own networks. Use MetaMask or Rabby.");
    }
  }

  function chooseWallet(id: string) {
    setWalletsOpen(false);
    const choice = WALLETS.find((item) => item.id === id);
    const found = choice ? connectors.find((connector) => choice.match.test(connector.name) || choice.match.test(connector.id)) : undefined;
    if (found) {
      void connect({ connector: found, chainId });
      return;
    }
    const page = `${window.location.host}${window.location.pathname}`;
    const href = choice?.open(page);
    if (href) window.location.assign(href);
  }
  const publicClient = usePublicClient({ chainId: aevumTestnet.id });
  const { data: walletClient } = useWalletClient({ chainId: aevumTestnet.id });

  const live = true;

  useEffect(() => {
    const saved = loadLedger(localStorage.getItem(KEY));
    const revoked = saved.feed.some((item) => item.title.startsWith("Revoked "));
    if (saved.agents.length === 0 && !revoked) {
      const who = localAgent();
      const result = registerAgent(
        saved,
        {
          address: who.address,
          label: DEFAULT_AGENT.label,
          perTxLimit: 150,
          dailyLimit: 400,
          allow: [DIRECTORY[0].address, DIRECTORY[1].address],
        },
        Date.now(),
      );
      setLedger(result.ok ? result.ledger : saved);
      setAgentAddr(who.address);
    } else {
      setLedger(saved);
      if (saved.agents[0]) setAgentAddr(saved.agents[0].address);
    }
    setNow(Date.now());
    const stored = localStorage.getItem(NAME_KEY)?.trim() ?? "";
    setName(stored);
    setNamed(stored.length > 0);
    const storedTheme = localStorage.getItem(THEME_KEY);
    if (storedTheme === "dark" || storedTheme === "light") setTheme(storedTheme);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!intro || !ready || named === null) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setTimeout(() => setIntro(false), reduce ? 200 : 1600);
    return () => window.clearTimeout(id);
  }, [intro, ready, named]);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme, ready]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(KEY, JSON.stringify(ledger));
  }, [ledger, ready]);

  useEffect(() => {
    if (!ready || live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ready, live]);

  useEffect(() => {
    if (!live || !publicClient) {
      setVaultAgents({});
      return;
    }
    const addresses = ledger.agents.map((item) => item.address).filter(isHexAddress);
    let cancel = false;
    void Promise.all(
      addresses.map(async (address) => {
        try {
          return [address.toLowerCase(), await readAgentActive(publicClient, address)] as const;
        } catch {
          return [address.toLowerCase(), false] as const;
        }
      }),
    ).then((rows) => {
      if (!cancel) setVaultAgents(Object.fromEntries(rows));
    });
    return () => {
      cancel = true;
    };
  }, [live, publicClient, ledger.agents, settled]);

  useEffect(() => {
    if (!live || !publicClient) return;
    let cancel = false;
    void readVaultPayments(publicClient)
      .then((rows) => {
        if (!cancel) setChainPays(rows);
      })
      .catch(() => {
        if (!cancel) setChainPays([]);
      });
    return () => {
      cancel = true;
    };
  }, [live, publicClient, receipts]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (event.key === "Escape") {
        setSettingsOpen(false);
        return;
      }
      const command = (event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey);
      if (command || (event.key === "/" && !typing)) {
        event.preventDefault();
        setTab("chat");
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clock = now == null ? null : now + ledger.offsetMs;
  const activeAgents = ledger.agents.filter((item) => item.active);
  const agent = activeAgents[0] ?? ledger.agents[0];
  const account = wallet ?? "";

  function at(): number {
    return (now ?? Date.now()) + ledger.offsetMs;
  }

  function apply(result: Result, extra?: string) {
    setLedger(result.ledger);
    setNote(extra ?? result.message);
    if (result.proof) setLastProof(result.proof);
  }

  function record(entry: Omit<Receipt, "id">, quiet = false) {
    setReceipts((prev) => [{ ...entry, id: Date.now() }, ...prev].slice(0, 12));
    if (!quiet) setNote(entry.detail);
    if (!entry.ok) setTab("activity");
  }

  async function liveSend(
    title: string,
    run: (pc: NonNullable<typeof publicClient>, wc: NonNullable<typeof walletClient>) => Promise<TxResult>,
    about?: { amount?: number; who?: string },
  ) {
    if (!publicClient || !walletClient) {
      record({ ok: false, title, detail: "Connect a wallet on Aevum before this can send.", hashes: [] });
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
    const money = /money|schedule|withdraw|buy/i.test(title);
    setBusy(true);
    if (money) setMoving(title);
    try {
      const result = await run(publicClient, walletClient);
      if (result.ok) {
        const hash = result.hashes[0];
        record({ ok: true, title, detail: hash ? "Sent" : title, hashes: [...result.hashes] }, money);
        if (money) setSlip({ title, amount: about?.amount, who: about?.who, hash });
        if (hash) {
          await publicClient.waitForTransactionReceipt({ hash });
          setChainPays(await readVaultPayments(publicClient));
          setSettled((count) => count + 1);
        }
      } else {
        record({ ok: false, title, detail: result.reason, hashes: [] });
      }
    } catch (err) {
      record({ ok: false, title, detail: err instanceof Error ? err.message : "The payment did not go through.", hashes: [] });
    } finally {
      setBusy(false);
      setMoving(null);
    }
  }

  function asAddress(value: string): Address {
    if (!isHexAddress(value)) throw new Error(`Not an address: ${value}`);
    return value;
  }

  function resolveRecipient(): string | null {
    const typed = customPayee.trim();
    if (typed) {
      if (isHexAddress(typed)) return typed;
      return resolvePayee(typed)?.address ?? null;
    }
    return contact;
  }

  function onDeposit(value = Number(fundAmt)) {
    if (live) {
      void liveSend("Add money", (pc, wc) => depositToVault(pc, wc, wholeToBase(value)), { amount: value, who: "Your vault" });
      return;
    }
    apply(deposit(ledger, value, at()));
  }

  function onWithdraw() {
    if (live) {
      void liveSend("Withdraw", (pc, wc) => withdrawFromVault(pc, wc, wholeToBase(Number(fundAmt))), {
        amount: Number(fundAmt),
        who: "You",
      });
      return;
    }
    apply(withdraw(ledger, Number(fundAmt), at()));
  }

  function onSendYou(payee: string, amount: number, noteText: string) {
    if (live) {
      void liveSend("Send money", (pc, wc) => payAsOwnerOnVault(pc, wc, asAddress(payee), wholeToBase(amount), noteText), {
        amount,
        who: labelOf(payee),
      });
      return;
    }
    apply(sendAsYou(ledger, { payee, amount, memo: noteText }, at()));
  }

  function onScheduleYou(payee: string, amount: number, intervalMs: number, noteText: string, maxRuns?: number) {
    const runs = maxRuns ?? (intervalMs >= 7 * DAY_MS ? 12 : 6);
    if (live) {
      if (!agent?.active) {
        record({ ok: false, title: "Schedule", detail: "Add an agent first. A repeating payment on Aevum uses that agent's mandate.", hashes: [] });
        return;
      }
      void liveSend("Schedule", (pc, wc) =>
        createScheduleOnVault(
          pc,
          wc,
          asAddress(agent.address),
          asAddress(payee),
          wholeToBase(amount),
          BigInt(Math.max(3600, Math.floor(intervalMs / 1000))),
          runs,
          noteText || "recurring",
        ),
        { amount, who: labelOf(payee) },
      );
      return;
    }
    apply(createSchedule(ledger, { payee, amount, intervalMs, maxRuns: runs, memo: noteText || "recurring", byYou: true }, at()));
  }

  function onPayInvoice(id: string) {
    if (live) {
      record({
        ok: false,
        title: "Invoice",
        detail: "On Aevum the payee opens the invoice. Fund the on-chain id. A local draft is not an invoice number.",
        hashes: [],
      });
      return;
    }
    apply(fundInvoice(ledger, id, at(), "you"));
  }

  function addMandate(input?: { label: string; address: string; perTxLimit: number; dailyLimit: number; allow: string[]; expiry: number }) {
    if (!input && !isHexAddress(agentAddr)) {
      setAgentError("Enter a valid agent address.");
      return;
    }
    const body = input ?? {
      label: agentLabel.trim() || DEFAULT_AGENT.label,
      address: agentAddr,
      perTxLimit: Number(perTx),
      dailyLimit: Number(daily),
      allow,
      expiry: expiryDays ? at() + Number(expiryDays) * DAY_MS : 0,
    };
    setAgentError(null);
    if (live) {
      const expirySeconds = body.expiry > 0 ? BigInt(Math.floor(body.expiry / 1000)) : 0n;
      void liveSend("Add agent", (pc, wc) =>
        registerOnVault(pc, wc, asAddress(body.address), wholeToBase(body.perTxLimit), wholeToBase(body.dailyLimit), body.allow.filter(isHexAddress), expirySeconds),
      );
      return;
    }
    apply(registerAgent(ledger, { ...body, allowAny: false }, at()));
    setShowAdd(false);
  }

  function onBuy() {
    if (live) {
      const oracle = ledger.x402[0];
      void liveSend(
        "Buy oracle",
        (pc, wc) => executeAgentIntent(pc, wc, localAgentKey(), asAddress(oracle.payTo), wholeToBase(oracle.price), "oracle"),
        { amount: oracle.price, who: labelOf(oracle.payTo) },
      );
      return;
    }
    const result = buyX402(ledger, "oracle", at());
    apply(result);
  }

  function onNorthwind() {
    if (live) {
      record({ ok: false, title: "Northwind", detail: "This check is the agent's allowlist. Use simulation, or the agent's own key.", hashes: [] });
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[2].address, amount: 10, memo: "northwind" }, at()));
  }

  function onBlock() {
    if (live) {
      record({ ok: false, title: "Limit", detail: "This check is the agent's per-payment cap. Use simulation, or the agent's own key.", hashes: [] });
      return;
    }
    apply(pay(ledger, { payee: DIRECTORY[0].address, amount: 180, memo: "over per-tx" }, at()));
  }

  function onRevoke(address?: string) {
    const who = address ?? agent?.address ?? DEFAULT_AGENT.address;
    if (live) {
      void liveSend("Revoke", (pc, wc) => revokeOnVault(pc, wc, asAddress(who)));
      return;
    }
    apply(revokeAgent(ledger, at(), who));
  }

  function onReplay() {
    if (!lastProof && !ledger.usedProofs[0]) {
      setNote("Buy the oracle first. There is no proof to replay.");
      return;
    }
    apply(replayProof(ledger, lastProof ?? ledger.usedProofs[0], at()));
  }

  function checkIntent(action: AgentAction): { ok: boolean; line: string } {
    if (action.type === "balance") return { ok: true, line: "This only reads your balance." };
    if (live && action.type === "schedule") {
      if (!agent?.active) return { ok: false, line: "Add an agent. A repeating payment on Aevum uses that mandate." };
      return { ok: true, line: `Repeats through ${agent.label}. Its per-payment and daily limits apply. ${action.maxRuns} runs.` };
    }
    if (live && action.type === "pay") {
      return { ok: true, line: "Your payment on Aevum. No agent limit. Reserved funds stay locked." };
    }
    if (action.type === "pay") {
      const inv = action.memo ? ledger.invoices.find((item) => item.id === action.memo) : undefined;
      if (ledger.globalPaused) return { ok: false, line: "The vault is paused." };
      if (action.amount > available(ledger)) return { ok: false, line: `Not enough free balance. ${formatTusd(available(ledger))} tUSD8 is available.` };
      if (inv && inv.status === "open" && inv.amount === action.amount) {
        return { ok: true, line: "Pays this invoice into escrow from your balance. No agent limit." };
      }
      return { ok: true, line: "Your payment. No agent spending limit applies." };
    }
    if (action.type === "schedule") {
      const obligation = action.amount * action.maxRuns;
      if (ledger.globalPaused) return { ok: false, line: "The vault is paused." };
      if (obligation > available(ledger)) return { ok: false, line: `Reserving ${formatTusd(obligation)} tUSD8 would exceed your free balance.` };
      return { ok: true, line: `Your repeating payment. ${action.maxRuns} runs reserve ${formatTusd(obligation)} tUSD8. No agent limit in simulation.` };
    }
    if (!agent?.active) return { ok: false, line: "Add an agent before this can run." };
    if (action.type === "revoke") return { ok: true, line: `Revoke ${agent.label}. Further spends from it stop.` };
    if (action.type === "pause") return { ok: true, line: agent.paused ? `Resume ${agent.label}.` : `Pause ${agent.label}.` };
    const reason = clock == null ? "Still loading." : explainPolicy(agent, DIRECTORY[1].address, 25, clock, ledger.globalPaused);
    if (reason) return { ok: false, line: reason };
    if (25 > available(ledger)) return { ok: false, line: "Not enough free balance for the oracle." };
    return { ok: true, line: `${agent.label} can buy the oracle. 25 tUSD8 is inside its mandate.` };
  }

  function runAction(action: AgentAction) {
    if (action.type === "balance") {
      setNote(
        agent
          ? `${name}, your balance is ${formatTusd(ledger.balance)} tUSD8. ${formatTusd(available(ledger))} is free. ${agent.label} is one of your agents.`
          : `${name}, your balance is ${formatTusd(ledger.balance)} tUSD8. No agent added.`,
      );
      setTab("home");
      return;
    }
    if (action.type === "pause") {
      if (!agent) return;
      if (live) {
        void liveSend(agent.paused ? "Resume agent" : "Pause agent", (pc, wc) => pauseAgentOnVault(pc, wc, asAddress(agent.address), !agent.paused));
        return;
      }
      apply(setPaused(ledger, !agent.paused, at(), agent.address));
      setTab("agents");
      return;
    }
    if (action.type === "revoke") {
      onRevoke();
      setTab("agents");
      return;
    }
    if (action.type === "x402") {
      onBuy();
      setTab("agents");
      return;
    }
    if (action.type === "pay") {
      if (action.memo) {
        const inv = ledger.invoices.find((item) => item.id === action.memo);
        if (inv && inv.status === "open" && inv.amount === action.amount) {
          onPayInvoice(inv.id);
          setTab("invoices");
          return;
        }
      }
      onSendYou(action.payee, action.amount, action.memo ?? "");
      setTab("activity");
      return;
    }
    onScheduleYou(action.payee, action.amount, action.everyMs, action.memo ?? "recurring", action.maxRuns);
    setTab("send");
    setSendMode("repeat");
  }

  const northwindRejected =
    ledger.feed.some((item) => /PayeeNotAllowed/.test(item.detail)) || receipts.some((item) => /PayeeNotAllowed/.test(item.detail));
  const capRejected =
    ledger.feed.some((item) => /Per-transaction/.test(item.detail)) || receipts.some((item) => /PerTxLimitExceeded|Per-transaction/.test(item.detail));
  const replayRejected = ledger.feed.some((item) => item.title === "Replay rejected") || receipts.some((item) => /already used/.test(item.detail));

  const humanSteps = [
    {
      id: "deposit",
      label: "Add money",
      detail: "Deposit 1,000 tUSD8",
      done: !live && (ledger.balance > 0 || ledger.feed.some((item) => item.title.startsWith("Deposited"))),
      run: () => onDeposit(1000),
    },
    {
      id: "send",
      label: "Send 5 tUSD8",
      detail: "To DataRelay, a saved contact",
      done: !live && ledger.feed.some((item) => item.title === "Sent 5 tUSD8 to DataRelay"),
      run: () => onSendYou(DIRECTORY[1].address, 5, "tour"),
    },
    {
      id: "invoice",
      label: "Pay INV-0142",
      detail: "120 tUSD8 into escrow",
      done: !live && ledger.invoices.find((item) => item.id === "INV-0142")?.status !== "open",
      run: () => onPayInvoice("INV-0142"),
    },
  ];
  const agentSteps = [
    {
      id: "add",
      label: "Add payables-1",
      detail: "150 per payment · 400 a day · Acme Studio + DataRelay",
      blocked: false,
      done: !live && ledger.agents.some((item) => item.label === DEFAULT_AGENT.label && item.perTxLimit === 150 && item.dailyLimit === 400),
      run: () =>
        addMandate({
          label: DEFAULT_AGENT.label,
          address: agent?.address && isHexAddress(agent.address) ? agent.address : DEFAULT_AGENT.address,
          perTxLimit: 150,
          dailyLimit: 400,
          allow: [DIRECTORY[0].address, DIRECTORY[1].address],
          expiry: 0,
        }),
    },
    {
      id: "oracle",
      label: "Buy the DataRelay oracle",
      detail: "25 tUSD8",
      blocked: false,
      done: !live && ledger.x402[0].purchases.length > 0,
      run: onBuy,
    },
    {
      id: "replay",
      label: "Replay the proof",
      detail: "Rejected. One proof, one use.",
      blocked: false,
      done: replayRejected,
      run: onReplay,
    },
    { id: "cap", label: "Try 180", detail: "Over the per-payment limit", blocked: true, done: capRejected, run: onBlock },
    { id: "northwind", label: "Try Northwind", detail: "Not on the allowlist", blocked: true, done: northwindRejected, run: onNorthwind },
    {
      id: "revoke",
      label: "Revoke payables-1",
      detail: "Spend stops",
      blocked: false,
      done: !live && ledger.agents.some((item) => item.label === DEFAULT_AGENT.label && !item.active),
      run: () => onRevoke(DEFAULT_AGENT.address),
    },
  ];

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [thread, tab, working]);

  function askAgent(text: string) {
    const trimmed = text.trim();
    if (!trimmed || working) return;
    const parsed = parseUtterance(trimmed);
    const youId = Date.now();
    setUtterance("");
    setTab("chat");
    setWorking(true);
    setThread((prev) => [...prev, { id: youId, role: "you", text: trimmed }]);
    const pause = new Promise((resolve) => window.setTimeout(resolve, 780));
    const reply = (line: string, action?: AgentAction) => {
      setPending(action ?? null);
      setThread((prev) => [...prev, { id: youId + 1, role: "agent", text: line, action }]);
      setWorking(false);
    };
    if (parsed.error || !parsed.action) {
      void pause.then(() => reply(parsed.error ?? `${name}, say what you want the agent to do.`));
      return;
    }
    if (parsed.action.type === "balance") {
      if (live && publicClient) {
        void Promise.all([pause, readVaultAvailable(publicClient)]).then(([, free]) => {
          const line =
            free == null
              ? "No vault is available on Aevum yet."
              : `${name}, free on Aevum is ${(Number(free) / 10 ** tusd8Decimals).toLocaleString("en-US", { maximumFractionDigits: tusd8Decimals })} tUSD8.`;
          reply(line);
        });
        return;
      }
      void pause.then(() =>
        reply(
          `${name}, your balance is ${formatTusd(ledger.balance)} tUSD8. ${formatTusd(available(ledger))} is free.${agent?.active ? ` ${agent.label} can spend inside its mandate.` : " No agent is active."}`,
        ),
      );
      return;
    }
    const action = parsed.action;
    void pause.then(() => reply(`Review this, ${name}. Nothing moves until you approve.`, action));
  }

  function decide(id: number, decision: "approved" | "declined", action?: AgentAction) {
    if (decision === "approved") {
      if (!action) return;
      const gate = checkIntent(action);
      if (!gate.ok || busy) return;
      runAction(action);
      setTab("chat");
    }
    setPending(null);
    setThread((prev) => prev.map((msg) => (msg.id === id ? { ...msg, decision } : msg)));
  }

  const liveHold = !live
    ? null
    : !isConnected
      ? configured
        ? "Connect a wallet to do this on Aevum."
        : "Connect a wallet. No vault is available on Aevum yet."
      : !configured
        ? "No vault is available on Aevum yet."
        : null;

  if (surface === "tour") {
    return (
      <div className="app-shell">
        <div className="app-column">
        <header className="app-header">
          <div className="app-pad mx-auto flex max-w-3xl items-center justify-between gap-3 py-3">
            <Link to="/" className="flex items-center" aria-label="Float">
              <Mark />
            </Link>
            <Link to="/" className={`${ghost} inline-flex items-center`}>
              Home
            </Link>
          </div>
        </header>
        <main className="app-stage">
          <Tour human={humanSteps} agent={agentSteps} ready={ready} busy={busy} />
        </main>
        </div>
      </div>
    );
  }

  if (named === null || !ready || intro) return <BubbleIntro />;
  if (!named) {
    return (
      <Welcome
        onContinue={(next) => {
          localStorage.setItem(NAME_KEY, next);
          setName(next);
          setNamed(true);
        }}
      />
    );
  }

  return (
    <div className="app-shell min-h-0">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-paper lg:flex">
        <nav className="flex flex-1 flex-col gap-1 px-3 pt-4" aria-label="Sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rail press flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm ${tab === item.id ? "rail-on" : ""}`}
            >
              <item.icon className="size-4" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="app-column lg:col-start-2">
      <header className="app-header">
        <div className="app-pad mx-auto flex max-w-6xl items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 items-center" aria-label="Float">
            <Mark />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={isConnected && walletChain === chainId ? iconBtn : "press grid size-11 shrink-0 place-items-center rounded-lg bg-seal text-on-seal shadow-plane"}
              disabled={isPending}
              aria-label={!isConnected ? "Connect wallet" : walletChain !== chainId ? "Switch network" : shortAddr(wallet ?? "Wallet")}
              onClick={() => {
                if (!isConnected) {
                  setWalletsOpen(true);
                  return;
                }
                if (walletChain !== chainId) void openAevum();
              }}
            >
              <Wallet className="size-4" aria-hidden="true" />
            </button>
            <button type="button" className={iconBtn} aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              <Settings className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {note ? (
        <div className="border-b border-line bg-surface">
          <p className="mx-auto max-w-3xl px-4 py-2 text-sm text-ink">{note}</p>
        </div>
      ) : null}

      <main className={`app-stage ${tab === "chat" ? "app-stage-chat" : ""}`}>
        {tab === "chat" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-baseline justify-between gap-3 py-2">
              <p className="text-sm text-muted">Free to spend</p>
              <button type="button" className="press font-mono text-sm text-ink" onClick={() => setTab("home")}>
                {formatTusd(available(ledger))} tUSD8
              </button>
            </div>
            <div ref={threadRef} className="thread-scroll flex flex-1 flex-col gap-4 overflow-y-auto py-4">
              {thread.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
                  <Mark />
                  <h1 className="mt-4 font-display text-2xl font-medium tracking-display">{name}, what should your agent pay?</h1>
                  <p className="mt-2 max-w-sm text-sm text-muted">Ask about Float, or tell it who to pay. Nothing moves until you approve.</p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {["What is Float?", "What’s my balance?", "Send 5 tUSD8 to DataRelay"].map((prompt) => (
                      <button key={prompt} type="button" className={ghost} onClick={() => askAgent(prompt)}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                thread.map((msg) => {
                  const gate = msg.action ? checkIntent(msg.action) : null;
                  const open = !!msg.action && pending === msg.action && !msg.decision;
                  return (
                    <div key={msg.id} className={`msg-in flex ${msg.role === "you" ? "justify-end" : "justify-start"}`}>
                      <div className={msg.role === "you" ? "max-w-[85%]" : "max-w-[85%]"}>
                        {msg.role === "agent" ? (
                          <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                            <Mark size="sm" />
                          </div>
                        ) : null}
                        <div className={msg.role === "you" ? "bubble-you px-4 py-3 text-sm" : "text-sm text-ink"}>
                          <p>{msg.text}</p>
                        </div>
                        {msg.action && gate ? (
                          <div className="review mt-2 text-ink">
                            <p className="text-xs font-medium text-muted">Review</p>
                            {msg.action.type === "pay" || msg.action.type === "schedule" ? (
                              <>
                                <p className="mt-1 font-display text-2xl font-medium tracking-display">{formatTusd(msg.action.amount)}</p>
                                <p className="text-sm">To {labelOf(msg.action.payee)}</p>
                              </>
                            ) : (
                              <p className="mt-1 text-sm">{describeAction(msg.action)}</p>
                            )}
                            <p className={`mt-2 text-sm ${gate.ok ? "text-treasury" : "text-stamp"}`}>{gate.line}</p>
                            {open ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button type="button" className={primary} disabled={!gate.ok || busy} onClick={() => decide(msg.id, "approved", msg.action)}>
                                  Approve
                                </button>
                                <button type="button" className={ghost} onClick={() => decide(msg.id, "declined")}>
                                  Not now
                                </button>
                              </div>
                            ) : (
                              <p className={`mt-3 text-sm ${msg.decision === "approved" ? "text-treasury" : "text-muted"}`}>
                                {msg.decision === "approved" ? "Approved" : msg.decision === "declined" ? "Not now" : "Not approved"}
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
              {working ? (
                <div className="msg-in flex justify-start">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <Mark size="sm" />
                    </div>
                    <div className="work-bubbles" role="status" aria-label="Agent is working">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <form
              className="composer mb-1"
              onSubmit={(event) => {
                event.preventDefault();
                askAgent(utterance);
              }}
            >
              <label className="sr-only" htmlFor="agent-composer">
                Message your agent
              </label>
              <input
                id="agent-composer"
                ref={composerRef}
                className="min-w-0 flex-1 bg-transparent px-3 font-sans text-sm text-ink outline-none"
                value={utterance}
                onChange={(event) => setUtterance(event.target.value)}
                placeholder="Message your agent"
              />
              <button type="submit" className={`${primary} grid size-11 place-items-center px-0`} disabled={!utterance.trim()} aria-label="Send">
                <ArrowUp className="size-4" aria-hidden="true" />
              </button>
            </form>
          </div>
        ) : null}

        {tab === "home" ? (
          <div className="stage space-y-5">
            <Cheque balance={ledger.balance} free={available(ledger)} reserved={ledger.reserved} account={account} />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Quick icon={ArrowUpRight} label="Send" hint="Move tUSD8" primary onClick={() => { setSendMode("once"); setReview(null); setTab("send"); }} />
              <Quick icon={FileText} label="Request" hint="New invoice" onClick={() => { setShowRequest(true); setTab("invoices"); }} />
              <Quick icon={Wallet} label="Invoice" hint="Pay or release" onClick={() => setTab("invoices")} />
              <Quick icon={Repeat} label="Schedule" hint="Repeat a send" onClick={() => { setSendMode("repeat"); setReview(null); setTab("send"); }} />
            </div>
            {ledger.agents.length > 0 && agent ? (
              <button type="button" className="plane flex w-full items-center gap-3 p-2 text-left" onClick={() => setTab("agents")}>
                <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink">
                  <Bot className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-base font-medium tracking-display">{agent.label}</span>
                  <span className="block text-xs text-muted">{agent.active && !agent.paused ? "Can spend" : agent.paused ? "Paused" : "Stopped"}</span>
                </span>
              </button>
            ) : null}
            <section>
              <h2 className="font-display text-base font-medium tracking-display">Recent activity</h2>
              <div className="mt-2">
                <Feed
                  feed={ledger.feed.slice(0, 4)}
                  clock={clock}
                  onEmpty={() => {
                    setSendMode("once");
                    setReview(null);
                    setTab("send");
                  }}
                />
              </div>
            </section>
          </div>
        ) : null}

        {tab === "send" ? (
          <div className="stage">
          <SendPanel
            mode={sendMode}
            setMode={setSendMode}
            contact={contact}
            setContact={setContact}
            customPayee={customPayee}
            setCustomPayee={setCustomPayee}
            sendAmt={sendAmt}
            setSendAmt={setSendAmt}
            memo={memo}
            setMemo={setMemo}
            review={review}
            busy={busy || !ready}
            hold={liveHold}
            schedules={ledger.schedules}
            onReview={() => {
              const payee = resolveRecipient();
              const amount = Number(sendAmt);
              if (!payee) {
                setNote("Pick a saved contact or paste a full address.");
                return;
              }
              if (!Number.isInteger(amount) || amount <= 0) {
                setNote("Enter a whole number of tUSD8.");
                return;
              }
              setReview({ payee, amount, memo: memo.trim(), repeat: sendMode === "repeat" });
            }}
            onBack={() => setReview(null)}
            onConfirm={(every) => {
              if (!review) return;
              if (review.repeat) onScheduleYou(review.payee, review.amount, every, review.memo);
              else onSendYou(review.payee, review.amount, review.memo);
              setReview(null);
              setTab("activity");
            }}
            onExecute={(id) => {
              if (live) {
                const due = ledger.schedules.find((item) => item.id === id);
                void liveSend(`Send schedule #${id}`, (pc, wc) => executeScheduleOnVault(pc, wc, BigInt(id)), {
                  amount: due?.amount,
                  who: due ? labelOf(due.payee) : undefined,
                });
                return;
              }
              apply(executeSchedule(ledger, id, at()));
            }}
            onCancel={(id) => {
              if (live) {
                record({ ok: false, title: "Cancel", detail: "Cancel it on Aevum.", hashes: [] });
                return;
              }
              apply(cancelSchedule(ledger, id, at()));
            }}
          />
          </div>
        ) : null}

        {tab === "invoices" ? (
          <div className="stage space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-display text-xl font-medium tracking-display">Invoices</h2>
              {ledger.invoices.length > 0 ? (
                <div className="text-right">
                  <button type="button" className={primary} disabled={!!liveHold} title={liveHold ?? undefined} onClick={() => setShowRequest((open) => !open)}>
                    {showRequest ? "Close" : "Request"}
                  </button>
                  {liveHold ? <p className="mt-1 max-w-48 text-xs text-muted">{liveHold}</p> : null}
                </div>
              ) : null}
            </div>
            {showRequest ? (
              <section className="plane space-y-3 p-4">
                <label className="block text-sm">
                  Who
                  <select className={`${field} mt-1`} value={draftPayee} onChange={(e) => setDraftPayee(e.target.value)}>
                    {DIRECTORY.map((item) => (
                      <option key={item.address} value={item.address}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Amount
                  <input className={`${field} mt-1`} inputMode="numeric" value={draftAmt} onChange={(e) => setDraftAmt(digits(e.target.value))} />
                </label>
                <label className="block text-sm">
                  For
                  <input className={`${field} mt-1`} value={draftMemo} onChange={(e) => setDraftMemo(e.target.value)} />
                </label>
                <button
                  type="button"
                  className={primary}
                  disabled={!!liveHold || !draftAmt}
                  title={liveHold ?? undefined}
                  onClick={() => {
                    if (live) {
                      setNote("The payee opens this on Aevum.");
                      return;
                    }
                    apply(
                      openInvoice(
                        ledger,
                        { id: `BILL-${Date.now().toString(36).toUpperCase()}`, payee: draftPayee, amount: Number(draftAmt), metadata: draftMemo.trim() || labelOf(draftPayee) },
                        at(),
                      ),
                    );
                    setDraftMemo("");
                    setShowRequest(false);
                  }}
                >
                  Request
                </button>
              </section>
            ) : null}
            {ledger.invoices.length === 0 && !showRequest ? (
              <div className="py-6">
                <p className="text-sm text-muted">No invoices yet</p>
                <button type="button" className={`${primary} mt-3`} disabled={!!liveHold} title={liveHold ?? undefined} onClick={() => setShowRequest(true)}>
                  Request
                </button>
                {liveHold ? <p className="mt-2 text-xs text-muted">{liveHold}</p> : null}
              </div>
            ) : (
            <ul className="space-y-3">
              {ledger.invoices.map((inv) => {
                const done = inv.status === "released" || inv.status === "refunded";
                const outcome = inv.status === "released" ? "Paid" : inv.status === "refunded" ? "Returned" : null;
                return (
                <li key={inv.id} className="plane p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <Face name={labelOf(inv.payee)} />
                      <div className="min-w-0">
                        <p className="font-display text-lg font-medium tracking-display">{labelOf(inv.payee)}</p>
                        <p className="truncate text-sm text-muted">{inv.metadata}</p>
                        {outcome ? <p className="mt-1 text-sm text-ink">{outcome}</p> : null}
                      </div>
                    </div>
                    <p className={`flex items-center gap-2 font-display text-2xl font-medium tracking-display ${done ? "text-muted" : "text-ink"}`}>
                      <TokenIcon />
                      {formatTusd(inv.amount)}
                    </p>
                  </div>
                  {done ? null : (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {inv.status === "open" ? (
                      <button type="button" className={primary} disabled={!!liveHold || busy} title={liveHold ?? undefined} onClick={() => onPayInvoice(inv.id)}>
                        Pay
                      </button>
                    ) : null}
                    {inv.status === "funded" || inv.status === "delivered" ? (
                      <button
                        type="button"
                        className={primary}
                        disabled={busy}
                        onClick={() => {
                          const marked = inv.status === "funded" ? markDelivered(ledger, inv.id, at()) : { ok: true as const, ledger };
                          if (!marked.ok) {
                            apply(marked);
                            return;
                          }
                          apply(confirmInvoice(marked.ledger, inv.id, at()));
                        }}
                      >
                        Release
                      </button>
                    ) : null}
                    {inv.status === "funded" || inv.status === "delivered" ? (
                      <button type="button" className={ghost} disabled={busy} onClick={() => apply(disputeInvoice(ledger, inv.id, at()))}>
                        Problem
                      </button>
                    ) : null}
                    {inv.status === "disputed" ? (
                      <>
                        <button type="button" className={primary} disabled={busy} onClick={() => apply(resolveInvoice(ledger, inv.id, true, at()))}>
                          Pay them
                        </button>
                        <button type="button" className={ghost} disabled={busy} onClick={() => apply(resolveInvoice(ledger, inv.id, false, at()))}>
                          Refund
                        </button>
                      </>
                    ) : null}
                  </div>
                  )}
                </li>
                );
              })}
            </ul>
            )}
          </div>
        ) : null}

        {tab === "agents" ? (
          <div className="stage space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl font-medium tracking-display">Agents</h2>
              </div>
              {ledger.agents.length > 0 ? (
                <div className="text-right">
                  <button type="button" className={primary} disabled={!!liveHold || busy} title={liveHold ?? undefined} onClick={() => setShowAdd((open) => !open)}>
                    {showAdd ? "Close" : "Add agent"}
                  </button>
                  {liveHold ? <p className="mt-1 max-w-48 text-xs text-muted">{liveHold}</p> : null}
                </div>
              ) : null}
            </div>
            {showAdd ? (
              <section className="plane p-4">
                <h3 className="text-sm font-medium">New mandate</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-muted">
                    Name
                    <input className={`${field} mt-1`} value={agentLabel} onChange={(e) => setAgentLabel(e.target.value)} />
                  </label>
                  <label className="text-xs text-muted">
                    Address
                    <input className={`${field} mt-1`} value={agentAddr} onChange={(e) => setAgentAddr(e.target.value)} />
                  </label>
                  <label className="text-xs text-muted">
                    Per payment
                    <input className={`${field} mt-1`} inputMode="numeric" value={perTx} onChange={(e) => setPerTx(digits(e.target.value))} />
                  </label>
                  <label className="text-xs text-muted">
                    Daily limit
                    <input className={`${field} mt-1`} inputMode="numeric" value={daily} onChange={(e) => setDaily(digits(e.target.value))} />
                  </label>
                  <label className="text-xs text-muted sm:col-span-2">
                    Expires in days (blank = none)
                    <input className={`${field} mt-1`} inputMode="numeric" value={expiryDays} onChange={(e) => setExpiryDays(digits(e.target.value))} />
                  </label>
                </div>
                <p className="mt-3 text-xs text-muted">Payee allowlist</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {DIRECTORY.map((item) => {
                    const on = allow.includes(item.address);
                    return (
                      <button
                        key={item.address}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setAllow(on ? allow.filter((entry) => entry !== item.address) : [...allow, item.address])}
                        className={`min-h-11 rounded-lg border px-3 text-sm ${on ? "border-seal bg-seal text-on-seal" : "border-line text-ink"}`}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
                <button type="button" className={`${primary} mt-3`} disabled={!ready || busy || !!liveHold} title={liveHold ?? undefined} onClick={() => addMandate()}>
                  Create mandate
                </button>
                {agentError ? <p className="mt-2 text-xs text-stamp">{agentError}</p> : null}
                {liveHold ? <p className="mt-2 text-xs text-muted">{liveHold}</p> : null}
              </section>
            ) : null}
            {ledger.agents.length === 0 && !showAdd ? (
              <div className="py-6">
                <p className="text-sm text-muted">No agents yet</p>
                <button type="button" className={`${primary} mt-3`} disabled={!!liveHold || busy} title={liveHold ?? undefined} onClick={() => setShowAdd(true)}>
                  Add agent
                </button>
                {liveHold ? <p className="mt-2 text-xs text-muted">{liveHold}</p> : null}
              </div>
            ) : ledger.agents.length === 0 ? null : (
              ledger.agents.map((item) => {
                const spent = clock == null ? 0 : spentInWindow(item, clock);
                const key = item.address.toLowerCase();
                const known = key in vaultAgents;
                const approved = vaultAgents[key] === true;
                return (
                  <article key={item.address} className="plane space-y-3 p-2">
                    <div className="flex items-start justify-between gap-3 px-3 pt-3">
                      <div>
                        <h3 className="font-display text-base font-medium">{item.label}</h3>
                        <p className="font-mono text-xs text-muted">{shortAddr(item.address)}</p>
                      </div>
                      <span className={`font-mono text-xs ${item.active && !item.paused ? "text-treasury" : "text-stamp"}`}>
                        {!item.active ? "revoked" : item.paused ? "paused" : "active"}
                      </span>
                    </div>
                    <div className="px-3">
                      <Drain left={Math.max(0, item.dailyLimit - spent)} cap={item.dailyLimit} />
                    </div>
                    <p className="px-3 text-xs text-muted">
                      {item.perTxLimit} per payment · allowlist {item.allowAny ? "any payee" : item.allow.map((entry) => labelOf(entry)).join(", ") || "none"}
                      {item.expiry ? ` · expires ${format(item.expiry, "MMM d")}` : ""}
                    </p>
                    {live && known ? (
                      <p className="mt-2 text-xs text-muted">
                        {approved ? "Approved on Aevum." : "Not on Aevum until you approve this address."}
                      </p>
                    ) : null}
                    {live && known && !approved ? (
                      <button
                        type="button"
                        className={`${primary} mt-3`}
                        disabled={busy || !!liveHold}
                        title={liveHold ?? undefined}
                        onClick={() =>
                          addMandate({
                            label: item.label,
                            address: item.address,
                            perTxLimit: item.perTxLimit,
                            dailyLimit: item.dailyLimit,
                            allow: item.allow,
                            expiry: item.expiry,
                          })
                        }
                      >
                        Approve on Aevum
                      </button>
                    ) : null}
                    {item.label === DEFAULT_AGENT.label && item.active ? (
                      <div className="row rounded-lg p-3">
                        <p className="text-sm">DataRelay oracle</p>
                        <button type="button" className={primary} disabled={busy || !!liveHold} title={liveHold ?? undefined} onClick={onBuy}>
                          Buy oracle
                        </button>
                        {ledger.x402[0].purchases[0] ? (
                          <p className="mt-2 font-mono text-xs text-treasury">{ledger.x402[0].purchases[0].body}</p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2 px-3 pb-2">
                      <button
                        type="button"
                        className={ghost}
                        disabled={!item.active || busy || !!liveHold}
                        title={liveHold ?? undefined}
                        onClick={() => {
                          if (live) {
                            void liveSend(item.paused ? "Resume agent" : "Pause agent", (pc, wc) => pauseAgentOnVault(pc, wc, asAddress(item.address), !item.paused));
                            return;
                          }
                          apply(setPaused(ledger, !item.paused, at(), item.address));
                        }}
                      >
                        {item.paused ? "Resume" : "Pause"}
                      </button>
                      <button type="button" className={dangerBtn} disabled={!item.active || busy || !!liveHold} title={liveHold ?? undefined} onClick={() => onRevoke(item.address)}>
                        Revoke
                      </button>
                    </div>
                    {liveHold ? <p className="mt-2 text-xs text-muted">{liveHold}</p> : null}
                  </article>
                );
              })
            )}
          </div>
        ) : null}

        {tab === "activity" ? (
          <div className="stage space-y-4">
            <h2 className="font-display text-xl font-medium tracking-display">Activity</h2>
            {live && chainPays.length > 0 ? (
              <ul className="plane p-4">
                {chainPays.map((item) => (
                  <li key={item.hash} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
                    <Face name="Aevum" />
                    <div className="min-w-0">
                    <p className="text-sm text-ink">
                      Paid {(Number(item.amount) / 10 ** tusd8Decimals).toLocaleString("en-US", { maximumFractionDigits: tusd8Decimals })} tUSD8 on Aevum
                    </p>
                    <a className="mt-1 block truncate font-mono text-xs text-seal" href={`${explorerUrl}/tx/${item.hash}`} target="_blank" rel="noreferrer">
                      {item.hash}
                    </a>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {receipts.length > 0 ? (
              <ul className="plane p-4">
                {receipts.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
                    <Face name={item.title} />
                    <div className="min-w-0">
                    <p className={`text-sm ${item.ok ? "text-ink" : "text-stamp"}`}>{item.title}</p>
                    {item.hashes.length === 0 ? <p className="mt-1 text-sm text-muted">{item.detail}</p> : null}
                    {item.hashes.map((hash) => (
                      <a key={hash} className="mt-1 block truncate font-mono text-xs text-seal" href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">
                        {hash}
                      </a>
                    ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {ledger.feed.length > 0 ? <Feed feed={ledger.feed} clock={clock} /> : null}
            {ledger.feed.length === 0 && receipts.length === 0 ? (
              <Feed
                feed={[]}
                clock={clock}
                onEmpty={() => {
                  setSendMode("once");
                  setReview(null);
                  setTab("send");
                }}
              />
            ) : null}
          </div>
        ) : null}
      </main>

      <nav className="app-dock lg:hidden" aria-label="Sections">
        <ul className="grid grid-cols-5">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setTab(item.id)}
                aria-label={item.label}
                className={`flex min-h-14 w-full items-center justify-center ${tab === item.id ? "dock-on" : "text-muted"}`}
              >
                <item.icon className="size-5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div
        className={`veil fixed inset-0 z-30 flex justify-end bg-ink/40 ${settingsOpen ? "veil-open" : ""}`}
          role="presentation"
          inert={settingsOpen ? undefined : true}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Settings"
            aria-hidden={settingsOpen ? undefined : true}
            className={`drawer h-full w-full max-w-md overflow-y-auto border-l border-line bg-paper p-5 ${settingsOpen ? "drawer-open" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-lg font-medium tracking-display">Settings</h2>
              <button type="button" className={iconBtn} aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-6 flex gap-2" role="group" aria-label="Appearance">
              <button
                type="button"
                aria-label="White"
                aria-pressed={theme === "light"}
                onClick={() => setTheme("light")}
                className={`${iconBtn} ${theme === "light" ? "bg-ink text-paper" : ""}`}
              >
                <Sun className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Dark"
                aria-pressed={theme === "dark"}
                onClick={() => setTheme("dark")}
                className={`${iconBtn} ${theme === "dark" ? "bg-ink text-paper" : ""}`}
              >
                <Moon className="size-4" aria-hidden="true" />
              </button>
            </div>
            <label className="mt-6 block text-sm">
              Name
              <input
                className={`${field} mt-2`}
                value={name}
                maxLength={24}
                onChange={(event) => setName(event.target.value.slice(0, 24))}
                onBlur={() => {
                  const trimmed = name.trim().slice(0, 24);
                  if (!trimmed) {
                    setName(localStorage.getItem(NAME_KEY) ?? "");
                    return;
                  }
                  localStorage.setItem(NAME_KEY, trimmed);
                  setName(trimmed);
                }}
              />
            </label>
            <div className="mt-6 flex flex-col gap-2">
              <label className="sr-only" htmlFor="fund">
                Amount
              </label>
              <input id="fund" inputMode="numeric" className={field} value={fundAmt} onChange={(e) => setFundAmt(digits(e.target.value))} />
              <button type="button" className={primary} disabled={!ready || busy || !!liveHold} onClick={() => onDeposit()}>
                Add money
              </button>
              <button type="button" className={ghost} disabled={!ready || busy || !!liveHold} onClick={onWithdraw}>
                Withdraw
              </button>
            </div>
            <button
              type="button"
              className={`${dangerBtn} mt-6`}
              disabled={busy || !!liveHold}
              title={liveHold ?? undefined}
              onClick={() => {
                void liveSend(ledger.globalPaused ? "Resume vault" : "Pause vault", (pc, wc) => pauseVaultOnVault(pc, wc, !ledger.globalPaused));
              }}
            >
              {ledger.globalPaused ? "Resume vault" : "Pause vault"}
            </button>
            {liveHold ? <p className="mt-2 text-xs text-muted">{liveHold}</p> : null}
          </div>
        </div>
      </div>
      {slip ? (
        <ReceiptScreen
          title={slip.title}
          amount={slip.amount}
          who={slip.who}
          hash={slip.hash}
          onDone={() => setSlip(null)}
        />
      ) : moving ? (
        <MoveScreen label={moving} />
      ) : null}
      {walletsOpen ? (
        <div className="veil veil-open fixed inset-0 z-40 flex items-end justify-center bg-ink/40 sm:items-center" onClick={() => setWalletsOpen(false)}>
          <div
            role="dialog"
            aria-label="Connect wallet"
            className="w-full max-w-md rounded-t-3xl bg-paper p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-float sm:rounded-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <Mark />
              <button type="button" className={iconBtn} aria-label="Close" onClick={() => setWalletsOpen(false)}>
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {WALLETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="press flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-surface px-1"
                  onClick={() => chooseWallet(item.id)}
                >
                  <WalletGlyph id={item.id} />
                  <span className="text-xs text-ink">{item.name}</span>
                </button>
              ))}
              {connectors
                .filter((connector) => connector.id !== "injected" && !WALLETS.some((item) => item.match.test(connector.name) || item.match.test(connector.id)))
                .map((connector) => (
                  <button
                    key={connector.uid}
                    type="button"
                    className="press flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-surface px-1"
                    onClick={() => {
                      setWalletsOpen(false);
                      void connect({ connector, chainId });
                    }}
                  >
                    {connector.icon ? <img src={connector.icon} alt="" className="size-10" /> : <Wallet className="size-5" aria-hidden="true" />}
                    <span className="text-xs text-ink">{connector.name}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Mark({ tone = "seal", size = "md" }: { tone?: "seal" | "paper"; size?: "sm" | "md" | "lg" }) {
  const box = size === "sm" ? "size-5" : size === "lg" ? "size-20 rounded-2xl" : "size-8";
  const glyph = size === "sm" ? "size-3" : size === "lg" ? "size-12" : "size-5";
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-md ${box} ${tone === "paper" ? "bg-paper text-ink" : "bg-seal text-on-seal"}`}
      aria-hidden="true"
    >
      <svg viewBox="40 36 176 176" className={glyph} fill="currentColor">
        <path d="M40 36 H152 V84 H88 V116 H216 V164 H88 V212 H40 Z" />
      </svg>
    </span>
  );
}

function Face({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const letters =
    name
      .replace(/[^A-Za-z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] ?? "")
      .join("")
      .toUpperCase() || "•";
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full bg-seal font-display font-medium text-on-seal ${size === "sm" ? "size-8 text-xs" : "size-11 text-sm"}`}
      aria-hidden="true"
    >
      {letters}
    </span>
  );
}

function ReceiptScreen({
  title,
  amount,
  who,
  hash,
  onDone,
}: {
  title: string;
  amount?: number;
  who?: string;
  hash?: string;
  onDone: () => void;
}) {
  return (
    <div className="send-screen" role="status" aria-live="polite" aria-label={title}>
      <span className="rise-bubble rise-a" />
      <span className="rise-bubble rise-b" />
      <span className="rise-bubble rise-c" />
      <span className="rise-bubble rise-d" />
      <span className="rise-bubble rise-e" />
      <div className="send-mark">
        <span className="rise-shell send-shell" />
        {who ? <Face name={who} /> : <Mark size="lg" />}
        <p className="mt-6 font-display text-4xl font-medium tracking-display">{amount != null ? formatTusd(amount) : title}</p>
        {who ? <p className="mt-1 text-sm text-ink">To {who}</p> : null}
        {hash ? (
          <a className="mt-3 text-sm text-seal" href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">
            View on Aevum
          </a>
        ) : null}
        <button type="button" className={`${primary} mt-6`} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function MoveScreen({ label }: { label: string }) {
  return (
    <div className="send-screen" role="status" aria-live="polite" aria-label={label}>
      <span className="rise-bubble rise-a" />
      <span className="rise-bubble rise-b" />
      <span className="rise-bubble rise-c" />
      <span className="rise-bubble rise-d" />
      <span className="rise-bubble rise-e" />
      <div className="send-mark">
        <span className="rise-shell send-shell" />
        <Mark size="lg" />
        <p className="mt-6 font-display text-2xl font-medium tracking-display">{label}</p>
        <p className="mt-1 text-sm text-muted">On Aevum</p>
      </div>
    </div>
  );
}

function BubbleIntro() {
  return (
    <div className="intro intro-rise" role="status" aria-label="Float">
      <span className="rise-bubble rise-a" />
      <span className="rise-bubble rise-b" />
      <span className="rise-bubble rise-c" />
      <span className="rise-bubble rise-d" />
      <span className="rise-bubble rise-e" />
      <div className="rise-lead">
        <span className="rise-shell" />
        <Mark size="lg" />
      </div>
    </div>
  );
}

function Figures({ value }: { value: string }) {
  const chars = value.split("");
  const total = chars.length;
  return (
    <p className="figures font-display" aria-label={value}>
      {chars.map((ch, index) => (
        <span key={`${total - index}-${ch}`} aria-hidden="true">
          {ch}
        </span>
      ))}
    </p>
  );
}

function Quick({
  icon: Icon,
  label,
  hint,
  onClick,
  primary,
}: {
  icon: typeof ArrowUpRight;
  label: string;
  hint: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`lift flex min-h-14 items-center gap-3 px-3 py-3 text-left ${primary ? "rounded-2xl bg-seal text-on-seal shadow-float" : "plane"}`}
    >
      <span className={`grid size-10 shrink-0 place-items-center rounded-lg ${primary ? "bg-on-seal/15 text-on-seal" : "bg-surface-2 text-ink"}`}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span>
        <span className={`block font-display text-base font-medium tracking-display ${primary ? "text-on-seal" : "text-ink"}`}>{label}</span>
        <span className={`block text-xs ${primary ? "text-on-seal/75" : "text-muted"}`}>{hint}</span>
      </span>
    </button>
  );
}

function Cheque({ balance, free, reserved, account }: { balance: number; free: number; reserved: number; account: string }) {
  return (
    <article className="cheque px-5 pt-5 pb-5">
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ChainIcon />
            Aevum
          </span>
          <TokenIcon />
        </div>
        <p className="kicker mt-6">Balance</p>
        <Figures value={formatTusd(balance)} />
        <div className="split mt-5 grid grid-cols-2 gap-3 pt-3">
          <div>
            <p className="kicker">Free</p>
            <p className="amount mt-1 font-mono text-sm">{formatTusd(free)}</p>
          </div>
          <div>
            <p className="kicker">Reserved</p>
            <p className="amount mt-1 font-mono text-sm">{formatTusd(reserved)}</p>
          </div>
        </div>
        {account ? <p className="mt-3 font-mono text-xs tracking-wide opacity-70">{shortAddr(account)}</p> : null}
      </div>
    </article>
  );
}

function ChainIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" role="img" aria-label="QDay">
      <circle cx="16" cy="16" r="16" fill="#111111" />
      <circle cx="15" cy="15" r="5.4" fill="none" stroke="#ffffff" strokeWidth="2.2" />
      <path d="M18.4 18.4 22.2 22.2" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function TokenIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" role="img" aria-label="tUSD8">
      <circle cx="16" cy="16" r="16" fill="#2f5bff" />
      <path
        d="M16 7.2v2.1M16 22.7v2.1M12.2 12.4c.4-1.5 1.8-2.3 3.8-2.3 2.2 0 3.6 1 3.6 2.6 0 1.5-1 2.2-3.4 2.7l-1.2.3c-2.8.6-4.4 1.6-4.4 3.8 0 2 1.8 3.3 4.4 3.3 2.3 0 4-1 4.5-2.7"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Drain({ left, cap }: { left: number; cap: number }) {
  const pct = cap === 0 ? 0 : Math.max(0, Math.min(100, (left / cap) * 100));
  const low = cap > 0 && left / cap < 0.25;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-xs text-muted">{formatTusd(left)} left today</span>
        <span className="font-mono text-xs text-muted">of {formatTusd(cap)}</span>
      </div>
      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={left} aria-label="Daily limit remaining">
        <div className={`meter-fill ${low ? "bg-stamp" : "bg-treasury"}`} style={{ width: `${pct}%` }} />
        <div className="meter-ticks pointer-events-none absolute inset-0" />
      </div>
    </div>
  );
}

function BlockedStamp() {
  return (
    <span className="inline-block -rotate-6 border-2 border-stamp px-2 py-0.5 font-display text-xs font-medium uppercase tracking-widest text-stamp">
      Blocked
    </span>
  );
}

function Tour({
  human,
  agent,
  ready,
  busy,
}: {
  human: { id: string; label: string; detail: string; done: boolean; run: () => void }[];
  agent: { id: string; label: string; detail: string; blocked: boolean; done: boolean; run: () => void }[];
  ready: boolean;
  busy: boolean;
}) {
  const nextHuman = human.find((step) => !step.done);
  const nextAgent = agent.find((step) => !step.done);
  return (
    <section className="plane p-4">
      <h2 className="font-display text-base font-medium tracking-display">Tour Float</h2>
      <p className="mt-1 text-sm text-muted">Two parts. You do not need an agent for the first.</p>
      <h3 className="kicker mt-4">A · You</h3>
      <ol className="mt-2 space-y-2">
        {human.map((step, index) => (
          <li key={step.id} className="row flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className={`text-sm ${step.done ? "text-muted" : "text-ink"}`}>
                <span className="mr-2 font-mono text-xs text-muted">{step.done ? "ok" : String(index + 1).padStart(2, "0")}</span>
                {step.label}
              </p>
              <p className="truncate pl-7 text-xs text-muted">{step.detail}</p>
            </div>
            {step.id === nextHuman?.id ? (
              <button type="button" className={primary} disabled={!ready || busy} onClick={step.run}>
                Run
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      <h3 className="kicker mt-4">B · An agent</h3>
      <ol className="mt-2 space-y-2">
        {agent.map((step, index) => (
          <li key={step.id} className="row flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className={`text-sm ${step.done ? "text-muted" : "text-ink"}`}>
                <span className="mr-2 font-mono text-xs text-muted">{step.done ? "ok" : String(index + 1).padStart(2, "0")}</span>
                {step.label}
              </p>
              <p className="truncate pl-7 text-xs text-muted">{step.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {step.blocked && step.done ? <BlockedStamp /> : null}
              {step.id === nextAgent?.id ? (
                <button type="button" className={primary} disabled={!ready || busy} onClick={step.run}>
                  Run
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SendPanel({
  mode,
  setMode,
  contact,
  setContact,
  customPayee,
  setCustomPayee,
  sendAmt,
  setSendAmt,
  memo,
  setMemo,
  review,
  busy,
  hold,
  schedules,
  onReview,
  onBack,
  onConfirm,
  onExecute,
  onCancel,
}: {
  mode: "once" | "repeat";
  setMode: (mode: "once" | "repeat") => void;
  contact: string;
  setContact: (value: string) => void;
  customPayee: string;
  setCustomPayee: (value: string) => void;
  sendAmt: string;
  setSendAmt: (value: string) => void;
  memo: string;
  setMemo: (value: string) => void;
  review: { payee: string; amount: number; memo: string; repeat: boolean } | null;
  busy: boolean;
  hold: string | null;
  schedules: Ledger["schedules"];
  onReview: () => void;
  onBack: () => void;
  onConfirm: (everyMs: number) => void;
  onExecute: (id: number) => void;
  onCancel: (id: number) => void;
}) {
  const [every, setEvery] = useState(String(7 * DAY_MS));
  if (review) {
    return (
      <section className="plane p-5">
        <p className="kicker">Review</p>
        <h2 className="mt-2 font-display text-xl font-medium tracking-display">Send money</h2>
        <dl className="mt-5 space-y-4 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="kicker">To</dt>
            <dd className="flex items-center gap-2 text-ink">
              <Face name={labelOf(review.payee)} size="sm" />
              {labelOf(review.payee)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="kicker">Amount</dt>
            <dd className="flex items-center gap-2 font-display text-3xl font-medium tracking-display">
              <TokenIcon />
              {formatTusd(review.amount)}
            </dd>
          </div>
          {review.memo ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="kicker">For</dt>
              <dd className="text-ink">{review.memo}</dd>
            </div>
          ) : null}
          {review.repeat ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="kicker">Every</dt>
                <dd className="text-ink">{Number(every) >= 7 * DAY_MS ? "Week" : Number(every) >= DAY_MS ? "Day" : "Hour"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="kicker">Payments</dt>
                <dd className="text-ink">{Number(every) >= 7 * DAY_MS ? 12 : 6}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="kicker">Reserved</dt>
                <dd className="text-ink">{formatTusd(review.amount * (Number(every) >= 7 * DAY_MS ? 12 : 6))}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={`${primary} w-full`} disabled={busy || !!hold} title={hold ?? undefined} onClick={() => onConfirm(Number(every))}>
            Confirm
          </button>
          <button type="button" className={ghost} onClick={onBack}>
            Back
          </button>
        </div>
        {hold ? <p className="mt-2 text-xs text-muted">{hold}</p> : null}
      </section>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-medium tracking-display">Send money</h2>
      </div>
      <div className="flex rounded-lg bg-paper p-1 shadow-plane" role="group" aria-label="Send kind">
        <button type="button" aria-pressed={mode === "once"} className={`press min-h-11 flex-1 rounded-md text-sm ${mode === "once" ? "bg-seal text-on-seal" : "text-muted"}`} onClick={() => setMode("once")}>
          Once
        </button>
        <button type="button" aria-pressed={mode === "repeat"} className={`press min-h-11 flex-1 rounded-md text-sm ${mode === "repeat" ? "bg-seal text-on-seal" : "text-muted"}`} onClick={() => setMode("repeat")}>
          Schedule
        </button>
      </div>
      <div className="flex gap-4" role="listbox" aria-label="Saved contact">
        {DIRECTORY.map((item) => {
          const on = contact === item.address && !customPayee.trim();
          return (
            <button
              key={item.address}
              type="button"
              role="option"
              aria-selected={on}
              className="press flex flex-col items-center gap-1"
              onClick={() => {
                setContact(item.address);
                setCustomPayee("");
              }}
            >
              <Face name={item.label} />
              <span className={`text-xs ${on ? "text-ink" : "text-muted"}`}>{item.label}</span>
            </button>
          );
        })}
      </div>
      <label className="block text-xs text-muted">
        Or an address
        <input className={`${field} mt-1`} value={customPayee} onChange={(e) => setCustomPayee(e.target.value)} placeholder="0x… or a contact name" />
      </label>
      <label className="block text-xs text-muted">
        Amount
        <input className={`${field} mt-1`} inputMode="numeric" value={sendAmt} onChange={(e) => setSendAmt(digits(e.target.value))} />
      </label>
      <label className="block text-xs text-muted">
        Memo
        <input className={`${field} mt-1`} value={memo} onChange={(e) => setMemo(e.target.value)} />
      </label>
      {mode === "repeat" ? (
        <label className="block text-xs text-muted">
          Every
          <select className={`${field} mt-1`} value={every} onChange={(e) => setEvery(e.target.value)}>
            <option value={String(HOUR_MS)}>Hour</option>
            <option value={String(DAY_MS)}>Day</option>
            <option value={String(7 * DAY_MS)}>Week</option>
          </select>
        </label>
      ) : null}
      <button type="button" className={`${primary} w-full`} disabled={busy || !!hold} title={hold ?? undefined} onClick={onReview}>
        Review
      </button>
      {hold ? <p className="text-xs text-muted">{hold}</p> : null}
      {mode === "repeat" && schedules.length > 0 ? (
        <ul className="space-y-2">
          {schedules.map((item) => (
            <li key={item.id} className="row flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <Face name={labelOf(item.payee)} size="sm" />
                <div>
                <p className="text-sm">
                  #{item.id} · {formatTusd(item.amount)} → {labelOf(item.payee)}
                </p>
                <p className="font-mono text-xs text-muted">
                  {item.agent ? (item.agent.toLowerCase() === DEFAULT_AGENT.address.toLowerCase() ? DEFAULT_AGENT.label : shortAddr(item.agent)) : "You"} · {item.runs}/{item.maxRuns} · {item.active ? "active" : "closed"}
                </p>
                </div>
              </div>
              {item.active ? (
                <div className="flex gap-2">
                  <button type="button" className={ghost} disabled={busy || !!hold} title={hold ?? undefined} onClick={() => onExecute(item.id)}>
                    Send due
                  </button>
                  <button type="button" className={dangerBtn} onClick={() => onCancel(item.id)}>
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Feed({ feed, clock, onEmpty }: { feed: FeedItem[]; clock: number | null; onEmpty?: () => void }) {
  if (feed.length === 0) {
    return (
      <div className="py-6">
        <p className="text-sm text-muted">No activity yet</p>
        {onEmpty ? (
          <button type="button" className={`${primary} mt-3`} onClick={onEmpty}>
            Send money
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <ul>
      {feed.map((item) => (
        <li key={item.id} className="feed-item flex items-center gap-3 border-b border-line py-3 last:border-b-0">
          <Face name={whoOf(item.actor)} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className={`text-sm ${item.ok ? "text-ink" : "text-stamp"}`}>{item.title}</p>
              <time className="shrink-0 font-mono text-xs text-muted">{clock == null ? "" : rel(item.ts, clock)}</time>
            </div>
            <p className="mt-1 text-sm text-muted">{item.detail}</p>
          </div>
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

function Welcome({ onContinue }: { onContinue: (name: string) => void }) {
  const [draft, setDraft] = useState("");
  const clean = draft.trim().slice(0, 24);
  return (
    <div className="welcome bg-paper text-ink">
      <form
        className="w-full max-w-md text-center"
        onSubmit={(event) => {
          event.preventDefault();
          if (clean) onContinue(clean);
        }}
      >
        <div className="mx-auto w-fit">
          <Mark />
        </div>
        <h1 className="mt-6 font-display text-4xl font-medium tracking-display">Give your agents a float, not your keys.</h1>
        <p className="mt-3 text-sm text-muted">You talk. You approve. The agent never holds the keys.</p>
        <label className="mt-8 block text-left text-sm">
          What should the agent call you?
          <input
            className={`${field} mt-2`}
            value={draft}
            maxLength={24}
            autoComplete="nickname"
            placeholder="Your nickname"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button type="submit" className={`${primary} mt-4 w-full`} disabled={!clean}>
          Continue
        </button>
      </form>
    </div>
  );
}

export function FloatApp({ surface = "app" }: { surface?: "app" | "tour" }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Console surface={surface} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
