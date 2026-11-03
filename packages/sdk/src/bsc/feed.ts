// The data bridge's demo feed: Chainlink BNB/USD on BSC testnet, proven on Portaldot by BscFeed.
//
// Storage layout, confirmed by eth_getStorageAt probing on BSC testnet against the contracts' own
// getters (proxy.aggregator()/phaseId(), aggregator.latestRoundData()) and against the source of
// libocr's OffchainAggregator.sol:
//   EACAggregatorProxy 0x2514…7526, slot 2 = AggregatorProxy.currentPhase: Phase{uint16 id; address aggregator}
//     → id in bits 0..15, aggregator in bits 16..175.
//   AccessControlledOffchainAggregator 3.0.0 (OCR1): Owned (slots 0–1), OffchainAggregatorBilling
//     (slots 2–42), then
//     slot 43 = s_hotVars: {bytes16 latestConfigDigest; uint40 latestEpochAndRound; uint8 threshold;
//               uint32 latestAggregatorRoundId} → round id in bits 176..207;
//     slot 44 = s_transmissions: mapping(uint32 => Transmission{int192 answer; uint64 timestamp}).
// The proxy reports roundId = phaseId << 64 | aggregator round, and startedAt = updatedAt = timestamp.

import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { bscFeedAbi } from '../abi.js';
import type { BscClient } from './client.js';
import { grabStorageProofs, type GrabOptions } from './storage.js';

/** Chainlink BNB/USD proxy on BSC testnet. */
export const BNB_USD_PROXY: Address = '0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526';
export const BNB_USD_DECIMALS = 8;

export const PROXY_PHASE_SLOT = 2n;
export const HOT_VARS_SLOT = 43n;
export const TRANSMISSIONS_SLOT = 44n;

const slotHex = (n: bigint): Hex => pad(toHex(n), { size: 32 });

/** Storage slot of `s_transmissions[round]` in the aggregator. */
export function transmissionSlot(aggregatorRound: number | bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(aggregatorRound), TRANSMISSIONS_SLOT]));
}

/** Phase{uint16 id; address aggregator} from the proxy's slot 2. */
export function decodePhase(word: Hex | bigint): { phaseId: number; aggregator: Address } {
  const w = BigInt(word);
  return {
    phaseId: Number(w & 0xffffn),
    aggregator: getAddress(pad(toHex((w >> 16n) & ((1n << 160n) - 1n)), { size: 20 })),
  };
}

/** latestAggregatorRoundId from s_hotVars. */
export function decodeHotVarsRound(word: Hex | bigint): number {
  return Number((BigInt(word) >> 176n) & 0xffffffffn);
}

/** Transmission{int192 answer; uint64 timestamp}. */
export function decodeTransmission(word: Hex | bigint): { answer: bigint; timestamp: bigint } {
  const w = BigInt(word);
  let answer = w & ((1n << 192n) - 1n);
  if (answer >> 191n) answer -= 1n << 192n;
  return { answer, timestamp: w >> 192n };
}

/** The proxy's round id: phaseId << 64 | aggregator round. */
export function proxyRoundId(phaseId: number, aggregatorRound: number | bigint): bigint {
  return (BigInt(phaseId) << 64n) | BigInt(aggregatorRound);
}

/** Everything BscFeed.update needs, pinned to one BSC block. */
export interface FeedProof {
  blockNumber: bigint;
  blockHash: Hex;
  stateRoot: Hex;
  timestamp: bigint;
  proxy: Address;
  aggregator: Address;
  phaseId: number;
  aggregatorRound: number;
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  proxyAccountProof: Hex[];
  phaseProof: Hex[];
  aggregatorAccountProof: Hex[];
  hotVarsProof: Hex[];
  transmissionProof: Hex[];
}

async function storageAtLatest(client: BscClient, account: Address, slot: Hex): Promise<Hex> {
  return client.request<Hex>('eth_getStorageAt', [account, slot, 'latest']);
}

/**
 * Grab-and-hold: proves the feed's latest round at the current BSC head. The proofs for both
 * accounts come from one block (matched by stateRoot); the caller then finalizes that block on
 * Portaldot (a Parlia window starting at `blockNumber`) and calls BscFeed.update.
 * Retries when the head moves to a new round or a new aggregator between the reads.
 */
export async function grabFeedProof(
  client: BscClient,
  proxy: Address = BNB_USD_PROXY,
  opts: GrabOptions & { tries?: number } = {},
): Promise<FeedProof> {
  const tries = opts.tries ?? 5;
  for (let attempt = 0; attempt < tries; attempt++) {
    const { phaseId, aggregator } = decodePhase(await storageAtLatest(client, proxy, slotHex(PROXY_PHASE_SLOT)));
    const round = decodeHotVarsRound(await storageAtLatest(client, aggregator, slotHex(HOT_VARS_SLOT)));
    const tSlot = transmissionSlot(round);
    const [p, a] = await grabStorageProofs(
      client,
      [
        { account: proxy, slots: [slotHex(PROXY_PHASE_SLOT)] },
        { account: aggregator, slots: [slotHex(HOT_VARS_SLOT), tSlot] },
      ],
      opts,
    );
    const proven = decodePhase(p.slots[0].value);
    if (proven.aggregator !== aggregator || proven.phaseId !== phaseId) continue;
    if (decodeHotVarsRound(a.slots[0].value) !== round) continue;
    const t = decodeTransmission(a.slots[1].value);
    if (t.timestamp === 0n) throw new Error(`round ${round} of ${aggregator} has no transmission`);
    return {
      blockNumber: p.blockNumber,
      blockHash: p.blockHash,
      stateRoot: p.stateRoot,
      timestamp: p.timestamp,
      proxy: getAddress(proxy),
      aggregator,
      phaseId,
      aggregatorRound: round,
      roundId: proxyRoundId(phaseId, round),
      answer: t.answer,
      updatedAt: t.timestamp,
      proxyAccountProof: p.accountProof,
      phaseProof: p.slots[0].proof,
      aggregatorAccountProof: a.accountProof,
      hotVarsProof: a.slots[0].proof,
      transmissionProof: a.slots[1].proof,
    };
  }
  throw new Error('the feed kept moving while its proofs were fetched');
}

/** Arguments of BscFeed.update, in order. */
export function feedUpdateArgs(p: FeedProof) {
  return [p.blockNumber, p.proxyAccountProof, p.phaseProof, p.aggregatorAccountProof, p.hotVarsProof, p.transmissionProof] as const;
}

/** Calldata of BscFeed.update. */
export function encodeFeedUpdate(p: FeedProof): Hex {
  return encodeFunctionData({ abi: bscFeedAbi, functionName: 'update', args: feedUpdateArgs(p) });
}
