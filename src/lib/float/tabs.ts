export const TABS = ["home", "send", "invoices", "agents", "activity"] as const;

export type ConsoleTab = (typeof TABS)[number];

export function parseTab(value: unknown): ConsoleTab {
  if (value === "send" || value === "invoices" || value === "agents" || value === "activity" || value === "home") {
    return value;
  }
  return "home";
}

export const TAB_TITLE: Record<ConsoleTab, string> = {
  home: "Vault",
  send: "Send",
  invoices: "Invoices",
  agents: "Agents",
  activity: "Activity",
};
