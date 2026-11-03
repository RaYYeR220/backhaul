/**
 * Rehearses the Portaldot → BSC proof path with live data and no funds: on an anvil fork of BSC
 * testnet it deploys PortaldotLightClient from a fresh checkpoint of the live Portaldot chain,
 * submits a real BEEFY commitment, imports a real header through the MMR, binds the trie id of a
 * live revive contract and proves its storage through PortaldotVerifier. Then it runs the
 * BSC-side attacks against those contracts with that live material.
 *
 *   npx tsx packages/sdk/scripts/rehearse-beefy.ts [--rotate] [--port 8721]
 *
 * --rotate also waits for the next Portaldot session (up to about an hour) and rotates the client
 * to the next validator set with the archived commitment of the outgoing one.
 * Writes results/rehearsal-beefy.json.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, stringToHex, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { portaldotLightClientAbi, portaldotVerifierAbi } from '../src/abi.js';
import { loadArtifact } from '../src/artifacts.js';
import { ATTACKS, readiness, runAttack, type AttackContext } from '../src/attacks.js';
import { BSC_RPC } from '../src/chains.js';
import { startAnvil } from '../src/deploy/anvil.js';
import { jsonReplacer } from '../src/deployments.js';
import { senderFor } from '../src/evm.js';
import { fetchCheckpoint, JustificationArchive, validatorSetIdAt } from '../src/portaldot/beefy.js';
import { connectPortaldot, disconnectPortaldot, finalizedNumber } from '../src/portaldot/client.js';
import { MmrMirror } from '../src/portaldot/mmr.js';
import { buildAbsenceProof, buildBindProof, buildCommitmentProof, childInfoKey, outboxSlot, reviveSlotKey, trieIdOf } from '../src/portaldot/storage.js';
import { BeefyRelay, livePortaldotSource, type BeefyEvent } from '../src/relay/beefy.js';
import { beefyClientPort } from '../src/relay/ports.js';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ROOT = resolve(import.meta.dirname, '../../..');
const DATA = resolve(process.env.BACKHAUL_DATA ?? resolve(ROOT, 'services/relayer/data'));
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

/** A live ERC-20 on Portaldot whose balances mapping sits at slot 0, like the Outbox's commitments. */
const CONTRACT: Address = '0x1d0c17a0ee1dcf15bd05a45ae789058a0586aa68';
const HOLDER = '0xc3439de80429265793325a6b662232043ced04b6';

const anvil = await startAnvil({ port: Number(opt('port', '8721')), chainId: 97, forkUrl: process.env.BSC_RPC ?? BSC_RPC });
const pd = await connectPortaldot();
const out: Record<string, unknown> = { at: new Date().toISOString(), network: 'anvil fork of BSC testnet, live Portaldot V3 testnet data' };
try {
  const pub = createPublicClient({ transport: http(anvil.url) }) as PublicClient;
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), transport: http(anvil.url) });
  out.forkBlock = (await pub.getBlockNumber()).toString();
  const gasOf = async (hash: Hex) => (await pub.waitForTransactionReceipt({ hash })).gasUsed;

  // 1. Light client from a fresh live checkpoint (the current session's first block).
  const cp = await fetchCheckpoint(pd.api);
  log(`checkpoint: set ${cp.setId}, session start ${cp.checkpointBlock}, ${cp.signers.length} signers`);
  const lcArt = loadArtifact('PortaldotLightClient');
  const lcTx = await wallet.deployContract({ abi: lcArt.abi, bytecode: lcArt.bytecode, args: [cp.setId, cp.signers, cp.checkpointBlock, cp.checkpointMmrRoot], chain: null });
  const lcRcpt = await pub.waitForTransactionReceipt({ hash: lcTx });
  const lc = lcRcpt.contractAddress!;
  out.checkpoint = { ...cp, deployGas: lcRcpt.gasUsed };

  // 2. A real commitment and the newest header it proves, through the relay the relayer uses.
  const sender = senderFor('bsc', KEY, anvil.url);
  const archive = JustificationArchive.open(resolve(DATA, 'portaldot-justifications.jsonl'));
  const cache = resolve(DATA, 'portaldot-block-hashes.bin');
  const mirror = await MmrMirror.sync(pd, cache, log);
  const events: BeefyEvent[] = [];
  const relay = new BeefyRelay(beefyClientPort(pub, sender, lc), livePortaldotSource(pd, mirror, cache), archive, { log, onEvent: (e) => events.push(e) });
  const h = await relay.ensureHeader(cp.checkpointBlock);
  const commitment = events.find((e) => e.kind === 'commitment')!;
  const header = events.find((e) => e.kind === 'header')!;
  out.commitment = { block: commitment.block, setId: commitment.setId, gasUsed: await gasOf(commitment.tx) };
  out.header = { number: h, gasUsed: await gasOf(header.tx), stateRoot: await pub.readContract({ address: lc, abi: portaldotLightClientAbi, functionName: 'stateRootOf', args: [h] }) };
  log(`header ${h} imported; state root ${(out.header as any).stateRoot}`);

  // 3. PortaldotVerifier over a live revive contract: bind its trie id, then prove a slot.
  const vArt = loadArtifact('PortaldotVerifier');
  const vRcpt = await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: vArt.abi, bytecode: vArt.bytecode, args: [lc, CONTRACT], chain: null }) });
  const verifier = vRcpt.contractAddress!;
  const trieId = await trieIdOf(pd.api, CONTRACT, h);
  const bindHash = await wallet.writeContract({ address: verifier, abi: portaldotVerifierAbi, functionName: 'bindTrieId', args: [h, await buildBindProof(pd.api, CONTRACT, h)], chain: null });
  const bindGas = await gasOf(bindHash);
  out.bind = { contract: CONTRACT, header: h, trieId, onChainTrieId: await pub.readContract({ address: verifier, abi: portaldotVerifierAbi, functionName: 'trieId' }), gasUsed: bindGas };

  const key = `0x${'00'.repeat(12)}${HOLDER.slice(2)}` as Hex;
  const raw = await pd.api.rpc.childstate.getStorage(childInfoKey(trieId), reviveSlotKey(outboxSlot(key)), await pd.api.rpc.chain.getBlockHash(h));
  const value = ((raw as any).isSome ? (raw as any).unwrap().toHex() : `0x${'00'.repeat(32)}`) as Hex;
  const proof = await buildCommitmentProof(pd.api, CONTRACT, key, h);
  const verify = (k: Hex, v: Hex, p: Hex) => pub.readContract({ address: verifier, abi: portaldotVerifierAbi, functionName: 'verifyCommitment', args: [k, v, p] });
  const absentKey = keccak256(stringToHex(`backhaul rehearsal ${Date.now()}`));
  const absence = await buildAbsenceProof(pd.api, CONTRACT, absentKey, h);
  const present = await buildAbsenceProof(pd.api, CONTRACT, key, h);
  const at = await pd.api.at(await pd.api.rpc.chain.getBlockHash(h));
  const ts = BigInt((await at.query.timestamp.now()).toString()) / 1000n;
  const absent = (k: Hex, nb: bigint, p: Hex) => pub.readContract({ address: verifier, abi: portaldotVerifierAbi, functionName: 'verifyAbsence', args: [k, nb, p] });
  out.storage = {
    key,
    value,
    verifyCommitment: await verify(key, value, proof),
    verifyCommitmentOtherValue: await verify(key, `0x${(BigInt(value) + 1n).toString(16).padStart(64, '0')}`, proof),
    verifyCommitmentGas: (await pub.estimateGas({ to: verifier, data: encodeFunctionData({ abi: portaldotVerifierAbi, functionName: 'verifyCommitment', args: [key, value, proof] }) })).toString(),
    proofBytes: (proof.length - 2) / 2,
    absentKey,
    headerTimestamp: ts,
    verifyAbsence: await absent(absentKey, ts, absence),
    verifyAbsenceBeforeDeadline: await absent(absentKey, ts + 1n, absence),
    verifyAbsenceOfPresentSlot: await absent(key, 0n, present),
  };
  log(`storage: ${JSON.stringify(out.storage, jsonReplacer)}`);

  // 4. The BSC-side attacks, from this live material.
  const setId = await pub.readContract({ address: lc, abi: portaldotLightClientAbi, functionName: 'currentSetId' });
  const latest = Number(await pub.readContract({ address: lc, abi: portaldotLightClientAbi, functionName: 'latestBlock' }));
  const ctx: AttackContext = {
    clients: { bsc: pub },
    targets: { portaldotLightClient: lc, portaldotVerifier: verifier },
    material: {
      beefy: archive.forSet(setId).at(-1)?.proof,
      staleBeefy: archive.entries().filter((e) => BigInt(e.validatorSetId) < setId).at(-1)?.proof,
      headerImport: await livePortaldotSource(pd, mirror, cache).headerImport(latest - 2, latest),
      portaldotCommitment: { key, value, proof },
      presentAbsence: { key, proof: present },
    },
  };
  const attacks = [];
  for (const a of ATTACKS.filter((x) => x.chain === 'bsc')) {
    if (!readiness(a, ctx).ready) {
      attacks.push({ id: a.id, skipped: readiness(a, ctx).missing.join(', ') });
      continue;
    }
    const o = await runAttack(a, ctx);
    attacks.push({ id: a.id, reason: o.reason, defended: o.defended });
    log(`attack ${a.id}: ${o.reason} ${o.defended ? 'DEFENDED' : 'NOT DEFENDED'}`);
  }
  out.attacks = attacks;

  // 5. Optionally a real validator-set rotation at the next session boundary.
  if (argv.includes('--rotate')) {
    const stop = await archive.subscribe(pd.provider);
    log(`waiting for set ${setId + 1n} (archiving justifications meanwhile)`);
    for (;;) {
      const head = await finalizedNumber(pd.api);
      if ((await validatorSetIdAt(pd.api, head)) > setId) break;
      await relay.refreshArchive();
      await new Promise((r) => setTimeout(r, 30_000));
    }
    await new Promise((r) => setTimeout(r, 30_000));
    const before = events.length;
    const n = await relay.rotateIfNeeded();
    await stop();
    const rot = events.slice(before);
    out.rotation = {
      rotations: n,
      setId: (await pub.readContract({ address: lc, abi: portaldotLightClientAbi, functionName: 'currentSetId' })).toString(),
      steps: await Promise.all(rot.map(async (e) => ({ kind: e.kind, block: e.block, setId: e.setId, gasUsed: await gasOf(e.tx) }))),
    };
    log(`rotation: ${JSON.stringify(out.rotation, jsonReplacer)}`);
  }

  const path = resolve(ROOT, 'results', 'rehearsal-beefy.json');
  writeFileSync(path, JSON.stringify(out, jsonReplacer, 2) + '\n');
  log(`wrote ${path}`);
} finally {
  await disconnectPortaldot(pd);
  anvil.stop();
}
process.exit(0);
