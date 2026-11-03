import { describe, expect, it } from 'vitest';
import { keccak256, parseEther, zeroAddress, type Hex } from 'viem';
import { portaldot } from '@backhaul/sdk';
import { bscProofPath, decodeOriginData, heldProofStep, JobRunner, nonceKey, outboxKeyOf, repayCommitment, transferHash, type OrderSolver } from '../src/jobs.js';
import type { OrderJob, TransferJob } from '../src/store.js';
import { A, ADDRS, FakeEnv, originData, storageProofOf, tempStore } from './helpers.js';

const TX = (n: number) => `0x${n.toString(16).padStart(64, 'a')}` as Hex;
const user = A(0xabc);

function runner(env = new FakeEnv(), solver?: OrderSolver) {
  return { env, store: tempStore(), make(store = tempStore()) { return new JobRunner(store, env, solver, { backoffBaseMs: 1, maxAttempts: 3 }); } };
}

describe('encodings', () => {
  it('derives the Outbox key and transfer value like the contracts', () => {
    const gw = ADDRS.portaldot.PortaldotGateway!;
    // independent implementation in the SDK (polkadot keccak)
    expect(outboxKeyOf(gw, nonceKey(7n))).toBe(portaldot.outboxKey(gw, nonceKey(7n)));
    const t = { nonce: 7n, kind: 1, recipient: user, amount: parseEther('1') };
    expect(transferHash(t)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(transferHash({ ...t, amount: t.amount + 1n })).not.toBe(transferHash(t));
    expect(repayCommitment(user)).toBe(keccak256(`0x${'0'.repeat(24)}${user.slice(2).toLowerCase()}`));
  });

  it('round-trips originData and takes orderId over it', () => {
    const d = originData({ user, inputToken: zeroAddress, inputAmount: 10n, outputToken: A(1), outputAmount: 9n, recipient: user, destinationChainId: 97n, nonce: 1n, originChainId: 420420777n, fillDeadline: 1234 });
    const o = decodeOriginData(d);
    expect(o.orderId).toBe(keccak256(d));
    expect([o.inputAmount, o.outputAmount, o.fillDeadline, o.originChainId]).toEqual([10n, 9n, 1234, 420420777n]);
  });
});

describe('transfers', () => {
  it('Portaldot → BSC: proves a header after the lock, then finalizes on BSC', async () => {
    const { env, make } = runner();
    const r = make();
    const t = { nonce: 3n, kind: 1, recipient: user, amount: parseEther('1') };
    const job = r.ingestLocked('portaldot', { nonce: 3n, t, tx: TX(1), block: 4000n });
    expect(job.key).toBe(outboxKeyOf(ADDRS.portaldot.PortaldotGateway!, nonceKey(3n)));
    expect(job.value).toBe(transferHash(t));

    const done = (await r.run(job)) as TransferJob;
    expect(done.state).toBe('finalized');
    expect(env.headersAsked).toEqual([4000]);
    expect(env.writes).toHaveLength(1);
    const w = env.writes[0];
    expect([w.chain, w.to, w.fn]).toEqual(['bsc', ADDRS.bsc.BscGateway, 'finalize']);
    expect(w.args[0]).toEqual(t);
    expect(w.args[1]).toBe(await env.portaldotCommitmentProof(job.key, 4005));
    expect(done.steps.map((s) => s.name)).toEqual(['locked', 'beefy', 'finalized']);
    expect(done.proofHeader).toBe('4005');
  });

  it('BSC → Portaldot: waits for confirmations, finalizes the lock block, then the transfer', async () => {
    const { env, make } = runner();
    const r = make();
    const t = { nonce: 9n, kind: 3, recipient: user, amount: parseEther('0.001') };
    env.bscHeadNumber = 5005n;
    let job = (await r.run(r.ingestLocked('bsc', { nonce: 9n, t, tx: TX(2), block: 5000n }))) as TransferJob;
    expect(job.state).toBe('locked');
    expect(job.retryAt).toBeGreaterThan(0);
    expect(env.writes).toHaveLength(0);

    env.bscHeadNumber = 5100n;
    job = (await r.run(job)) as TransferJob;
    expect(job.state).toBe('finalized');
    expect(env.finalizedBsc).toEqual([5000n]);
    expect(env.writes.map((w) => [w.chain, w.to, w.fn])).toEqual([['portaldot', ADDRS.portaldot.PortaldotGateway, 'finalize']]);
    expect(job.steps.map((s) => s.name)).toEqual(['locked', 'parlia', 'finalized']);
  });

  it('is idempotent: a transfer someone else finalized is closed without a tx', async () => {
    const { env, make } = runner();
    const r = make();
    env.finalizedNonces.add('bsc:4');
    const job = (await r.run(r.ingestLocked('portaldot', { nonce: 4n, t: { nonce: 4n, kind: 1, recipient: user, amount: 1n }, tx: TX(3), block: 1n }))) as TransferJob;
    expect(job.state).toBe('finalized');
    expect(env.writes).toHaveLength(0);
    expect(r.ingestLocked('portaldot', { nonce: 4n, t: { nonce: 4n, kind: 1, recipient: user, amount: 1n }, tx: TX(3), block: 1n }).state).toBe('finalized');
  });

  it('tells an ERC-20 vault about a repayment that reached it', async () => {
    const { env, make } = runner();
    const r = make();
    const t = { nonce: 1n, kind: 1, recipient: ADDRS.bsc.PpotVault!, amount: parseEther('9.99') };
    await r.run(r.ingestLocked('portaldot', { nonce: 1n, t, tx: TX(4), block: 10n }));
    expect(env.writes.map((w) => w.fn)).toEqual(['finalize', 'notifyRepaid']);
    expect(env.writes[1].to).toBe(ADDRS.bsc.PpotVault);
  });

  it('backs off on errors and gives up after maxAttempts', async () => {
    const { env, make } = runner();
    const store = tempStore();
    const r = make(store);
    env.failWrites = 10;
    const job = r.ingestLocked('portaldot', { nonce: 2n, t: { nonce: 2n, kind: 1, recipient: user, amount: 1n }, tx: TX(5), block: 1n });
    let j = await r.run(job);
    expect([j.attempts, j.state, j.error]).toEqual([1, 'proven', 'node said no']);
    j = await r.run(j);
    j = await r.run(j);
    expect(j.state).toBe('failed');
    expect(store.get(job.id)!.state).toBe('failed');
  });
});

function order(env: FakeEnv, over: Partial<Parameters<typeof originData>[0]> = {}) {
  const fields = {
    user,
    inputToken: zeroAddress,
    inputAmount: parseEther('10'),
    outputToken: ADDRS.bsc.PPOT!,
    outputAmount: parseEther('9.96'),
    recipient: A(0xdef),
    destinationChainId: 97n,
    nonce: 1n,
    originChainId: 420420777n,
    fillDeadline: env.clock + 600,
    ...over,
  };
  const d = originData(fields);
  return { d, id: keccak256(d) as Hex };
}

describe('orders', () => {
  it('tPOT → pPOT: vault fill on a proof of the Open, settle on a proof of the Filled, then bridge the repayment home', async () => {
    const { env, make } = runner();
    const r = make();
    const { d, id } = order(env);
    let job = r.ingestOpen('portaldot', { orderId: id, originData: d, tx: TX(10), block: 7000n });
    job = (await r.run(job)) as OrderJob;
    expect(job.vaultTried).toBe(true);
    const fill = env.writes[0];
    expect([fill.chain, fill.to, fill.fn]).toEqual(['bsc', ADDRS.bsc.PpotVault, 'fill']);
    const openKey = outboxKeyOf(ADDRS.portaldot.OriginSettler!, id);
    expect(fill.args).toEqual([id, d, await env.portaldotCommitmentProof(openKey, 7005)]);

    r.ingestFilled('bsc', { orderId: id, filler: ADDRS.bsc.PpotVault!, repayTo: ADDRS.portaldot.PotForwarder!, tx: TX(11), block: 900n });
    env.bscHeadNumber = 2000n;
    job = (await r.run(r.store.get<OrderJob>(id)!)) as OrderJob;
    expect(job.state).toBe('settled');
    expect(env.finalizedBsc).toEqual([900n]);
    const settle = env.writes[1];
    expect([settle.chain, settle.to, settle.fn]).toEqual(['portaldot', ADDRS.portaldot.OriginSettler, 'settle']);
    expect(settle.args[1]).toBe(ADDRS.portaldot.PotForwarder);
    expect(settle.args[2]).toBe((await env.bscCommitmentProof(TX(11), outboxKeyOf(ADDRS.bsc.DestinationSettler!, id))).proof);
    expect([env.writes[2].to, env.writes[2].fn]).toEqual([ADDRS.portaldot.PotForwarder, 'flush']);
    expect(job.steps.map((s) => s.name)).toEqual(['opened', 'beefy', 'vault fill', 'filled', 'parlia', 'settled', 'repayment bridged']);
  });

  it('lets the solver go first and then waits for its Filled event', async () => {
    const solver: OrderSolver = { consider: async () => ({ filled: true, reason: 'fronted', tx: TX(20) }) };
    const { env, make } = runner(new FakeEnv(), solver);
    const r = make();
    const { d, id } = order(env, { inputToken: ADDRS.bsc.PPOT!, outputToken: zeroAddress, destinationChainId: 420420777n, originChainId: 97n });
    const job = (await r.run(r.ingestOpen('bsc', { orderId: id, originData: d, tx: TX(21), block: 10n }))) as OrderJob;
    expect(job.state).toBe('open');
    expect(job.solverTried).toBe(true);
    expect(env.writes).toHaveLength(0);
    expect(job.steps.at(-1)!.name).toBe('solver fill sent');
  });

  it('a vault skips an order below its spread', async () => {
    const { env, make } = runner();
    const r = make();
    const { d, id } = order(env, { outputAmount: parseEther('9.99') });
    const job = (await r.run(r.ingestOpen('portaldot', { orderId: id, originData: d, tx: TX(30), block: 1n }))) as OrderJob;
    expect(job.vaultTried).toBe(true);
    expect(env.writes).toHaveLength(0);
    expect(job.steps.at(-1)!.detail).toMatch(/spread/);
  });

  it('refunds after the deadline on a proof that nothing was filled', async () => {
    const { env, make } = runner();
    const r = make();
    const { d, id } = order(env, { fillDeadline: env.clock - 10 });
    env.absence = { blockNumber: 3_000_000n, timestamp: BigInt(env.clock), empty: true };
    env.bscHeadNumber = 3_000_000n;
    // grabbed at the head and held until the window above it exists
    let job = (await r.run(r.ingestOpen('portaldot', { orderId: id, originData: d, tx: TX(40), block: 1n }))) as OrderJob;
    expect(job.state).toBe('open');
    expect(job.bscHeld).toMatchObject({ kind: 'absence', block: '3000000' });
    expect(env.finalizedBsc).toEqual([]);
    env.absence = { ...env.absence, blockNumber: 3_000_064n }; // a later grab would differ
    env.bscHeadNumber = 3_000_064n;
    job = (await r.run(job)) as OrderJob;
    expect(job.state).toBe('refunded');
    expect(env.finalizedBsc).toEqual([3_000_000n]);
    expect([env.writes[0].chain, env.writes[0].fn, env.writes[0].args[0]]).toEqual(['portaldot', 'refund', d]);
  });

  it('does not refund while the destination shows a fill', async () => {
    const { env, make } = runner();
    const r = make();
    const { d, id } = order(env, { fillDeadline: env.clock - 10 });
    env.absence = { blockNumber: 3_000_000n, timestamp: BigInt(env.clock), empty: false };
    const job = (await r.run(r.ingestOpen('portaldot', { orderId: id, originData: d, tx: TX(41), block: 1n }))) as OrderJob;
    expect(job.state).toBe('open');
    expect(env.writes).toHaveLength(0);
  });

  it('refunds a BSC order only with a Portaldot header past the deadline', async () => {
    const { env, make } = runner();
    const r = make();
    const { d, id } = order(env, {
      inputToken: ADDRS.bsc.PPOT!,
      outputToken: zeroAddress,
      destinationChainId: 420420777n,
      originChainId: 97n,
      fillDeadline: env.clock - 10,
    });
    env.portaldotTime = BigInt(env.clock - 100);
    let job = (await r.run(r.ingestOpen('bsc', { orderId: id, originData: d, tx: TX(42), block: 1n }))) as OrderJob;
    expect(job.state).toBe('open');
    env.portaldotTime = BigInt(env.clock);
    job = (await r.run(job)) as OrderJob;
    expect(job.state).toBe('refunded');
    expect(env.headersAsked.at(-1)).toBe(500_000 - 10);
    expect([env.writes[0].chain, env.writes[0].fn]).toEqual(['bsc', 'refund']);
  });

  it('keeps a fill seen before its order', async () => {
    const { env, make } = runner();
    const r = make();
    const { d, id } = order(env);
    r.ingestFilled('bsc', { orderId: id, filler: A(5), repayTo: A(5), tx: TX(50), block: 1n });
    const job = r.ingestOpen('portaldot', { orderId: id, originData: d, tx: TX(51), block: 1n });
    expect(job.state).toBe('filled');
    expect(job.fill!.repayTo).toBe(A(5));
  });

  it('closes an order already settled on chain', async () => {
    const { env, make } = runner();
    const r = make();
    const { d, id } = order(env);
    env.status.set(id, 2);
    const job = (await r.run(r.ingestOpen('portaldot', { orderId: id, originData: d, tx: TX(60), block: 1n }))) as OrderJob;
    expect(job.state).toBe('settled');
    expect(env.writes).toHaveLength(0);
  });

  it('lists BSC blocks still waiting for a Parlia window', () => {
    const { env, make } = runner();
    const r = make();
    r.ingestLocked('bsc', { nonce: 1n, t: { nonce: 1n, kind: 3, recipient: user, amount: 1n }, tx: TX(70), block: 30n });
    r.ingestLocked('portaldot', { nonce: 1n, t: { nonce: 1n, kind: 1, recipient: user, amount: 1n }, tx: TX(71), block: 31n });
    const { d, id } = order(env, { inputToken: ADDRS.bsc.PPOT!, outputToken: zeroAddress, destinationChainId: 420420777n, originChainId: 97n });
    r.ingestOpen('bsc', { orderId: id, originData: d, tx: TX(72), block: 20n });
    expect(r.pendingBscBlocks()).toEqual([20n, 30n]);
  });
});

describe('BSC commitments whose block can no longer be finalized', () => {
  const lock = (r: JobRunner, nonce: bigint, block: bigint) =>
    r.ingestLocked('bsc', { nonce, t: { nonce, kind: 3, recipient: user, amount: parseEther('0.001') }, tx: TX(80 + Number(nonce)), block });
  const patient = (env: FakeEnv) => new JobRunner(tempStore(), env, undefined, { backoffBaseMs: 1, maxAttempts: 10 });

  it('picks the receipt path only while the client can finalize the block and it has not kept failing', () => {
    const base = { block: 5000n, provableFrom: 4040n, receiptTries: 0, maxReceiptTries: 2 };
    expect(bscProofPath(base)).toBe('receipt');
    expect(bscProofPath({ ...base, receiptTries: 1 })).toBe('receipt');
    expect(bscProofPath({ ...base, receiptTries: 2 })).toBe('storage');
    expect(bscProofPath({ ...base, provableFrom: 5001n })).toBe('storage'); // rotated past it
    expect(bscProofPath({ ...base, provableFrom: 5000n })).toBe('receipt');
  });

  it('holds a grabbed proof until the window above its block exists', () => {
    expect(heldProofStep(undefined, 9000n, 64n)).toBe('grab');
    expect(heldProofStep(9000n, 9063n, 64n)).toBe('wait');
    expect(heldProofStep(9000n, 9064n, 64n)).toBe('finalize');
  });

  it('proves from storage at the head once the client has rotated past the lock block', async () => {
    const env = new FakeEnv();
    const r = patient(env);
    env.provableFrom = 6040n;
    env.bscHeadNumber = 6100n;
    let job = (await r.run(lock(r, 1n, 5000n))) as TransferJob;
    // grabbed at 6100 and held: nothing finalized or sent yet
    expect(job.state).toBe('locked');
    expect(job.bscHeld).toMatchObject({ kind: 'commitment', block: '6100', key: job.key });
    expect(env.finalizedBsc).toEqual([]);
    expect(env.writes).toHaveLength(0);
    expect(r.pendingBscBlocks()).toEqual([6100n]);

    env.bscHeadNumber = 6164n;
    job = (await r.run(job)) as TransferJob;
    expect(job.state).toBe('finalized');
    expect(env.storageGrabs).toEqual([6100n]); // the held proof was used, not a new one
    expect(env.finalizedBsc).toEqual([6100n]);
    expect(env.writes.map((w) => [w.chain, w.fn])).toEqual([['portaldot', 'finalize']]);
    expect(env.writes[0].args[1]).toBe(storageProofOf(job.key, 6100n));
    expect(job.proofHeader).toBe('6100');
    expect(job.steps.map((s) => s.name)).toEqual(['locked', 'storage proof', 'parlia', 'finalized']);
  });

  it('falls back to storage after the receipt path failed twice with the window headers there', async () => {
    const env = new FakeEnv();
    const r = patient(env);
    env.unfinalizable.add(5000n);
    env.bscHeadNumber = 5020n; // confirmed, but the window above 5000 can't be built yet: not counted
    let job = (await r.run(lock(r, 2n, 5000n))) as TransferJob;
    expect([job.attempts, job.bscReceipt?.tries]).toEqual([1, 0]);
    env.bscHeadNumber = 5100n;
    job = (await r.run(job)) as TransferJob;
    job = (await r.run(job)) as TransferJob;
    expect([job.attempts, job.bscReceipt?.tries, job.state]).toEqual([3, 2, 'locked']);
    // third try with the headers there: storage, grabbed at 5100
    job = (await r.run(job)) as TransferJob;
    expect(job.error).toBeUndefined();
    expect(job.bscHeld?.block).toBe('5100');
    env.bscHeadNumber = 5164n;
    job = (await r.run(job)) as TransferJob;
    expect(job.state).toBe('finalized');
    expect(env.writes[0].args[1]).toBe(storageProofOf(job.key, 5100n));
  });

  it('drops a held proof whose block fails and grabs a fresh one', async () => {
    const env = new FakeEnv();
    const r = patient(env);
    env.provableFrom = 9_999_999n;
    env.bscHeadNumber = 6100n;
    let job = (await r.run(lock(r, 3n, 5000n))) as TransferJob;
    expect(job.bscHeld?.block).toBe('6100');
    env.unfinalizable.add(6100n);
    env.bscHeadNumber = 6200n;
    job = (await r.run(job)) as TransferJob;
    expect(job.error).toMatch(/6100 does not verify/);
    expect(job.bscHeld).toBeUndefined();
    job = (await r.run(job)) as TransferJob;
    expect(job.bscHeld?.block).toBe('6200');
    expect(env.storageGrabs).toEqual([6100n, 6200n]);
  });

  it('settles a BSC fill from storage too', async () => {
    const env = new FakeEnv();
    const r = patient(env);
    const { d, id } = order(env);
    r.ingestOpen('portaldot', { orderId: id, originData: d, tx: TX(90), block: 1n });
    r.ingestFilled('bsc', { orderId: id, filler: A(5), repayTo: A(5), tx: TX(91), block: 900n });
    env.provableFrom = 2000n;
    env.bscHeadNumber = 2100n;
    let job = (await r.run(r.store.get<OrderJob>(id)!)) as OrderJob;
    expect(job.state).toBe('filled');
    env.bscHeadNumber = 2164n;
    job = (await r.run(job)) as OrderJob;
    expect(job.state).toBe('settled');
    const key = outboxKeyOf(ADDRS.bsc.DestinationSettler!, id);
    expect(env.writes.find((w) => w.fn === 'settle')!.args[2]).toBe(storageProofOf(key, 2100n));
  });

  it('refuses to hold a storage proof of a slot that is still empty', async () => {
    const env = new FakeEnv();
    const r = patient(env);
    env.provableFrom = 9_999_999n;
    env.bscHeadNumber = 6100n;
    env.slotValue = `0x${'00'.repeat(32)}`;
    const job = (await r.run(lock(r, 4n, 5000n))) as TransferJob;
    expect(job.error).toMatch(/empty in the BSC Outbox/);
    expect(job.bscHeld).toBeUndefined();
  });
});
