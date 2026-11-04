// The attack lab behind GET/POST /attacks: the SDK's attack definitions, fed with real material
// from this relayer's own work (the newest archived commitments, a header the light client can
// prove, a fresh BSC window, proofs of transfers it delivered).

import { getAddress, type Hex } from 'viem';
import {
  ATTACKS,
  bsc,
  portaldot,
  readiness,
  runAttack,
  type AttackContext,
  type AttackMaterial,
} from '@backhaul/sdk';
import { HttpError, type AttackInfo, type AttackLab } from './api.js';
import type { Chains } from './chains.js';
import type { JsonlStore, OrderJob, TransferJob } from './store.js';

export function createAttackLab(ch: Chains, store: JsonlStore, cacheMs = 60_000): AttackLab {
  let cached: { at: number; ctx: AttackContext } | undefined;
  const memo = new Map<string, unknown>();
  const once = async <T>(key: string, make: () => Promise<T | undefined>): Promise<T | undefined> => {
    if (memo.has(key)) return memo.get(key) as T;
    const v = await make().catch(() => undefined);
    if (v !== undefined) memo.set(key, v);
    return v;
  };

  async function material(): Promise<AttackMaterial> {
    const m: AttackMaterial = { parliaChainId: 97 };
    const lc = ch.beefy.lc;
    const setId = await lc.currentSetId();
    m.beefy = ch.archive.forSet(setId).at(-1)?.proof;
    m.staleBeefy = ch.archive.entries().filter((e) => BigInt(e.validatorSetId) < setId).at(-1)?.proof;
    const latest = await lc.latestBlock();
    m.headerImport = await once(`header:${latest}`, () => ch.beefy.chain.headerImport(latest - 1, latest));

    const done = store.list((j) => j.type === 'transfer' && j.state === 'finalized' && !!(j as TransferJob).proof) as TransferJob[];
    const toBsc = done.filter((j) => j.src === 'portaldot').at(-1);
    if (toBsc) {
      m.portaldotCommitment = { key: toBsc.key, value: toBsc.value, proof: toBsc.proof! };
      m.transferToBsc = { t: { nonce: BigInt(toBsc.nonce), kind: toBsc.kind, recipient: toBsc.recipient, amount: BigInt(toBsc.amount) }, proof: toBsc.proof! };
      const header = Number(toBsc.proofHeader);
      const proof = await once(`absence:${toBsc.id}`, () => portaldot.buildAbsenceProof(ch.pd.client.api, ch.addrs.portaldot.Outbox!, toBsc.key, header));
      if (proof) m.presentAbsence = { key: toBsc.key, proof };
    }

    // Any log of a block the Parlia client holds will do for the receipt attacks.
    const parlia = ch.parlia;
    const finalizedBlocks = !parlia ? [] : [
      ...done.filter((j) => j.src === 'bsc').map((j) => BigInt(j.srcBlock)),
      ...ch.events.parlia.map((e) => BigInt(e.block)),
    ].sort((a, b) => (a < b ? 1 : -1));
    for (const b of finalizedBlocks.slice(0, 3)) {
      if (!(await parlia!.lc.isFinalized(b))) continue;
      m.bscReceipt = await once(`receipt:${b}`, async () => {
        const [block, receipts] = await Promise.all([ch.bsc.rpc.block(b), ch.bsc.rpc.blockReceipts(b)]);
        const idx = receipts.findIndex((r) => r.logs.length > 0);
        if (idx < 0) return undefined;
        const p = await bsc.proveReceipt(receipts, block.receiptsRoot, idx);
        return { proof: bsc.encodeCommitmentProof(p) };
      });
      if (m.bscReceipt) break;
    }

    // A fresh window above a recent BSC block, against the client's trusted sets.
    const head = await ch.bsc.rpc.blockNumber();
    const start = head - 80n - (head % 16n); // stable within a minute, so the memo holds
    m.parliaWindow = !parlia ? undefined : await once(`window:${start}`, async () => {
      const current = await parlia.lc.validatorSet();
      const prev = await parlia.lc.previousValidatorSet();
      return bsc.buildWindow(ch.bsc.rpc, start, current, { previous: prev.validators.length ? prev : undefined, tolerateUntrusted: ch.cfg.parlia.tolerant });
    });

    const open = store.list((j) => j.type === 'order' && j.state === 'open').at(-1) as OrderJob | undefined;
    if (open) m.openOrder = { chain: open.origin, originData: open.originData };
    return m;
  }

  async function context(): Promise<AttackContext> {
    if (cached && Date.now() - cached.at < cacheMs) return cached.ctx;
    const a = ch.addrs;
    const ctx: AttackContext = {
      clients: { portaldot: ch.pd.pub, bsc: ch.bsc.pub },
      targets: {
        portaldotLightClient: a.bsc.PortaldotLightClient,
        portaldotVerifier: a.bsc.PortaldotVerifier,
        bscGateway: a.bsc.BscGateway,
        parliaClient: a.portaldot.ParliaClient,
        bscVerifier: a.portaldot.BscVerifier,
        portaldotGateway: a.portaldot.PortaldotGateway,
        originSettler: { portaldot: a.portaldot.OriginSettler, bsc: a.bsc.OriginSettler },
      },
      material: await material(),
    };
    cached = { at: Date.now(), ctx };
    return ctx;
  }

  const targetAddress = (ctx: AttackContext, chain: string, target: string) => {
    const [contract] = target.split('.');
    const t = ctx.targets;
    const map: Record<string, string | undefined> = {
      PortaldotLightClient: t.portaldotLightClient,
      PortaldotVerifier: t.portaldotVerifier,
      BscGateway: t.bscGateway,
      ParliaClient: t.parliaClient,
      BscVerifier: t.bscVerifier,
      PortaldotGateway: t.portaldotGateway,
      OriginSettler: chain === 'bsc' ? t.originSettler?.bsc : t.originSettler?.portaldot,
    };
    return map[contract] ? getAddress(map[contract]!) : undefined;
  };

  return {
    async list(): Promise<AttackInfo[]> {
      const ctx = await context();
      return ATTACKS.map((a) => {
        const r = readiness(a, ctx);
        return {
          id: a.id,
          title: a.title,
          description: a.description,
          chain: a.chain,
          target: a.target,
          address: targetAddress(ctx, a.chain, a.target) ?? null,
          expects: a.expects,
          ready: r.ready,
          ...(r.ready ? {} : { missing: r.missing }),
        };
      });
    },
    async run(id: string) {
      const a = ATTACKS.find((x) => x.id === id);
      if (!a) throw new HttpError(404, 'no such attack');
      const out = await runAttack(a, await context());
      return { ...out, call: { to: out.call.to, data: out.call.data as Hex } };
    },
  };
}
