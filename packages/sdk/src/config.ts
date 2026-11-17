import { defineChain } from "viem";

/** QDay Aevum testnet. This file is the only place the tUSD8 address is written. */
export const chainId = 44005;
export const rpcUrl = "https://rpc-test.qday.info";
export const explorerUrl = "https://explorer-test.qday.info";
export const faucetUrl = "https://faucet.qday.info";

/** UNVERIFIED until confirmed against the token contract. */
export const tusd8Decimals = 6;

export const tusd8 = "0x456569838f1d43009A91ebA4263147Afd7233483" as const;

/** Vault deployment addresses. Empty until forge script records them here. */
export const contracts = {
  vault: "",
  escrow: "",
  router: "",
  auth: "",
} as const;

export const aevumTestnet = defineChain({
  id: chainId,
  name: "Aevum testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Aevum", url: explorerUrl } },
});

export function isHexAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function vaultAddress(): `0x${string}` | null {
  return isHexAddress(contracts.vault) ? contracts.vault : null;
}

export function escrowAddress(): `0x${string}` | null {
  return isHexAddress(contracts.escrow) ? contracts.escrow : null;
}
