export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/** EIP-3009. Domain is name "tUSD8", version "2", verifyingContract this token. */
export const eip3009Abi = [
  {
    type: "function",
    name: "receiveWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export const agentPaidEvent = {
  type: "event",
  name: "AgentPaid",
  inputs: [
    { name: "agent", type: "address", indexed: true },
    { name: "payee", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "memo", type: "bytes32", indexed: false },
    { name: "caller", type: "address", indexed: true },
  ],
} as const;

export const agentVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "perTxLimit", type: "uint128" },
      { name: "dailyLimit", type: "uint128" },
      { name: "expiry", type: "uint64" },
      { name: "allowAnyPayee", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPayee",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "payee", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setAgentPaused",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "paused", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setGlobalPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "paused", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "createSchedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "payee", type: "address" },
      { name: "amount", type: "uint128" },
      { name: "interval", type: "uint64" },
      { name: "maxRuns", type: "uint32" },
      { name: "memo", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "executeSchedule",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeAgent",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payee", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fundInvoice",
    stateMutability: "nonpayable",
    inputs: [{ name: "invoiceId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "error",
    name: "PayeeNotAllowed",
    inputs: [
      { name: "agent", type: "address" },
      { name: "payee", type: "address" },
    ],
  },
  {
    type: "error",
    name: "PerTxLimitExceeded",
    inputs: [
      { name: "agent", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "DailyLimitExceeded",
    inputs: [
      { name: "agent", type: "address" },
      { name: "spent", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "AgentNotActive",
    inputs: [{ name: "agent", type: "address" }],
  },
  {
    type: "error",
    name: "GloballyPaused",
    inputs: [],
  },
  { type: "error", name: "InsufficientAvailable", inputs: [{ name: "available", type: "uint256" }, { name: "amount", type: "uint256" }] },
] as const;
