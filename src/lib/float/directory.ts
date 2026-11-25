export interface DirectoryEntry {
  address: string;
  label: string;
}

export const DIRECTORY: DirectoryEntry[] = [
  { address: "0xA0CE51d100000000000000000000000000000142", label: "Acme Studio" },
  { address: "0xDA7A2e1a00000000000000000000000000000025", label: "DataRelay" },
  { address: "0xB01770000000000000000000000000000000B017", label: "Northwind" },
];

export const DEFAULT_AGENT = {
  address: "0xA6E1710000000000000000000000000000000001",
  label: "payables-1",
};

/** Simulation account. Not a key. Live mode shows the connected wallet instead. */
export const YOUR_ACCOUNT = "0xF10A7000000000000000000000000000000000F1";

export function shortAddr(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function resolvePayee(query: string): DirectoryEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = DIRECTORY.find((p) => p.address.toLowerCase() === q || p.label.toLowerCase() === q);
  if (exact) return exact;
  const fuzzy = DIRECTORY.filter((p) => p.label.toLowerCase().includes(q));
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

export function labelOf(address: string): string {
  return DIRECTORY.find((p) => p.address.toLowerCase() === address.toLowerCase())?.label ?? shortAddr(address);
}
