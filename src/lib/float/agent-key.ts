import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const KEY = "float.agent-key.v1";

/** The one agent this browser holds. The key can spend a mandate. It cannot withdraw. */
export function localAgent(): { address: `0x${string}` } {
  const existing = localStorage.getItem(KEY);
  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
    return { address: privateKeyToAccount(existing as `0x${string}`).address };
  }
  const privateKey = generatePrivateKey();
  localStorage.setItem(KEY, privateKey);
  return { address: privateKeyToAccount(privateKey).address };
}
