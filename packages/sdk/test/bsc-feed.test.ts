import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RLP } from '@ethereumjs/rlp';
import { Trie } from '@ethereumjs/trie';
import { bytesToHex, hexToBytes } from '@ethereumjs/util';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, keccak256, pad, toHex, type Hex } from 'viem';
import { bscFeedAbi } from '../src/abi.js';
import {
  BNB_USD_PROXY,
  decodeHotVarsRound,
  decodePhase,
  decodeTransmission,
  encodeFeedUpdate,
  HOT_VARS_SLOT,
  PROXY_PHASE_SLOT,
  proxyRoundId,
  transmissionSlot,
  type FeedProof,
} from '../src/bsc/feed.js';

const F = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures', 'bsc-feed.json'), 'utf8'));

const verify = (root: Hex, key: Hex, proof: Hex[]) => new Trie().verifyProof(hexToBytes(root), hexToBytes(keccak256(key)), proof.map((n) => hexToBytes(n)));

/** The value of `slot` in `account` at the snapshot's state root, read off the proofs alone. */
async function slotValue(s: any, account: Hex, accountProof: Hex[], slot: Hex, proof: Hex[]): Promise<bigint> {
  const acct = await verify(s.stateRoot, account, accountProof);
  expect(acct).not.toBeNull();
  const [, , storageRoot] = RLP.decode(acct!) as Uint8Array[];
  const raw = await verify(bytesToHex(storageRoot) as Hex, slot, proof);
  expect(raw).not.toBeNull();
  return BigInt(bytesToHex(RLP.decode(raw!) as Uint8Array));
}

describe('Chainlink BNB/USD layout on BSC testnet', () => {
  it('decodes the words the way the proxy reports them', () => {
    // Values read live from the proxy's slot 2 and the aggregator's slot 43 / s_transmissions.
    expect(decodePhase('0x00000000000000000000dbd22686749275932bf35d9a893da23505cc28040002')).toEqual({
      phaseId: 2,
      aggregator: getAddress('0xdbd22686749275932bf35d9a893da23505cc2804'),
    });
    expect(decodeHotVarsRound('0x0000000000000001627e01000b07d506431b9625c77042e5f4c8a087db883aa0')).toBe(0x1627e);
    expect(decodeTransmission('0x000000006aea2390000000000000000000000000000000000000001040ccecd8')).toEqual({ answer: 69806648536n, timestamp: 1793729424n });
    expect(decodeTransmission(`0x${'00'.repeat(8)}${'ff'.repeat(24)}`).answer).toBe(-1n);
    expect(proxyRoundId(2, 0x1627e)).toBe(0x2000000000001627en);
  });

  for (const name of ['a', 'aLater', 'b'] as const) {
    it(`snapshot ${name}: the proofs prove the recorded round`, async () => {
      const s = F[name];
      const phase = await slotValue(s, F.proxy, s.proxyAccountProof, pad(toHex(PROXY_PHASE_SLOT)), s.phaseProof);
      const { phaseId, aggregator } = decodePhase(phase);
      expect(aggregator).toBe(getAddress(F.aggregator));
      expect(phaseId).toBe(s.phaseId);

      const hot = await slotValue(s, aggregator, s.aggregatorAccountProof, pad(toHex(HOT_VARS_SLOT)), s.hotVarsProof);
      expect(decodeHotVarsRound(hot)).toBe(s.aggregatorRound);

      const t = decodeTransmission(await slotValue(s, aggregator, s.aggregatorAccountProof, transmissionSlot(s.aggregatorRound), s.transmissionProof));
      expect(t.answer).toBe(BigInt(s.answer));
      expect(t.timestamp).toBe(BigInt(s.updatedAt));
      expect(proxyRoundId(phaseId, s.aggregatorRound)).toBe(BigInt(s.roundId));
      expect(keccak256(s.rlps[0])).toBe(s.blockHash);
    });
  }

  it('encodes BscFeed.update in proof order', () => {
    const s = F.a;
    const p = {
      blockNumber: BigInt(s.blockNumber),
      proxyAccountProof: s.proxyAccountProof,
      phaseProof: s.phaseProof,
      aggregatorAccountProof: s.aggregatorAccountProof,
      hotVarsProof: s.hotVarsProof,
      transmissionProof: s.transmissionProof,
    } as FeedProof;
    const { functionName, args } = decodeFunctionData({ abi: bscFeedAbi, data: encodeFeedUpdate(p) });
    expect(functionName).toBe('update');
    expect(args).toEqual([p.blockNumber, s.proxyAccountProof, s.phaseProof, s.aggregatorAccountProof, s.hotVarsProof, s.transmissionProof]);
    expect(getAddress(F.proxy)).toBe(getAddress(BNB_USD_PROXY));
  });
});
