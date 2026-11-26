import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const KEY = "float.agent-key.v1";

function storedKey(): `0x${string}` {
  const existing = localStorage.getItem(KEY);
  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) return existing as `0x${string}`;
  const privateKey = generatePrivateKey();
  localStorage.setItem(KEY, privateKey);
  return privateKey;
}

/** The one agent this browser holds. The key can spend a mandate. It cannot withdraw. */
export function localAgent(): { address: `0x${string}` } {
  return { address: privateKeyToAccount(storedKey()).address };
}

/** Signs a payment intent. Never used to withdraw. */
export function localAgentKey(): `0x${string}` {
  return storedKey();
}
