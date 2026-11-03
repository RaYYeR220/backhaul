/**
 * Rehearses the BSC → Portaldot proof path with live data and no funds: on a local anvil node
 * (standing in for Portaldot's EVM) it deploys ParliaClient from a checkpoint several epochs old,
 * so the first window skips real epochs in which BSC swapped validators, finalizes a recent BSC
 * block with a real window, proves a real receipt log from it, then grabs an eth_getProof at the
 * head, finalizes that block too and proves an absence. Then it runs the Portaldot-side attacks
 * against those contracts with that live material.
 *
 *   npx tsx packages/sdk/scripts/rehearse-parlia.ts [--epochs-back 30] [--port 8722]
 *
 * Writes results/rehearsal-parlia.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEther,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscVerifierAbi, parliaClientAbi } from '../src/abi.js';
import { ARTIFACTS_DIR, loadArtifact } from '../src/artifacts.js';
import { ATTACKS, readiness, runAttack, type AttackContext } from '../src/attacks.js';
import { checkpointAt } from '../src/bsc/checkpoint.js';
import { BscClient } from '../src/bsc/client.js';
import { decodeHeader, parseEpochExtra } from '../src/bsc/header.js';
import { proveReceipt } from '../src/bsc/receipts.js';
import { encodeCommitmentProof, grabAbsenceProof } from '../src/bsc/verifier.js';
import { buildWindow, trustedOverlap } from '../src/bsc/window.js';
import { PORTALDOT_CHAIN_ID } from '../src/chains.js';
import { startAnvil } from '../src/deploy/anvil.js';
import { jsonReplacer } from '../src/deployments.js';
import { senderFor } from '../src/evm.js';
import { ParliaRelay, rpcBscSource, type ParliaEvent } from '../src/relay/parlia.js';
import { parliaClientPort } from '../src/relay/ports.js';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ROOT = resolve(import.meta.dirname, '../../..');
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const me = privateKeyToAccount(KEY);
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** WBNB on BSC testnet: a busy contract to prove an empty slot of. */
const WBNB: Address = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';

const anvil = await startAnvil({ port: Number(opt('port', '8722')), chainId: PORTALDOT_CHAIN_ID });
const out: Record<string, unknown> = { at: new Date().toISOString(), network: 'local anvil node standing in for Portaldot, live BSC testnet data' };
try {
  const pub = createPublicClient({ transport: http(anvil.url) }) as PublicClient;
  const wallet = createWalletClient({ account: me, transport: http(anvil.url) });
  const sender = senderFor('portaldot', KEY, anvil.url);
  const deploy = async (abi: Abi, bytecode: Hex, args: unknown[] = []) =>
    (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi, bytecode, args, chain: null }) })).contractAddress!;
  const deployNamed = (name: string, args: unknown[] = []) => {
    const a = loadArtifact(name);
    return deploy(a.abi, a.bytecode, args);
  };
  const write = async (to: Address, abi: Abi, fn: string, args: unknown[], value = 0n) => {
    const r = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: to, abi, functionName: fn, args, value, chain: null }) });
    if (r.status !== 'success') throw new Error(`${fn} failed`);
    return r;
  };
  const client = new BscClient();

  // 1. A checkpoint some epochs back, so the first window skips real set changes.
  const head0 = await client.blockNumber();
  const latestEpoch = head0 - 200n - ((head0 - 200n) % 1000n);
  let cp;
  for (let back = BigInt(opt('epochs-back', '30')); ; back = back / 2n) {
    try {
      cp = await checkpointAt(client, latestEpoch - back * 1000n);
      break;
    } catch (e) {
      log(`no snapshot ${back} epochs back (${(e as Error).message.split('\n')[0]}); trying fewer`);
      if (back === 0n) throw e;
    }
  }
  const epochsBack = Number((latestEpoch - cp.epoch) / 1000n);
  log(`checkpoint: epoch ${cp.epoch} (${epochsBack} epochs back), ${cp.validators.length} validators`);
  const lc = await deployNamed('ParliaClient', [97n, 1000n, 1_209_600n, cp]);

  // The validator sets BSC used between the checkpoint and now.
  const changes: { epoch: string; overlap: number; added: string[] }[] = [];
  for (let e = cp.epoch + 1000n; e <= latestEpoch; e += 1000n) {
    const ann = parseEpochExtra((await client.block(e)).extraData);
    const overlap = trustedOverlap(cp.validators, ann.validators);
    if (overlap < cp.validators.length || ann.validators.length !== cp.validators.length) {
      changes.push({ epoch: e.toString(), overlap, added: ann.validators.filter((v) => !cp.validators.includes(v)) });
    }
  }
  out.checkpoint = { ...cp, epochsBack, epochsWithAnotherSet: changes.length, minOverlap: Math.min(9, ...changes.map((c) => c.overlap)), changes };

  // 2. Finalize a recent block with a real window, through the relay the relayer uses.
  const events: ParliaEvent[] = [];
  const relay = new ParliaRelay(parliaClientPort(pub, sender, lc), rpcBscSource(client), { log, onEvent: (e) => events.push(e) });
  const J = head0 - 60n;
  const current = await parliaClientPort(pub, undefined, lc).validatorSet();
  const window = await buildWindow(client, J, current);
  const sealers = window.map((r) => decodeHeader(r).coinbase);
  const untrusted = [...new Set(sealers.filter((s) => !cp.validators.includes(s)))];
  const txJ = await relay.finalize(J);
  const rJ = await pub.waitForTransactionReceipt({ hash: txJ! });
  const fin = (await pub.readContract({ address: lc, abi: parliaClientAbi, functionName: 'finalized', args: [J] })) as { hash: Hex; receiptsRoot: Hex; stateRoot: Hex };
  const blockJ = await client.block(J);
  out.window = {
    block: J.toString(),
    headers: window.length,
    bytes: window.reduce((s, h) => s + (h.length - 2) / 2, 0),
    distinctSealers: new Set(sealers).size,
    untrustedSealers: untrusted,
    headersSealedByUntrusted: sealers.filter((s) => untrusted.includes(s)).length,
    gasUsed: rJ.gasUsed,
    finalizedHashMatches: fin.hash === blockJ.hash,
  };
  log(`window: ${JSON.stringify(out.window, jsonReplacer)}`);

  // 3. A real receipt log of block J (2 topics + 32 bytes of data, the shape of Committed).
  const receipts = await client.blockReceipts(J);
  let idx = -1;
  for (let i = 0; i < receipts.length && idx < 0; i++) {
    if (receipts[i].logs.some((l) => l.topics.length === 2 && (l.data.length - 2) / 2 === 32)) idx = i;
  }
  if (idx < 0) throw new Error(`no suitable log in block ${J}`);
  const p = await proveReceipt(receipts, blockJ.receiptsRoot, idx, (l) => l.topics.length === 2 && (l.data.length - 2) / 2 === 32);
  const proof = encodeCommitmentProof(p);
  const harnessJson = JSON.parse(readFileSync(resolve(ARTIFACTS_DIR, 'BscVerifier.t.sol', 'BscVerifierHarness.json'), 'utf8'));
  const harness = await deploy(harnessJson.abi, harnessJson.bytecode.object, [lc, getAddress(p.log.address), p.log.topics[0]]);
  const prod = await deployNamed('BscVerifier', [lc, getAddress(p.log.address)]);
  const vc = (to: Address, k: Hex, v: Hex) => pub.readContract({ address: to, abi: bscVerifierAbi, functionName: 'verifyCommitment', args: [k, v, proof] });
  out.receipt = {
    tx: p.txHash,
    emitter: p.log.address,
    topic0: p.log.topics[0],
    key: p.log.topics[1],
    value: p.log.data,
    proofNodes: p.proof.length,
    proofBytes: (proof.length - 2) / 2,
    verifiesWithItsTopic: await vc(harness, p.log.topics[1], p.log.data as Hex),
    otherValue: await vc(harness, p.log.topics[1], keccak256(p.log.data as Hex)),
    productionVerifierNeedsCommittedTopic: await vc(prod, p.log.topics[1], p.log.data as Hex),
    verifyGas: (await pub.estimateGas({ to: harness, data: encodeFunctionData({ abi: bscVerifierAbi, functionName: 'verifyCommitment', args: [p.log.topics[1], p.log.data as Hex, proof] }) })).toString(),
  };
  log(`receipt: ${JSON.stringify(out.receipt, jsonReplacer)}`);

  // 4. Grab-and-hold: an eth_getProof at the head, held until that block is finalized.
  const key = keccak256(stringToHex(`backhaul rehearsal ${Date.now()}`));
  const g = await grabAbsenceProof(client, WBNB, key);
  log(`grabbed an absence proof at ${g.blockNumber}; waiting for the window above it`);
  while ((await client.blockNumber()) < g.blockNumber + 70n) await sleep(5_000);
  const txX = await relay.finalize(g.blockNumber);
  const absenceVerifier = await deployNamed('BscVerifier', [lc, WBNB]);
  const va = (nb: bigint) => pub.readContract({ address: absenceVerifier, abi: bscVerifierAbi, functionName: 'verifyAbsence', args: [key, nb, g.proof] });
  out.absence = {
    account: WBNB,
    key,
    block: g.blockNumber.toString(),
    timestamp: g.timestamp.toString(),
    windowGas: (await pub.waitForTransactionReceipt({ hash: txX! })).gasUsed,
    proofBytes: (g.proof.length - 2) / 2,
    verifyAbsence: await va(g.timestamp),
    beforeDeadline: await va(g.timestamp + 1n),
  };
  log(`absence: ${JSON.stringify(out.absence, jsonReplacer)}`);

  // 5. The Portaldot-side attacks, from this live material.
  const outbox = await deployNamed('Outbox');
  const asset = await deployNamed('MockAssetPrecompile');
  const gw = await deployNamed('PortaldotGateway', [outbox, prod, asset]);
  await write(gw, loadArtifact('PortaldotGateway').abi, 'setRemote', ['0x000000000000000000000000000000000000b5c0']);
  const origin = await deployNamed('OriginSettler', [prod, outbox]);
  await write(origin, loadArtifact('OriginSettler').abi, 'setRemoteDestination', ['0x000000000000000000000000000000000000d570']);
  const orderType = {
    type: 'tuple',
    components: ['user', 'inputToken', 'inputAmount', 'outputToken', 'outputAmount', 'recipient', 'destinationChainId', 'nonce'].map((name, i) => ({
      name,
      type: ['address', 'address', 'uint256', 'address', 'uint256', 'address', 'uint64', 'uint64'][i],
    })),
  } as const;
  const order = { user: me.address, inputToken: zeroAddress, inputAmount: parseEther('1'), outputToken: zeroAddress, outputAmount: parseEther('0.99'), recipient: me.address, destinationChainId: 97n, nonce: 1n };
  const deadline = Number((await pub.getBlock()).timestamp) + 3600;
  const typeHash = keccak256(stringToHex('BackhaulOrder(address user,address inputToken,uint256 inputAmount,address outputToken,uint256 outputAmount,address recipient,uint64 destinationChainId,uint64 nonce)'));
  await write(origin, loadArtifact('OriginSettler').abi, 'open', [{ fillDeadline: deadline, orderDataType: typeHash, orderData: encodeAbiParameters([orderType], [order]) }], parseEther('1'));
  const originData = encodeAbiParameters([orderType, { type: 'uint64' }, { type: 'uint32' }], [order, BigInt(PORTALDOT_CHAIN_ID), deadline]);

  const ctx: AttackContext = {
    clients: { portaldot: pub },
    targets: { parliaClient: lc, bscVerifier: prod, portaldotGateway: gw, originSettler: { portaldot: origin } },
    material: { parliaWindow: window, parliaChainId: 97, bscReceipt: { proof }, openOrder: { chain: 'portaldot', originData } },
  };
  const attacks = [];
  for (const a of ATTACKS.filter((x) => x.chain === 'portaldot')) {
    if (!readiness(a, ctx).ready) {
      attacks.push({ id: a.id, skipped: readiness(a, ctx).missing.join(', ') });
      continue;
    }
    const o = await runAttack(a, ctx);
    attacks.push({ id: a.id, reason: o.reason, defended: o.defended });
    log(`attack ${a.id}: ${o.reason} ${o.defended ? 'DEFENDED' : 'NOT DEFENDED'}`);
  }
  out.attacks = attacks;
  out.windows = events.map((e) => ({ kind: e.kind, block: e.block, headers: e.headers, bytes: e.bytes }));

  const path = resolve(ROOT, 'results', 'rehearsal-parlia.json');
  writeFileSync(path, JSON.stringify(out, jsonReplacer, 2) + '\n');
  log(`wrote ${path}`);
} finally {
  anvil.stop();
}
process.exit(0);
