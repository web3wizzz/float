import type { AbiEvent, PublicClient } from "viem";

/** Largest block range a single eth_getLogs call may cover on Aevum. */
export const MAX_LOG_RANGE = 1000n;

export async function getLogsChunked(
  client: PublicClient,
  parameters: {
    address: `0x${string}`;
    event: AbiEvent;
    fromBlock: bigint;
    toBlock?: bigint;
  },
) {
  const end = parameters.toBlock ?? (await client.getBlockNumber());
  const out = [];
  for (let start = parameters.fromBlock; start <= end; start += MAX_LOG_RANGE) {
    const stop = start + MAX_LOG_RANGE - 1n > end ? end : start + MAX_LOG_RANGE - 1n;
    const logs = await client.getLogs({
      address: parameters.address,
      event: parameters.event,
      fromBlock: start,
      toBlock: stop,
    });
    out.push(...logs);
  }
  return out;
}
