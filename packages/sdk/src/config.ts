import { defineChain } from "viem";

/**
 * QDay Aevum testnet. This file is the only place the tUSD8 address is written.
 * `contracts/script/SdkConfig.sol` parses `chainId`, `tusd8`, and `tusd8Decimals`
 * by these export names. Keep the names stable.
 */
export const chainId = 44005;
export const rpcUrl = "https://rpc-test.qday.info";
export const explorerUrl = "https://explorer-test.qday.info";
export const faucetUrl = "https://faucet.qday.info";

/**
 * tUSD8 decimals. `decimals()` on Aevum (chain 44005, `rpcUrl` above) returns 6.
 * Confirmed with eth_call selector `0x313ce567` against `tusd8`.
 * Whole tokens scale by `10n ** BigInt(tusd8Decimals)` in `wholeToBase`.
 */
export const tusd8Decimals = 6;

export const tusd8 = "0x456569838f1d43009A91ebA4263147Afd7233483" as const;

/**
 * Live Aevum deployment from commit 62977c1, block 3478293.
 * EIP-55 checksums. `AgentVault.token()` is `tusd8`. `AgentVault.escrow()` is `escrow`.
 */
export const contracts = {
  vault: "0xCa1F3bFdFc4004EEf19111b8D4d2E420744198ce",
  escrow: "0xE6d8E06991921A56BD62Ae95340f123F53c5Eef7",
  router: "0xec74B3999870D8f1790B7e5Cbf50Ae98e084F865",
  auth: "0x33A0Dd609361De16b46a438062E41aC11fF10EF5",
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
