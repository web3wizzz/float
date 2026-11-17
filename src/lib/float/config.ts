/**
 * Re-export of the Aevum settings. The tUSD8 address is written only in
 * packages/sdk/src/config.ts — do not copy it here.
 */
export {
  aevumTestnet,
  chainId,
  contracts,
  escrowAddress,
  explorerUrl,
  faucetUrl,
  isHexAddress,
  rpcUrl,
  tusd8,
  tusd8Decimals,
  vaultAddress,
} from "../../../packages/sdk/src/config.ts";

import { vaultAddress } from "../../../packages/sdk/src/config.ts";

/** True only after a real vault deployment is recorded in the SDK config. */
export const configured = vaultAddress() !== null;
