// The attack lab. Each attack starts from REAL proof material (a commitment the validators signed,
// a header in the MMR, a window BSC's validators sealed, a receipt or storage proof the contracts
// accepted), tampers with exactly one thing, and is run as an eth_call against the deployed
// contract, which must revert with a named reason (or, for a view verifier, return false).

import { RLP } from '@ethereumjs/rlp';
import { bytesToHex, concatBytes, hexToBytes } from '@ethereumjs/util';
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAddress, sign } from 'viem/accounts';
import {
  bscGatewayAbi,
  bscVerifierAbi,
  originSettlerAbi,
  parliaClientAbi,
  portaldotGatewayAbi,
  portaldotLightClientAbi,
  portaldotVerifierAbi,
} from './abi.js';
import { F, decodeHeader, sealHash } from './bsc/header.js';
import type { ChainName } from './chains.js';
import { revertReason } from './evm.js';
import { decodeJustification, encodeCommitment } from './portaldot/beefy.js';

export interface TransferStruct {
  nonce: bigint;
  kind: number;
  recipient: Address;
  amount: bigint;
}

/** Contracts under attack. BSC side first, then Portaldot side. */
export interface AttackTargets {
  portaldotLightClient?: Address;
  portaldotVerifier?: Address;
  bscGateway?: Address;
  parliaClient?: Address;
  bscVerifier?: Address;
  portaldotGateway?: Address;
  /** OriginSettler on each chain, for the order attacks. */
  originSettler?: { portaldot?: Address; bsc?: Address };
}

/** Real material each attack starts from. */
export interface AttackMaterial {
  /** A BEEFY justification signed by the light client's current set. */
  beefy?: Hex;
  /** A BEEFY justification signed by an older set. */
  staleBeefy?: Hex;
  /** An MMR header import the light client accepts (its commitment is stored). */
  headerImport?: { commitmentBlock: number; headerScale: Hex; proof: { leafIndex: number; leafCount: number; items: Hex[] } };
  /** A (key, value, proof) PortaldotVerifier.verifyCommitment accepts. */
  portaldotCommitment?: { key: Hex; value: Hex; proof: Hex };
  /** A PortaldotVerifier absence-format proof for a key that holds a commitment. */
  presentAbsence?: { key: Hex; proof: Hex };
  /** BSC headers the ParliaClient would accept as a window (shortest one, lowest first). */
  parliaWindow?: Hex[];
  parliaChainId?: number;
  /** A BscVerifier-format receipt proof of a real log in a block the ParliaClient holds. */
  bscReceipt?: { proof: Hex };
  /** A transfer BscGateway already finalized, with its proof. */
  transferToBsc?: { t: TransferStruct; proof: Hex };
  /** An order that is open (unfilled) on `chain`. */
  openOrder?: { chain: ChainName; originData: Hex };
}

export interface AttackContext {
  clients: Partial<Record<ChainName, PublicClient>>;
  targets: AttackTargets;
  material: AttackMaterial;
}

export interface AttackCall {
  chain: ChainName;
  to: Address;
  data: Hex;
  /** ABI of a view whose bool result counts (false = defended). */
  viewAbi?: Abi;
  fn?: string;
}

export interface Attack {
  id: string;
  title: string;
  description: string;
  chain: ChainName;
  target: string;
  /** Error names that count as defended; "false" for a view returning false. */
  expects: string[];
  needs: { targets: (keyof AttackTargets)[]; material: (keyof AttackMaterial)[] };
  build(ctx: AttackContext): Promise<AttackCall>;
}

export interface AttackOutcome {
  id: string;
  title: string;
  chain: ChainName;
  target: string;
  call: { to: Address; data: Hex };
  reverted: boolean;
  reason: string;
  defended: boolean;
  ms: number;
}

// ------------------------------------------------------------------ tamper helpers

/** Throwaway key the lab seals forged BSC headers with. */
export const ATTACKER_KEY = keccak256(stringToHex('backhaul attack lab'));
export const ATTACKER = privateKeyToAddress(ATTACKER_KEY);
/** A nonce no gateway will reach: 2^63 + 1. */
const FRESH_NONCE = (1n << 63n) + 1n;

const flip = (h: Hex, at: number): Hex => {
  const b = hexToBytes(h);
  const i = at < 0 ? b.length + at : at;
  b[i] ^= 0x01;
  return bytesToHex(b) as Hex;
};

/** Rewrites a SCALE commitment's trailing `blockNumber: u32, validatorSetId: u64`. */
function setCommitmentTail(scale: Hex, block: number, setId: bigint): Hex {
  const b = hexToBytes(scale);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  v.setUint32(b.length - 12, block, true);
  v.setBigUint64(b.length - 8, setId, true);
  return bytesToHex(b) as Hex;
}

/** Offset of the state root in a SCALE header: parentHash[32] then the Compact<u32> number. */
function stateRootOffset(headerScale: Hex): number {
  const mode = hexToBytes(headerScale)[32] & 3;
  return 32 + (mode === 0 ? 1 : mode === 1 ? 2 : mode === 2 ? 4 : 5);
}

/** The same BSC header with the attacker as coinbase, sealed by the attacker's key. */
export async function resealHeader(rlp: Hex, chainId: number | bigint, key: Hex = ATTACKER_KEY): Promise<Hex> {
  const items = [...decodeHeader(rlp).items];
  items[F.coinbase] = hexToBytes(privateKeyToAddress(key));
  const sig = await sign({ hash: sealHash(items, chainId), privateKey: key });
  const extra = items[F.extra];
  items[F.extra] = concatBytes(extra.subarray(0, extra.length - 65), hexToBytes(sig.r), hexToBytes(sig.s), Uint8Array.of(sig.yParity ?? 0));
  return bytesToHex(RLP.encode(items)) as Hex;
}

const SLOT_PROOF = [{ type: 'uint32' }, { type: 'bytes[]' }, { type: 'bytes[]' }] as const;
const RECEIPT_PROOF = [{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }] as const;

async function read<T>(ctx: AttackContext, chain: ChainName, address: Address, abi: Abi, fn: string): Promise<T> {
  const c = ctx.clients[chain];
  if (!c) throw new Error(`no ${chain} client`);
  return (await c.readContract({ address, abi, functionName: fn })) as T;
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
};

// ------------------------------------------------------------------ the attacks

export const ATTACKS: Attack[] = [
  {
    id: 'beefy-forged-signature',
    title: 'Forged BEEFY signature',
    description:
      'A real commitment of the current validator set, moved to the next block number so it is new, with one byte of the first signature changed.',
    chain: 'bsc',
    target: 'PortaldotLightClient.submitCommitment',
    expects: ['InvalidSignature'],
    needs: { targets: ['portaldotLightClient'], material: ['beefy'] },
    async build(ctx) {
      const lc = need(ctx.targets.portaldotLightClient, 'portaldotLightClient');
      const latest = Number(await read<number>(ctx, 'bsc', lc, portaldotLightClientAbi as unknown as Abi, 'latestBlock'));
      const setId = await read<bigint>(ctx, 'bsc', lc, portaldotLightClientAbi as unknown as Abi, 'currentSetId');
      const c = encodeCommitment(need(ctx.material.beefy, 'beefy'));
      const sigs = [...c.signatures];
      sigs[0] = flip(sigs[0], 5);
      return {
        chain: 'bsc',
        to: lc,
        data: encodeFunctionData({ abi: portaldotLightClientAbi, functionName: 'submitCommitment', args: [setCommitmentTail(c.commitmentScale, latest + 1, setId), c.indices, sigs] }),
      };
    },
  },
  {
    id: 'beefy-stale-set',
    title: 'Commitment signed by a stale validator set',
    description: 'A real, correctly signed commitment from a validator set the light client has already rotated away from.',
    chain: 'bsc',
    target: 'PortaldotLightClient.submitCommitment',
    expects: ['UnknownValidatorSet'],
    needs: { targets: ['portaldotLightClient'], material: ['staleBeefy'] },
    async build(ctx) {
      const lc = need(ctx.targets.portaldotLightClient, 'portaldotLightClient');
      const j = need(ctx.material.staleBeefy, 'staleBeefy');
      const setId = await read<bigint>(ctx, 'bsc', lc, portaldotLightClientAbi as unknown as Abi, 'currentSetId');
      if (decodeJustification(j).commitment.validatorSetId >= setId) throw new Error('the stale commitment is not from an older set');
      const c = encodeCommitment(j);
      return { chain: 'bsc', to: lc, data: encodeFunctionData({ abi: portaldotLightClientAbi, functionName: 'submitCommitment', args: [c.commitmentScale, c.indices, c.signatures] }) };
    },
  },
  {
    id: 'mmr-wrong-leaf',
    title: 'MMR proof for the wrong leaf',
    description: 'A real header with a real MMR proof whose first sibling hash is changed, so the path no longer leads to the committed root.',
    chain: 'bsc',
    target: 'PortaldotLightClient.importHeader',
    expects: ['HeaderNotInMmr'],
    needs: { targets: ['portaldotLightClient'], material: ['headerImport'] },
    async build(ctx) {
      const h = need(ctx.material.headerImport, 'headerImport');
      const items = [...h.proof.items];
      items[0] = flip(items[0], 0);
      const p = { leafIndex: BigInt(h.proof.leafIndex), leafCount: BigInt(h.proof.leafCount), items };
      return { chain: 'bsc', to: need(ctx.targets.portaldotLightClient, 'portaldotLightClient'), data: encodeFunctionData({ abi: portaldotLightClientAbi, functionName: 'importHeader', args: [h.commitmentBlock, h.headerScale, p] }) };
    },
  },
  {
    id: 'header-not-in-mmr',
    title: 'Header that does not hash to its leaf',
    description: 'A real header and its real MMR proof, but the header claims a different state root.',
    chain: 'bsc',
    target: 'PortaldotLightClient.importHeader',
    expects: ['HeaderNotInMmr'],
    needs: { targets: ['portaldotLightClient'], material: ['headerImport'] },
    async build(ctx) {
      const h = need(ctx.material.headerImport, 'headerImport');
      const p = { leafIndex: BigInt(h.proof.leafIndex), leafCount: BigInt(h.proof.leafCount), items: h.proof.items };
      const forged = flip(h.headerScale, stateRootOffset(h.headerScale));
      return { chain: 'bsc', to: need(ctx.targets.portaldotLightClient, 'portaldotLightClient'), data: encodeFunctionData({ abi: portaldotLightClientAbi, functionName: 'importHeader', args: [h.commitmentBlock, forged, p] }) };
    },
  },
  {
    id: 'tampered-storage-proof',
    title: 'Tampered storage value',
    description: 'A real storage proof of a Portaldot Outbox slot, presented as proving a different value.',
    chain: 'bsc',
    target: 'PortaldotVerifier.verifyCommitment',
    expects: ['false'],
    needs: { targets: ['portaldotVerifier'], material: ['portaldotCommitment'] },
    async build(ctx) {
      const m = need(ctx.material.portaldotCommitment, 'portaldotCommitment');
      return {
        chain: 'bsc',
        to: need(ctx.targets.portaldotVerifier, 'portaldotVerifier'),
        data: encodeFunctionData({ abi: portaldotVerifierAbi, functionName: 'verifyCommitment', args: [m.key, flip(m.value, -1), m.proof] }),
        viewAbi: portaldotVerifierAbi as unknown as Abi,
        fn: 'verifyCommitment',
      };
    },
  },
  {
    id: 'replayed-nonce',
    title: 'Replayed transfer',
    description: 'A transfer the gateway already delivered, submitted again with its genuine proof.',
    chain: 'bsc',
    target: 'BscGateway.finalize',
    expects: ['AlreadyFinalized'],
    needs: { targets: ['bscGateway'], material: ['transferToBsc'] },
    async build(ctx) {
      const m = need(ctx.material.transferToBsc, 'transferToBsc');
      return { chain: 'bsc', to: need(ctx.targets.bscGateway, 'bscGateway'), data: encodeFunctionData({ abi: bscGatewayAbi, functionName: 'finalize', args: [m.t, m.proof] }) };
    },
  },
  {
    id: 'parlia-forged-header',
    title: 'BSC header sealed by a non-validator',
    description:
      'A real finality window whose first header is replaced by a forgery sealed with an attacker key. The real validators sealed the real chain, whose headers do not link to it.',
    chain: 'portaldot',
    target: 'ParliaClient.submitWindow',
    expects: ['BrokenLink'],
    needs: { targets: ['parliaClient'], material: ['parliaWindow'] },
    async build(ctx) {
      const w = need(ctx.material.parliaWindow, 'parliaWindow');
      const forged = await resealHeader(w[0], ctx.material.parliaChainId ?? 97);
      return { chain: 'portaldot', to: need(ctx.targets.parliaClient, 'parliaClient'), data: encodeFunctionData({ abi: parliaClientAbi, functionName: 'submitWindow', args: [[forged, ...w.slice(1)]] }) };
    },
  },
  {
    id: 'parlia-too-few-sealers',
    title: 'Window with fewer than 2/3 distinct sealers',
    description: 'The shortest real window that finalizes a BSC block, minus its last header: one trusted validator short of ⌈2N/3⌉.',
    chain: 'portaldot',
    target: 'ParliaClient.submitWindow',
    expects: ['TooFewSigners'],
    needs: { targets: ['parliaClient'], material: ['parliaWindow'] },
    async build(ctx) {
      const w = need(ctx.material.parliaWindow, 'parliaWindow');
      return { chain: 'portaldot', to: need(ctx.targets.parliaClient, 'parliaClient'), data: encodeFunctionData({ abi: parliaClientAbi, functionName: 'submitWindow', args: [w.slice(0, -1)] }) };
    },
  },
  {
    id: 'receipt-not-included',
    title: 'Receipt proof for a log that is not there',
    description: 'A real receipt proof from a finalized BSC block, pointing at a log index the receipt does not have.',
    chain: 'portaldot',
    target: 'BscVerifier.verifyCommitment',
    expects: ['LogIndexOutOfRange', 'false'],
    needs: { targets: ['bscVerifier'], material: ['bscReceipt'] },
    async build(ctx) {
      const [n, key, nodes, logIndex] = decodeAbiParameters(RECEIPT_PROOF, need(ctx.material.bscReceipt, 'bscReceipt').proof);
      const forged = encodeAbiParameters(RECEIPT_PROOF, [n, key, nodes, logIndex + 64n]);
      const k = keccak256(stringToHex('never committed'));
      return {
        chain: 'portaldot',
        to: need(ctx.targets.bscVerifier, 'bscVerifier'),
        data: encodeFunctionData({ abi: bscVerifierAbi, functionName: 'verifyCommitment', args: [k, k, forged] }),
        viewAbi: bscVerifierAbi as unknown as Abi,
        fn: 'verifyCommitment',
      };
    },
  },
  {
    id: 'settle-unfilled-order',
    title: 'Solver claim for an unfilled order',
    description: "An open order nobody filled, settled to the attacker with a genuine proof of some other commitment.",
    chain: 'portaldot',
    target: 'OriginSettler.settle',
    expects: ['InvalidProof', 'IncompleteProof'],
    needs: { targets: ['originSettler'], material: ['openOrder'] },
    async build(ctx) {
      const o = need(ctx.material.openOrder, 'openOrder');
      const to = need(ctx.targets.originSettler?.[o.chain], `originSettler.${o.chain}`);
      // the origin's verifier proves the other chain: borrow a real proof of that chain
      const proof = o.chain === 'portaldot' ? need(ctx.material.bscReceipt, 'bscReceipt').proof : need(ctx.material.portaldotCommitment, 'portaldotCommitment').proof;
      return { chain: o.chain, to, data: encodeFunctionData({ abi: originSettlerAbi, functionName: 'settle', args: [o.originData, ATTACKER, proof] }) };
    },
  },
  {
    id: 'refund-filled-order',
    title: 'Refund for a filled order',
    description: 'An absence proof for an Outbox slot that holds a commitment: proof that the order was filled, presented as proof that it was not.',
    chain: 'bsc',
    target: 'PortaldotVerifier.verifyAbsence',
    expects: ['false'],
    needs: { targets: ['portaldotVerifier'], material: ['presentAbsence'] },
    async build(ctx) {
      const m = need(ctx.material.presentAbsence, 'presentAbsence');
      return {
        chain: 'bsc',
        to: need(ctx.targets.portaldotVerifier, 'portaldotVerifier'),
        data: encodeFunctionData({ abi: portaldotVerifierAbi, functionName: 'verifyAbsence', args: [m.key, 0n, m.proof] }),
        viewAbi: portaldotVerifierAbi as unknown as Abi,
        fn: 'verifyAbsence',
      };
    },
  },
  {
    id: 'bnbb-beyond-locked',
    title: 'BNB.b release beyond what was locked',
    description: "A release of the gateway's whole BNB.b supply to the attacker, backed by a genuine receipt proof of a real BSC block that locked nothing of the kind.",
    chain: 'portaldot',
    target: 'PortaldotGateway.finalize',
    expects: ['InvalidProof'],
    needs: { targets: ['portaldotGateway'], material: ['bscReceipt'] },
    async build(ctx) {
      const t: TransferStruct = { nonce: FRESH_NONCE, kind: 3, recipient: ATTACKER, amount: 1_000_000n * 10n ** 18n };
      return {
        chain: 'portaldot',
        to: need(ctx.targets.portaldotGateway, 'portaldotGateway'),
        data: encodeFunctionData({ abi: portaldotGatewayAbi, functionName: 'finalize', args: [t, need(ctx.material.bscReceipt, 'bscReceipt').proof] }),
      };
    },
  },
];

/** Whether `a` has what it needs in `ctx`, and what is missing if not. */
export function readiness(a: Attack, ctx: AttackContext): { ready: boolean; missing: string[] } {
  const missing: string[] = [
    ...a.needs.targets.filter((t) => !ctx.targets[t]),
    ...a.needs.material.filter((m) => ctx.material[m] === undefined),
  ];
  if (!ctx.clients[a.chain]) missing.push(`${a.chain} client`);
  if (a.id === 'settle-unfilled-order' && ctx.material.openOrder) {
    const c = ctx.material.openOrder.chain;
    if (!ctx.targets.originSettler?.[c]) missing.push(`originSettler.${c}`);
    if (c === 'portaldot' && !ctx.material.bscReceipt) missing.push('bscReceipt');
    if (c === 'bsc' && !ctx.material.portaldotCommitment) missing.push('portaldotCommitment');
  }
  return { ready: missing.length === 0, missing };
}

/** Runs `a` as an eth_call and reports whether the contract defended itself. */
export async function runAttack(a: Attack, ctx: AttackContext): Promise<AttackOutcome> {
  const started = Date.now();
  const call = await a.build(ctx);
  const client = ctx.clients[call.chain];
  if (!client) throw new Error(`no ${call.chain} client`);
  let reverted = false;
  let reason: string;
  try {
    const r = await client.call({ to: call.to, data: call.data, account: ATTACKER });
    if (call.viewAbi && call.fn) {
      reason = String(decodeFunctionResult({ abi: call.viewAbi, functionName: call.fn, data: r.data ?? '0x' }));
    } else {
      reason = 'succeeded';
    }
  } catch (e) {
    reverted = true;
    reason = revertReason(e);
  }
  const name = reason.split('(')[0];
  return {
    id: a.id,
    title: a.title,
    chain: a.chain,
    target: a.target,
    call: { to: call.to, data: call.data },
    reverted,
    reason,
    defended: a.expects.includes(name),
    ms: Date.now() - started,
  };
}

