import { Activity, ArrowUpRight, FileText, KeyRound, Landmark } from "lucide-react";
import type { ConsoleTab } from "@/lib/float/tabs";

export const NAV: { id: ConsoleTab; label: string; icon: typeof Landmark }[] = [
  { id: "home", label: "Home", icon: Landmark },
  { id: "send", label: "Send", icon: ArrowUpRight },
  { id: "invoices", label: "Invoices", icon: FileText },
  { id: "agents", label: "Agents", icon: KeyRound },
  { id: "activity", label: "Activity", icon: Activity },
];

const moneyFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const dayFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const clockFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function money(value: number): string {
  return moneyFmt.format(value);
}

export function formatDay(ts: number): string {
  return dayFmt.format(ts);
}

export function formatClock(ts: number): string {
  return clockFmt.format(ts);
}

export const fieldClass =
  "min-h-11 w-full rounded-md border border-line-slip bg-field px-3 font-mono text-sm text-ink";
