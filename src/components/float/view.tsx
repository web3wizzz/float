import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, Bot, House, Moon, ScrollText, Send, Sun } from "lucide-react";
import {
  chainId,
  configured,
  contracts,
  explorerUrl,
  faucetUrl,
  rpcUrl,
  tusd8,
  tusd8Decimals,
} from "@/lib/float/config";
import { DEFAULT_AGENT, DIRECTORY, labelOf, shortAddr } from "@/lib/float/directory";
import { HOUR_MS, type Agent, type FeedItem, type Ledger } from "@/lib/float/ledger";
import { describeAction, type AgentAction } from "@/lib/float/parse";
import { wholeToBase } from "../../../packages/sdk/src/vault.ts";
import { formatClock, formatDay, money, rel, unit } from "./format";

export type Screen = "home" | "send" | "invoices" | "agents" | "activity";
export type Role = "owner" | "agent" | "payee" | "arbiter";
export type Mode = "simulation" | "live";

export interface Receipt {
  id: number;
  ok: boolean;
  title: string;
  detail: string;
  hashes: string[];
}

export interface Step {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  current: boolean;
}

export interface Banner {
  tone: "ok" | "bad" | "info";
  text: string;
}

const NAV: { id: Screen; label: string; icon: typeof House }[] = [
  { id: "home", label: "Home", icon: House },
  { id: "send", label: "Send", icon: Send },
  { id: "invoices", label: "Invoices", icon: ScrollText },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "activity", label: "Activity", icon: Activity },
];

const ROLES: Role[] = ["owner", "agent", "payee", "arbiter"];

export interface ConsoleViewProps {
  screen: Screen;
  ready: boolean;
  live: boolean;
  theme: "day" | "night" | null;
  onToggleTheme: () => void;
  onMode: (mode: Mode) => void;
  clock: number | null;
  offsetMs: number;
  banner: Banner | null;
  busy: boolean;
  intro: boolean;
  role: Role;
  onRole: (role: Role) => void;
  ledger: Ledger;
  agent: Agent | undefined;
  spent: number;
  left: number;
  policyLine: string | null;
  walletConnected: boolean;
  walletLabel: string;
  wrongChain: boolean;
  connecting: boolean;
  onConnect: () => void;
  onSwitchChain: () => void;
  steps: Step[];
  onRunStep: (id: string) => void;
  amount: string;
  onAmount: (value: string) => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onAdvance: () => void;
  onToggleVaultPause: () => void;
  confirm: null | "revoke" | "reset";
  onAskConfirm: (which: "revoke" | "reset") => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
  sendPayee: string;
  onSendPayee: (value: string) => void;
  sendAmt: string;
  onSendAmt: (value: string) => void;
  sendMemo: string;
  onSendMemo: (value: string) => void;
  onSend: () => void;
  utterance: string;
  onUtterance: (value: string) => void;
  onParse: () => void;
  pending: AgentAction | null;
  onExecute: () => void;
  onDismiss: () => void;
  perTx: string;
  onPerTx: (value: string) => void;
  daily: string;
  onDaily: (value: string) => void;
  expiryDays: string;
  onExpiryDays: (value: string) => void;
  allow: string[];
  onToggleAllow: (address: string) => void;
  onRegister: () => void;
  onPauseAgent: () => void;
  onTryCap: () => void;
  schedAmt: string;
  onSchedAmt: (value: string) => void;
  schedPayee: string;
  onSchedPayee: (value: string) => void;
  schedEvery: string;
  onSchedEvery: (value: string) => void;
  onAddSchedule: () => void;
  onExecuteSchedule: (id: number) => void;
  onFund: (id: string) => void;
  onDelivered: (id: string) => void;
  onConfirmInvoice: (id: string) => void;
  onDispute: (id: string) => void;
  onArbiter: (id: string, pay: boolean) => void;
  onBuy: () => void;
  onReplay: () => void;
  lastProof: string | null;
  receipts: Receipt[];
}

export function ConsoleView(props: ConsoleViewProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(props.onCancelConfirm);
  cancelRef.current = props.onCancelConfirm;
  useEffect(() => {
    if (!props.confirm) return;
    confirmRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") cancelRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.confirm]);

  const ratio =
    props.agent && props.agent.dailyLimit > 0 ? props.spent / props.agent.dailyLimit : 0;

  return (
    <div className="app">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="mast">
        <Link to="/" search={{ screen: "home" }} className="brand">
          <Mark />
          <h1 className="wordmark" translate="no">
            Float
          </h1>
        </Link>
        <button
          type="button"
          className="btn btn-quiet icon-btn theme-btn"
          onClick={props.onToggleTheme}
          aria-label={props.theme === "night" ? "Use day theme" : "Use night theme"}
        >
          {props.theme === "night" ? (
            <Sun size={20} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Moon size={20} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
        <p className="tagline">Give your agents a float, not your keys.</p>
        <p className="tagline-mobile">Give your agents a float, not your keys.</p>
        <nav className="railnav" aria-label="Sections">
          {NAV.map((item) => (
            <NavLink key={item.id} item={item} current={props.screen} />
          ))}
        </nav>
        <div className="mast-foot">
          <p className="mono" translate="no">
            Aevum {chainId}
          </p>
        </div>
      </header>

      <main className="stage" id="content" tabIndex={-1}>
        <div className="stagehead">
          <WalletControl {...props} />
          <p className="clock">
            {props.clock == null ? "—" : formatClock(props.clock)}
            {props.offsetMs !== 0 ? (
              <span className="block">{Math.round(props.offsetMs / HOUR_MS)} hours ahead</span>
            ) : null}
          </p>
        </div>

        <p className="lede">
          {props.live
            ? configured
              ? "Live on Aevum. Each action is simulated, then sent. A refusal shows the contract revert."
              : "Live on Aevum. The vault address is empty, so nothing is sent."
            : "Simulation. This ledger stays on this device. It is not a transaction on Aevum."}
        </p>

        {props.busy ? (
          <p className="lede" role="status">
            Sending…
          </p>
        ) : null}

        {props.banner ? (
          <div
            className={`banner banner-${props.banner.tone}`}
            role={props.banner.tone === "bad" ? "alert" : "status"}
          >
            {props.banner.text}
          </div>
        ) : null}

        {props.confirm ? (
          <div className="confirm" id="confirm">
            <p>
              {props.confirm === "revoke"
                ? `Revoke ${props.agent?.label ?? DEFAULT_AGENT.label}? Spending stops immediately.`
                : "Reset the sandbox? The local ledger clears. Chain config stays."}
            </p>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                className="btn btn-oxide"
                ref={confirmRef}
                onClick={props.onConfirm}
              >
                {props.confirm === "revoke" ? "Revoke now" : "Reset sandbox"}
              </button>
              <button type="button" className="btn btn-quiet" onClick={props.onCancelConfirm}>
                {props.confirm === "revoke" ? "Keep the agent" : "Keep the ledger"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="toolbar">
          <div className="group" role="group" aria-label="Ledger mode">
            <span className="group-label">Ledger</span>
            <div className="segment">
              <button
                type="button"
                className="seg"
                aria-pressed={!props.live}
                onClick={() => props.onMode("simulation")}
              >
                Simulation
              </button>
              <button
                type="button"
                className="seg"
                aria-pressed={props.live}
                onClick={() => props.onMode("live")}
              >
                Live
              </button>
            </div>
          </div>
          <div className="group">
            <span className="group-label" id="role-label">
              Acting as
            </span>
            <div className="segment" role="group" aria-labelledby="role-label">
              {ROLES.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="seg"
                  aria-pressed={props.role === item}
                  onClick={() => props.onRole(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="sub" style={{ marginTop: "0.55rem" }}>
          The vault checks the caller, not the sentence you type.
        </p>

        <div className="stack">
          {props.screen === "home" ? <HomeScreen {...props} ratio={ratio} /> : null}
          {props.screen === "send" ? <SendScreen {...props} /> : null}
          {props.screen === "invoices" ? <InvoiceScreen {...props} /> : null}
          {props.screen === "agents" ? <AgentScreen {...props} ratio={ratio} /> : null}
          {props.screen === "activity" ? <ActivityScreen {...props} /> : null}
        </div>
      </main>

      <nav className="dock" aria-label="Sections">
        {NAV.map((item) => (
          <NavLink key={item.id} item={item} current={props.screen} />
        ))}
      </nav>
    </div>
  );
}

function NavLink({ item, current }: { item: (typeof NAV)[number]; current: Screen }) {
  const Icon = item.icon;
  const active = current === item.id;
  return (
    <Link
      to="/"
      search={{ screen: item.id }}
      className="navlink"
      aria-current={active ? "page" : undefined}
    >
      <Icon size={20} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="2" fill="var(--color-mark-fill)" />
      <path
        d="M7 8h10M7 14h18M7 20h10M7 26h10"
        stroke="var(--color-mark-tick)"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function Draft({ ratio }: { ratio: number }) {
  const shift = Math.min(1, Math.max(0, ratio)) * 108;
  return (
    <svg className="draft" viewBox="0 0 28 120" aria-hidden="true">
      {[8, 26, 44, 62, 80, 98, 116].map((tick) => (
        <path key={tick} d={`M2 ${tick}H14`} stroke="currentColor" strokeWidth="1.5" />
      ))}
      <g className="draft-line" style={{ transform: `translateY(${shift}px)` }}>
        <path d="M2 8H26" stroke="var(--color-brass)" strokeWidth="2" />
      </g>
    </svg>
  );
}

function WalletControl(props: ConsoleViewProps) {
  if (!props.ready) return <span className="skel skel-ink btn-skel" />;
  if (props.walletConnected) {
    return (
      <div className="row">
        <p className="mono" translate="no">
          {props.walletLabel}
        </p>
        {props.wrongChain ? (
          <button type="button" className="btn btn-primary" onClick={props.onSwitchChain}>
            Switch to Aevum
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={props.connecting}
      aria-busy={props.connecting || undefined}
      onClick={props.onConnect}
    >
      {props.connecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}

function Plate({ props, ratio }: { props: ConsoleViewProps; ratio: number }) {
  return (
    <section
      className={props.intro ? "plate plate-intro" : "plate"}
      aria-labelledby="balance-title"
    >
      <h2 id="balance-title" className="sr-only">
        Vault balance
      </h2>
      <Draft ratio={props.ready ? ratio : 0} />
      <div className="plate-body">
        {props.ready ? (
          <div className="figure-row">
            <p className="figure num">{money(props.ledger.balance)}</p>
            <p className="unit" translate="no">
              tUSD8
            </p>
          </div>
        ) : (
          <span className="skel figure-skel" />
        )}
        <dl className="readings">
          <div>
            <dt>Free</dt>
            <dd>
              {props.ready ? money(Math.max(0, props.ledger.balance - props.ledger.reserved)) : "—"}
            </dd>
          </div>
          <div>
            <dt>Reserved</dt>
            <dd>{props.ready ? money(props.ledger.reserved) : "—"}</dd>
          </div>
        </dl>
        <p className="plate-note">
          {!props.ready ? (
            "Loading the ledger…"
          ) : props.ledger.globalPaused ? (
            "The vault is paused. Agents cannot spend."
          ) : props.walletConnected ? (
            <span translate="no">{props.walletLabel}</span>
          ) : (
            "No wallet connected. Simulation still runs on this device."
          )}
        </p>
      </div>
    </section>
  );
}

function HomeScreen(props: ConsoleViewProps & { ratio: number }) {
  return (
    <>
      <Plate props={props} ratio={props.ratio} />
      <Rights {...props} />
      <section>
        <div className="who">
          <h2 className="section-title">Latest</h2>
          <Link to="/" search={{ screen: "activity" }} className="link">
            All activity
          </Link>
        </div>
        <FeedList
          feed={props.ledger.feed.slice(0, 3)}
          clock={props.clock}
          empty="No payments yet. Fund the vault, approve an agent, then let it try."
        />
      </section>
      <section>
        <h2 className="section-title">Run the demo</h2>
        <p className="sub">Seven steps, in order. Each one uses the same checks as a live call.</p>
        <ol className="rule">
          {props.steps.map((step, index) => (
            <li key={step.id} className="step">
              <div className="step-copy">
                <span className="step-no">{String(index + 1).padStart(2, "0")}</span>
                <p>{step.label}</p>
                <p className="sub" style={{ gridColumn: "2" }}>
                  {step.detail}
                </p>
              </div>
              {step.current ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!props.ready || props.busy}
                  onClick={() => props.onRunStep(step.id)}
                >
                  Run
                </button>
              ) : step.done ? (
                <span className="done-word">Done</span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      <ChainDetails wallet={props.walletConnected ? props.walletLabel : "not connected"} />
    </>
  );
}

function Rights(props: ConsoleViewProps & { ratio: number }) {
  const agent = props.agent;
  return (
    <section>
      <h2 className="section-title">Spending rights</h2>
      {!props.ready ? (
        <p className="empty">Loading the ledger…</p>
      ) : !agent ? (
        <div className="empty">
          <p>
            No agent can spend yet. Set a per-transaction cap and a daily limit, then approve
            payables-1.
          </p>
          {props.screen === "agents" ? null : (
            <Link
              to="/"
              search={{ screen: "agents" }}
              className="btn btn-primary"
              style={{ marginTop: "0.8rem" }}
            >
              Set a policy
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="who">
            <div>
              <p style={{ fontWeight: 600 }}>{agent.label}</p>
              <p className="mono" translate="no">
                {shortAddr(agent.address)}
              </p>
            </div>
            <AgentState
              agent={agent}
              globalPaused={props.ledger.globalPaused}
              clock={props.clock}
            />
          </div>
          <dl className="statement">
            <div className="stat-row">
              <dt>Per transaction</dt>
              <dd className="num">{unit(agent.perTxLimit)}</dd>
            </div>
            <div className="stat-row">
              <dt>Today</dt>
              <dd className="num">
                {props.clock == null ? "—" : `${money(props.spent)} of ${money(agent.dailyLimit)}`}
              </dd>
            </div>
          </dl>
          <div
            className="meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={agent.dailyLimit}
            aria-valuenow={props.clock == null ? 0 : props.spent}
            aria-label="Spent today"
          >
            <div
              className="meter-fill"
              data-hot={agent.dailyLimit > 0 && props.spent / agent.dailyLimit >= 0.85}
              style={{
                transform: `scaleX(${agent.dailyLimit === 0 ? 0 : Math.min(1, props.spent / agent.dailyLimit)})`,
              }}
            />
          </div>
          <p className="sub">
            {props.left === 0 && props.spent > 0
              ? "Nothing left in the rolling day."
              : `${money(props.left)} left today.`}
          </p>
          <dl className="statement">
            <div className="stat-row">
              <dt>Expires</dt>
              <dd>{expiryLabel(agent, props.clock)}</dd>
            </div>
            <div className="stat-row">
              <dt>Allowlist</dt>
              <dd>
                {agent.allowAny
                  ? "Any payee"
                  : agent.allow.map((item) => labelOf(item)).join(", ") || "Empty"}
              </dd>
            </div>
          </dl>
          {props.policyLine ? (
            <p className="sub" style={{ marginTop: "0.7rem" }}>
              {props.policyLine}
            </p>
          ) : null}
          <div className="row" style={{ marginTop: "0.85rem" }}>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={!agent.active || props.busy}
              onClick={props.onPauseAgent}
            >
              {agent.paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!agent.active}
              onClick={() => props.onAskConfirm("revoke")}
            >
              Revoke
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function AgentState({
  agent,
  globalPaused,
  clock,
}: {
  agent: Agent;
  globalPaused: boolean;
  clock: number | null;
}) {
  const expired = agent.expiry !== 0 && clock != null && clock > agent.expiry;
  const bad = !agent.active || agent.paused || globalPaused || expired;
  const label = !agent.active
    ? "Revoked"
    : globalPaused
      ? "Vault paused"
      : agent.paused
        ? "Paused"
        : expired
          ? "Expired"
          : "Can spend";
  return <p className={bad ? "state-bad" : "state-ok"}>{label}</p>;
}

function expiryLabel(agent: Agent, clock: number | null): string {
  if (agent.expiry === 0) return "No expiry";
  if (clock != null && clock > agent.expiry) return `Expired ${formatDay(agent.expiry)}`;
  return formatDay(agent.expiry);
}

function SendScreen(props: ConsoleViewProps) {
  return (
    <>
      <h2 className="screen-title">Send</h2>
      <section>
        <h3 className="section-title">Fund or withdraw</h3>
        <p className="sub">Owner only. Whole tUSD8, no decimals.</p>
        <div className="row" style={{ marginTop: "0.8rem" }}>
          <label className="lbl" style={{ flex: "1 1 10rem" }}>
            Amount
            <input
              className="field"
              name="amount"
              inputMode="numeric"
              autoComplete="off"
              value={props.amount}
              onChange={(event) => props.onAmount(event.target.value.replace(/[^\d]/g, ""))}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!props.ready || props.busy}
            onClick={props.onDeposit}
          >
            Deposit
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={!props.ready || props.busy}
            onClick={props.onWithdraw}
          >
            Withdraw
          </button>
        </div>
        <div className="row" style={{ marginTop: "0.6rem" }}>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={props.live}
            onClick={props.onAdvance}
          >
            Advance 25 hours
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={props.busy}
            onClick={props.onToggleVaultPause}
          >
            {props.ledger.globalPaused ? "Resume vault" : "Pause vault"}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => props.onAskConfirm("reset")}
          >
            Reset sandbox
          </button>
        </div>
      </section>
      <section>
        <h3 className="section-title">Pay from the vault</h3>
        <p className="sub">
          The agent spends. The allowlist, the cap, and the daily limit still apply.
        </p>
        <div className="fields fields-3" style={{ marginTop: "0.8rem" }}>
          <label className="lbl">
            Payee
            <select
              className="field"
              name="payee"
              value={props.sendPayee}
              onChange={(event) => props.onSendPayee(event.target.value)}
            >
              {DIRECTORY.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="lbl">
            Amount
            <input
              className="field"
              name="send-amount"
              inputMode="numeric"
              autoComplete="off"
              value={props.sendAmt}
              onChange={(event) => props.onSendAmt(event.target.value.replace(/[^\d]/g, ""))}
            />
          </label>
          <label className="lbl">
            Memo
            <input
              className="field"
              name="memo"
              autoComplete="off"
              value={props.sendMemo}
              placeholder="invoice INV-0142…"
              onChange={(event) => props.onSendMemo(event.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: "0.75rem" }}
          disabled={!props.ready || props.busy}
          onClick={props.onSend}
        >
          Send
        </button>
      </section>
      <section>
        <h3 className="section-title">Tell the agent</h3>
        <p className="sub">
          Parsing builds a typed intent. It does not move funds until you execute it.
        </p>
        <form
          style={{ marginTop: "0.8rem" }}
          onSubmit={(event) => {
            event.preventDefault();
            props.onParse();
          }}
        >
          <label className="lbl" htmlFor="ask">
            Instruction
            <input
              id="ask"
              className="field"
              name="instruction"
              autoComplete="off"
              value={props.utterance}
              onChange={(event) => props.onUtterance(event.target.value)}
              placeholder="pay Acme Studio 120 tUSD8 for invoice INV-0142…"
            />
          </label>
          <button type="submit" className="btn btn-primary" style={{ marginTop: "0.6rem" }}>
            Parse
          </button>
        </form>
        {props.pending ? (
          <div className="banner" style={{ marginTop: "0.8rem" }}>
            <p className="sub">
              Parsed intent. A model cannot submit this. Execute uses the same checks as the
              buttons.
            </p>
            <pre className="trace">{JSON.stringify(props.pending, null, 2)}</pre>
            <p style={{ marginTop: "0.6rem" }}>
              {describeAction(props.pending).replaceAll(" · ", ", ")}
            </p>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button type="button" className="btn btn-primary" onClick={props.onExecute}>
                Execute
              </button>
              <button type="button" className="btn btn-quiet" onClick={props.onDismiss}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

function InvoiceScreen(props: ConsoleViewProps) {
  const oracle = props.ledger.x402[0];
  return (
    <>
      <h2 className="screen-title">Invoices</h2>
      <section>
        <p className="sub">
          Escrow holds the funds until delivery is confirmed, or an arbiter decides.
        </p>
        {props.ledger.invoices.length === 0 ? <p className="empty">No invoices.</p> : null}
        <ul className="rule">
          {props.ledger.invoices.map((invoice) => (
            <li key={invoice.id}>
              <div className="who">
                <p className="mono" translate="no">
                  {invoice.id}
                </p>
                <p
                  className={
                    invoice.status === "released"
                      ? "state-ok"
                      : invoice.status === "disputed" || invoice.status === "refunded"
                        ? "state-bad"
                        : "sub"
                  }
                >
                  {invoice.status}
                </p>
              </div>
              <p style={{ marginTop: "0.25rem" }}>{invoice.metadata}</p>
              <p className="sub">
                {unit(invoice.amount)} to {labelOf(invoice.payee)}, due {formatDay(invoice.due)}
              </p>
              <div className="row" style={{ marginTop: "0.7rem" }}>
                {invoice.status === "open" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => props.onFund(invoice.id)}
                  >
                    Fund escrow
                  </button>
                ) : null}
                {invoice.status === "funded" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => props.onDelivered(invoice.id)}
                  >
                    Mark delivered
                  </button>
                ) : null}
                {invoice.status === "delivered" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => props.onConfirmInvoice(invoice.id)}
                  >
                    Confirm release
                  </button>
                ) : null}
                {invoice.status === "funded" || invoice.status === "delivered" ? (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => props.onDispute(invoice.id)}
                  >
                    Dispute
                  </button>
                ) : null}
                {invoice.status === "disputed" ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => props.onArbiter(invoice.id, true)}
                    >
                      Arbiter pays
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => props.onArbiter(invoice.id, false)}
                    >
                      Arbiter refunds
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {oracle ? (
        <section>
          <h3 className="section-title">Pay per call</h3>
          <p className="sub">
            {oracle.title} answers 402 at {unit(oracle.price)}. The agent pays, retries with the
            proof, and a reused proof is refused.
          </p>
          <pre className="trace">{`GET ${oracle.path}
← 402  price ${oracle.price} tUSD8  base ${wholeToBase(oracle.price).toString()}  payTo ${shortAddr(oracle.payTo)}
← token tUSD8  chain ${chainId}  decimals ${tusd8Decimals}`}</pre>
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={props.busy}
              onClick={props.onBuy}
            >
              Buy the oracle
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={!props.lastProof}
              onClick={props.onReplay}
            >
              Replay proof
            </button>
          </div>
          {oracle.purchases[0] ? (
            <p className="banner banner-ok">{oracle.purchases[0].body}</p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function AgentScreen(props: ConsoleViewProps & { ratio: number }) {
  return (
    <>
      <h2 className="screen-title">Agents</h2>
      <Rights {...props} />
      <section>
        <h3 className="section-title">Approve {DEFAULT_AGENT.label}</h3>
        <p className="mono" translate="no">
          {shortAddr(DEFAULT_AGENT.address)}
        </p>
        <div className="fields fields-3" style={{ marginTop: "0.8rem" }}>
          <label className="lbl">
            Per transaction
            <input
              className="field"
              name="per-tx"
              inputMode="numeric"
              autoComplete="off"
              value={props.perTx}
              onChange={(event) => props.onPerTx(event.target.value.replace(/[^\d]/g, ""))}
            />
          </label>
          <label className="lbl">
            Rolling day
            <input
              className="field"
              name="daily"
              inputMode="numeric"
              autoComplete="off"
              value={props.daily}
              onChange={(event) => props.onDaily(event.target.value.replace(/[^\d]/g, ""))}
            />
          </label>
          <label className="lbl">
            Expiry
            <select
              className="field"
              name="expiry"
              value={props.live ? "0" : props.expiryDays}
              disabled={props.live}
              onChange={(event) => props.onExpiryDays(event.target.value)}
            >
              <option value="0">No expiry</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
        </div>
        {props.live ? (
          <p className="sub" style={{ marginTop: "0.6rem" }}>
            Live approval registers with no expiry.
          </p>
        ) : null}
        <p className="group-label" style={{ marginTop: "0.85rem" }}>
          Allowlist
        </p>
        <div className="row" style={{ marginTop: "0.4rem" }}>
          {DIRECTORY.map((entry) => {
            const on = props.allow.includes(entry.address);
            return (
              <button
                key={entry.address}
                type="button"
                className="chip"
                aria-pressed={on}
                onClick={() => props.onToggleAllow(entry.address)}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: "0.85rem" }}
          disabled={!props.ready || props.busy}
          onClick={props.onRegister}
        >
          {props.agent?.active ? "Update policy" : "Approve agent"}
        </button>
        <div className="row" style={{ marginTop: "0.6rem" }}>
          <button type="button" className="btn btn-quiet" onClick={props.onTryCap}>
            Try 180 tUSD8
          </button>
        </div>
      </section>
      <section>
        <h3 className="section-title">Schedules</h3>
        <p className="sub">
          A keeper calls execute when a payment is due. A late call pays once, then waits a full
          interval.
        </p>
        <div className="fields fields-3" style={{ marginTop: "0.8rem" }}>
          <label className="lbl">
            Amount
            <input
              className="field"
              name="schedule-amount"
              inputMode="numeric"
              autoComplete="off"
              value={props.schedAmt}
              onChange={(event) => props.onSchedAmt(event.target.value.replace(/[^\d]/g, ""))}
            />
          </label>
          <label className="lbl">
            Payee
            <select
              className="field"
              name="schedule-payee"
              value={props.schedPayee}
              onChange={(event) => props.onSchedPayee(event.target.value)}
            >
              {DIRECTORY.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="lbl">
            Every
            <select
              className="field"
              name="schedule-every"
              value={props.schedEvery}
              onChange={(event) => props.onSchedEvery(event.target.value)}
            >
              <option value={String(HOUR_MS)}>Hour</option>
              <option value={String(24 * HOUR_MS)}>Day</option>
              <option value={String(7 * 24 * HOUR_MS)}>Week</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: "0.75rem" }}
          disabled={!props.ready || props.busy}
          onClick={props.onAddSchedule}
        >
          Add schedule
        </button>
        {props.ledger.schedules.length === 0 ? <p className="empty">No schedules.</p> : null}
        <ul className="rule">
          {props.ledger.schedules.map((schedule) => (
            <li key={schedule.id} className="step">
              <div>
                <p>
                  #{schedule.id} {unit(schedule.amount)} to {labelOf(schedule.payee)}
                </p>
                <p className="sub">
                  {schedule.runs} of {schedule.maxRuns}, {schedule.active ? "active" : "closed"}
                </p>
              </div>
              {schedule.active ? (
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={props.busy}
                  onClick={() => props.onExecuteSchedule(schedule.id)}
                >
                  Execute
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function ActivityScreen(props: ConsoleViewProps) {
  return (
    <>
      <h2 className="screen-title">Activity</h2>
      {props.receipts.length > 0 ? (
        <section>
          <h3 className="section-title">Chain receipts</h3>
          <ul className="feed">
            {props.receipts.map((item) => (
              <li key={item.id}>
                <p className={item.ok ? undefined : "state-bad"}>{item.title}</p>
                {item.hashes.length === 0 ? <p className="sub">{item.detail}</p> : null}
                {item.hashes.map((hash) => (
                  <a
                    key={hash}
                    className="link mono"
                    href={`${explorerUrl}/tx/${hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {hash}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="section-title">{props.live ? "Sandbox feed" : "Feed"}</h3>
        <FeedList
          feed={props.ledger.feed}
          clock={props.clock}
          empty="No payments yet. Fund the vault, approve an agent, then let it try."
        />
      </section>
    </>
  );
}

function FeedList({
  feed,
  clock,
  empty,
}: {
  feed: FeedItem[];
  clock: number | null;
  empty: string;
}) {
  if (feed.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="feed">
      {feed.map((item) => (
        <li key={item.id}>
          <div className="who">
            <p className={item.ok ? undefined : "state-bad"}>{item.title}</p>
            <time className="mono">{clock == null ? "" : rel(item.ts, clock)}</time>
          </div>
          <p className="sub">{item.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function ChainDetails({ wallet }: { wallet: string }) {
  const rows: [string, string][] = [
    ["Chain", String(chainId)],
    ["RPC", rpcUrl],
    ["Explorer", explorerUrl],
    ["Faucet", faucetUrl],
    ["Token", tusd8],
    ["Decimals", String(tusd8Decimals)],
    ["Vault", contracts.vault || "not deployed"],
    ["Escrow", contracts.escrow || "not deployed"],
    ["Router", contracts.router || "not deployed"],
    ["Auth", contracts.auth || "not deployed"],
    ["Wallet", wallet],
  ];
  return (
    <details className="details">
      <summary>Aevum</summary>
      <p className="sub">
        {configured
          ? "The vault address is set. Live mode writes to that contract."
          : "Chain settings are loaded. The contract addresses are still empty, so live mode will not invent a transaction."}
      </p>
      <dl className="config">
        {rows.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd translate="no">{value}</dd>
          </div>
        ))}
      </dl>
      <p style={{ marginTop: "0.6rem" }}>
        <a className="link" href={faucetUrl} target="_blank" rel="noreferrer">
          Open the faucet
        </a>
      </p>
    </details>
  );
}
