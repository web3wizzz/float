import {
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  type Account,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hash,
  type PublicClient,
  type WalletClient,
  stringToHex,
} from "viem";
import { agentVaultAbi, erc20Abi } from "./abi.ts";
import { aevumTestnet, chainId, escrowAddress, tusd8, tusd8Decimals, vaultAddress } from "./config.ts";

export interface TxOk {
  ok: true;
  hashes: Hash[];
}

export interface TxFail {
  ok: false;
  reason: string;
}

export type TxResult = TxOk | TxFail;

type VaultWriter = {
  writeContract: WalletClient["writeContract"];
  account: Account;
};

function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((item) => item instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? "ContractReverted";
      const args = revert.data?.args;
      if (!args || args.length === 0) return name;
      const rendered = args.map((arg) => (typeof arg === "bigint" ? arg.toString() : String(arg))).join(", ");
      return `${name}(${rendered})`;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : "reverted";
}

function requireVault(): `0x${string}` | TxFail {
  const vault = vaultAddress();
  if (!vault) return { ok: false, reason: "Vault address is empty. Deploy Float and set contracts.vault in packages/sdk/src/config.ts." };
  return vault;
}

function accountOf(wallet: WalletClient): Account | TxFail {
  if (!wallet.account) return { ok: false, reason: "Connect a wallet on Aevum before sending a transaction." };
  return wallet.account;
}

async function simulateAndSend<const abi extends Abi, functionName extends ContractFunctionName<abi, "nonpayable">>(
  publicClient: PublicClient,
  wallet: VaultWriter,
  parameters: {
    account: Account;
    address: Address;
    abi: abi;
    functionName: functionName;
    args: ContractFunctionArgs<abi, "nonpayable", functionName>;
    chain: typeof aevumTestnet;
  },
): Promise<TxResult> {
  if (publicClient.chain && publicClient.chain.id !== chainId) {
    return { ok: false, reason: `Wrong network ${publicClient.chain.id}. Switch to Aevum ${chainId}.` };
  }
  try {
    await publicClient.simulateContract(parameters);
    const hash = await wallet.writeContract({
      abi: parameters.abi,
      address: parameters.address,
      functionName: parameters.functionName,
      args: parameters.args,
      account: wallet.account,
      chain: parameters.chain,
    } as Parameters<WalletClient["writeContract"]>[0]);
    return { ok: true, hashes: [hash] };
  } catch (err) {
    return { ok: false, reason: revertReason(err) };
  }
}

export function memoBytes(memo: string): `0x${string}` {
  const trimmed = memo.slice(0, 31);
  return stringToHex(trimmed, { size: 32 });
}

export function wholeToBase(amount: number): bigint {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Amount must be a positive whole number of tUSD8.");
  return BigInt(amount) * 10n ** BigInt(tusd8Decimals);
}

export async function depositToVault(publicClient: PublicClient, wallet: WalletClient, amount: bigint): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  const writer = { writeContract: wallet.writeContract.bind(wallet), account };
  const approve = await simulateAndSend(publicClient, writer, {
    account,
    address: tusd8,
    abi: erc20Abi,
    functionName: "approve",
    args: [vault, amount],
    chain: aevumTestnet,
  });
  if (!approve.ok) return approve;
  const deposited = await simulateAndSend(publicClient, writer, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "deposit",
    args: [amount],
    chain: aevumTestnet,
  });
  if (!deposited.ok) return deposited;
  return { ok: true, hashes: [...approve.hashes, ...deposited.hashes] };
}

export async function withdrawFromVault(publicClient: PublicClient, wallet: WalletClient, amount: bigint): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "withdraw",
    args: [amount],
    chain: aevumTestnet,
  });
}

export async function registerOnVault(
  publicClient: PublicClient,
  wallet: WalletClient,
  agent: Address,
  perTx: bigint,
  daily: bigint,
  allow: readonly Address[],
): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  const writer = { writeContract: wallet.writeContract.bind(wallet), account };
  const registered = await simulateAndSend(publicClient, writer, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "registerAgent",
    args: [agent, perTx, daily, 0n, false],
    chain: aevumTestnet,
  });
  if (!registered.ok) return registered;
  const hashes = [...registered.hashes];
  for (const payee of allow) {
    const set = await simulateAndSend(publicClient, writer, {
      account,
      address: vault,
      abi: agentVaultAbi,
      functionName: "setPayee",
      args: [agent, payee, true],
      chain: aevumTestnet,
    });
    if (!set.ok) return set;
    hashes.push(...set.hashes);
  }
  return { ok: true, hashes };
}

export async function payFromVault(
  publicClient: PublicClient,
  wallet: WalletClient,
  payee: Address,
  amount: bigint,
  memo: string,
): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "pay",
    args: [payee, amount, memoBytes(memo)],
    chain: aevumTestnet,
  });
}

export async function pauseAgentOnVault(publicClient: PublicClient, wallet: WalletClient, agent: Address, paused: boolean): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "setAgentPaused",
    args: [agent, paused],
    chain: aevumTestnet,
  });
}

export async function pauseVaultOnVault(publicClient: PublicClient, wallet: WalletClient, paused: boolean): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "setGlobalPaused",
    args: [paused],
    chain: aevumTestnet,
  });
}

export async function createScheduleOnVault(
  publicClient: PublicClient,
  wallet: WalletClient,
  agent: Address,
  payee: Address,
  amount: bigint,
  intervalSeconds: bigint,
  maxRuns: number,
  memo: string,
): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "createSchedule",
    args: [agent, payee, amount, intervalSeconds, maxRuns, memoBytes(memo)],
    chain: aevumTestnet,
  });
}

export async function executeScheduleOnVault(publicClient: PublicClient, wallet: WalletClient, id: bigint): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "executeSchedule",
    args: [id],
    chain: aevumTestnet,
  });
}

export async function revokeOnVault(publicClient: PublicClient, wallet: WalletClient, agent: Address): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "revokeAgent",
    args: [agent],
    chain: aevumTestnet,
  });
}

export async function fundInvoiceOnVault(publicClient: PublicClient, wallet: WalletClient, invoiceId: bigint): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  if (!escrowAddress()) return { ok: false, reason: "Escrow address is empty in packages/sdk/src/config.ts." };
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "fundInvoice",
    args: [invoiceId],
    chain: aevumTestnet,
  });
}
