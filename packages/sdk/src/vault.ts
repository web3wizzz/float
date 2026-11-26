import {
  BaseError,
  ContractFunctionRevertedError,
  hexToSignature,
  keccak256,
  toHex,
  type Abi,
  type Account,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hash,
  type PublicClient,
  type WalletClient,
  stringToHex,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentPaidEvent, agentVaultAbi, eip3009Abi, erc20Abi } from "./abi.ts";
import { aevumTestnet, chainId, escrowAddress, tusd8, tusd8Decimals, vaultAddress, vaultDeployBlock } from "./config.ts";
import { getLogsChunked } from "./logs.ts";

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
      // Aevum accepts legacy (type 0) transactions. Do not send EIP-1559.
      type: "legacy",
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

const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Fund the vault with tUSD8 transferWithAuthorization.
 * receiveWithAuthorization requires the caller to be the recipient, so the owner cannot send it to the vault.
 * transferWithAuthorization lets the owner submit the authorization and name the vault as `to`.
 */
export async function fundVaultWithAuthorization(publicClient: PublicClient, wallet: WalletClient, amount: bigint): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const validBefore = now + 600n;
  try {
    const signature = await wallet.signTypedData({
      account,
      domain: { name: "tUSD8", version: "2", chainId, verifyingContract: tusd8 },
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: { from: account.address, to: vault, value: amount, validAfter: 0n, validBefore, nonce },
    });
    const { v, r, s } = hexToSignature(signature);
    return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
      account,
      address: tusd8,
      abi: eip3009Abi,
      functionName: "transferWithAuthorization",
      args: [account.address, vault, amount, 0n, validBefore, nonce, Number(v), r, s],
      chain: aevumTestnet,
    });
  } catch (err) {
    return { ok: false, reason: revertReason(err) };
  }
}

export interface ChainPayment {
  hash: Hash;
  agent: Address;
  payee: Address;
  amount: bigint;
}

/** Whether this address has an active mandate on the live vault. */
export async function readAgentActive(client: PublicClient, agent: Address): Promise<boolean> {
  const vault = vaultAddress();
  if (!vault) return false;
  const policy = await client.readContract({
    address: vault,
    abi: agentVaultAbi,
    functionName: "policies",
    args: [agent],
  });
  const active = Array.isArray(policy) ? policy[5] : (policy as { active?: boolean }).active;
  return Boolean(active);
}

/** Free tUSD8 in the vault, in base units. Reserved schedule funds are excluded. */
export async function readVaultAvailable(client: PublicClient): Promise<bigint | null> {
  const vault = vaultAddress();
  if (!vault) return null;
  return client.readContract({ address: vault, abi: agentVaultAbi, functionName: "availableBalance" });
}

/** AgentPaid events from the deploy block, in ranges of at most 1,000 blocks. */
export async function readVaultPayments(client: PublicClient): Promise<ChainPayment[]> {
  const vault = vaultAddress();
  if (!vault) return [];
  const logs = await getLogsChunked(client, {
    address: vault,
    event: agentPaidEvent,
    fromBlock: vaultDeployBlock,
  });
  return logs.map((log) => {
    const args = log.args as { agent?: Address; payee?: Address; amount?: bigint };
    return {
      hash: log.transactionHash ?? "0x",
      agent: args.agent ?? "0x0000000000000000000000000000000000000000",
      payee: args.payee ?? "0x0000000000000000000000000000000000000000",
      amount: args.amount ?? 0n,
    };
  });
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
  expirySeconds = 0n,
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
    args: [agent, perTx, daily, expirySeconds, false],
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

/** Owner spend. Uses payAsOwner when the deployed vault has it. Otherwise withdraws free balance and transfers tUSD8. */
export async function payAsOwnerOnVault(
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
  const writer = { writeContract: wallet.writeContract.bind(wallet), account };
  if (await vaultHas("payAsOwner(address,uint256,bytes32)", publicClient)) {
    return simulateAndSend(publicClient, writer, {
      account,
      address: vault,
      abi: agentVaultAbi,
      functionName: "payAsOwner",
      args: [payee, amount, memoBytes(memo)],
      chain: aevumTestnet,
    });
  }
  const withdrawn = await simulateAndSend(publicClient, writer, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "withdraw",
    args: [amount],
    chain: aevumTestnet,
  });
  if (!withdrawn.ok) return withdrawn;
  const withdrawnHash = withdrawn.hashes[0];
  if (withdrawnHash) await publicClient.waitForTransactionReceipt({ hash: withdrawnHash });
  const sent = await simulateAndSend(publicClient, writer, {
    account,
    address: tusd8,
    abi: erc20Abi,
    functionName: "transfer",
    args: [payee, amount],
    chain: aevumTestnet,
  });
  if (!sent.ok) return { ok: false, reason: `tUSD8 is in your wallet. The transfer did not finish. ${sent.reason}` };
  return { ok: true, hashes: [...withdrawn.hashes, ...sent.hashes] };
}

/** The browser agent signs. The connected wallet only pays gas and submits. */
export async function executeAgentIntent(
  publicClient: PublicClient,
  wallet: WalletClient,
  agentKey: `0x${string}`,
  payee: Address,
  amount: bigint,
  memo: string,
): Promise<TxResult> {
  const vault = requireVault();
  if (typeof vault !== "string") return vault;
  const account = accountOf(wallet);
  if (!("address" in account)) return account;
  const agent = privateKeyToAccount(agentKey);
  const nonce = await publicClient.readContract({
    address: vault,
    abi: agentVaultAbi,
    functionName: "nonces",
    args: [agent.address],
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const memo32 = memoBytes(memo);
  const signature = await agent.signTypedData({
    domain: { name: "Float Vault", version: "1", chainId, verifyingContract: vault },
    types: {
      PaymentIntent: [
        { name: "agent", type: "address" },
        { name: "payee", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "memo", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PaymentIntent",
    message: { agent: agent.address, payee, amount, memo: memo32, nonce, deadline },
  });
  return simulateAndSend(publicClient, { writeContract: wallet.writeContract.bind(wallet), account }, {
    account,
    address: vault,
    abi: agentVaultAbi,
    functionName: "executeIntent",
    args: [{ agent: agent.address, payee, amount, memo: memo32, nonce, deadline }, signature],
    chain: aevumTestnet,
  });
}

async function vaultHas(signature: string, publicClient: PublicClient): Promise<boolean> {
  const vault = vaultAddress();
  if (!vault) return false;
  const code = await publicClient.getBytecode({ address: vault });
  const selector = toFunctionSelector(signature).slice(2);
  return Boolean(code?.toLowerCase().includes(selector));
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
