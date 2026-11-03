// Captures the BscFeed fixture: the Chainlink BNB/USD proxy and aggregator on BSC testnet, proven
// at three real blocks, each with the header window that finalizes it.
//
//   npx tsx scripts/fixtures-bsc-feed.ts
//
// Writes contracts/test/fixtures/bsc-feed.json with snapshots
//   a      round R at block X
//   aLater the same round R at a later block (a replay of round R from a fresher block)
//   b      a later round R' > R
// and one checkpoint whose validator set finalizes all three windows.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Hex } from 'viem';
import { BscClient, BSC_TESTNET_CHAIN_ID } from '../src/bsc/client.js';
import { checkpointAt, type ParliaCheckpoint } from '../src/bsc/checkpoint.js';
import { BNB_USD_DECIMALS, BNB_USD_PROXY, grabFeedProof, HOT_VARS_SLOT, PROXY_PHASE_SLOT, TRANSMISSIONS_SLOT, type FeedProof } from '../src/bsc/feed.js';
import { headerRlp } from '../src/bsc/header.js';
import { buildWindow, type HeaderSource } from '../src/bsc/window.js';

const EPOCH_LENGTH = 1000n;
const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', '..', '..', 'contracts', 'test', 'fixtures', 'bsc-feed.json');
const client = new BscClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

/** Headers from the node, but only once they exist (the window is built above a fresh head). */
const waitingSource: HeaderSource = {
  async headerRlps(from, count) {
    while ((await client.blockNumber()) < from + BigInt(count) - 1n) await sleep(3000);
    return (await client.blocks(from, count)).map(headerRlp);
  },
};

async function snapshot(name: string, cp: ParliaCheckpoint) {
  const p = await grabFeedProof(client);
  log(`${name}: block ${p.blockNumber}, round ${p.aggregatorRound} (roundId ${p.roundId}), answer ${p.answer}, updatedAt ${p.updatedAt}`);
  const rlps = await buildWindow(waitingSource, p.blockNumber, { ...cp }, { epochLength: EPOCH_LENGTH, maxHeaders: 96 });
  log(`${name}: ${rlps.length}-header window`);
  return { proof: p, rlps };
}

/** Testnet BNB/USD rounds come every 20–30 minutes (heartbeat or deviation). */
async function waitForRound(after: number): Promise<void> {
  log(`waiting for a round after ${after}`);
  for (let i = 0; i < 720; i++) {
    const p = await grabFeedProof(client);
    if (p.aggregatorRound > after) return;
    await sleep(5000);
  }
  throw new Error(`no new round after ${after} within an hour`);
}

function json(p: FeedProof, rlps: Hex[]) {
  return {
    blockNumber: p.blockNumber,
    blockHash: p.blockHash,
    stateRoot: p.stateRoot,
    timestamp: p.timestamp,
    phaseId: p.phaseId,
    aggregatorRound: p.aggregatorRound,
    roundId: p.roundId,
    answer: p.answer,
    updatedAt: p.updatedAt,
    proxyAccountProof: p.proxyAccountProof,
    phaseProof: p.phaseProof,
    aggregatorAccountProof: p.aggregatorAccountProof,
    hotVarsProof: p.hotVarsProof,
    transmissionProof: p.transmissionProof,
    rlps,
  };
}

async function main() {
  // The trusted set: the latest epoch whose set already seals at the head.
  const head = await client.blockNumber();
  let epoch = head - (head % EPOCH_LENGTH);
  let cp = await checkpointAt(client, epoch, EPOCH_LENGTH);
  if (head < cp.activeFrom + 5n) {
    epoch -= EPOCH_LENGTH;
    cp = await checkpointAt(client, epoch, EPOCH_LENGTH);
  }
  log(`checkpoint: epoch ${cp.epoch}, ${cp.validators.length} validators, active from ${cp.activeFrom}`);

  const a = await snapshot('a', cp);
  let aLater = await snapshot('aLater', cp);
  if (aLater.proof.aggregatorRound !== a.proof.aggregatorRound) {
    // The round moved already: take a new "a" and try again right away.
    log('round moved between a and aLater; retrying once');
    Object.assign(a, aLater);
    aLater = await snapshot('aLater', cp);
    if (aLater.proof.aggregatorRound !== a.proof.aggregatorRound) throw new Error('rounds move too fast for the aLater snapshot');
  }
  await waitForRound(aLater.proof.aggregatorRound);
  const b = await snapshot('b', cp);
  if (getAddress(b.proof.aggregator) !== getAddress(a.proof.aggregator)) throw new Error('the proxy switched aggregators mid-capture');

  const out = {
    description:
      'Chainlink BNB/USD on BSC testnet: proxy slot 2 (phase id, aggregator) and the OCR1 aggregator slots 43 ' +
      '(s_hotVars) and keccak(round, 44) (s_transmissions), grabbed at latest and pinned by stateRoot, each with ' +
      'the header window that finalizes its block under `checkpoint`. a and aLater hold the same round; b a later one.',
    chainId: BSC_TESTNET_CHAIN_ID,
    epochLength: EPOCH_LENGTH,
    proxy: getAddress(BNB_USD_PROXY),
    aggregator: a.proof.aggregator,
    decimals: BNB_USD_DECIMALS,
    slots: { proxyPhase: PROXY_PHASE_SLOT, hotVars: HOT_VARS_SLOT, transmissions: TRANSMISSIONS_SLOT },
    checkpoint: { epoch: cp.epoch, timestamp: cp.timestamp, activeFrom: cp.activeFrom, turnLength: cp.turnLength, validators: cp.validators },
    a: json(a.proof, a.rlps),
    aLater: json(aLater.proof, aLater.rlps),
    b: json(b.proof, b.rlps),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, (_k, x) => (typeof x === 'bigint' ? (x > BigInt(Number.MAX_SAFE_INTEGER) ? x.toString() : Number(x)) : x), 2) + '\n');
  log(`wrote ${outPath}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
