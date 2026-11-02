import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Trie } from '@ethereumjs/trie';
import { RLP } from '@ethereumjs/rlp';
import { bytesToHex, hexToBytes } from '@ethereumjs/util';
import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import type { RpcProof, RpcReceipt } from '../src/bsc/client.js';
import { buildReceiptsTrie, encodeReceipt, proveReceipt } from '../src/bsc/receipts.js';
import { stateRootOf } from '../src/bsc/storage.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const R = load('bsc-receipt.json');
const S = load('bsc-storage.json');

describe('BSC receipt proofs', () => {
  it('rebuilds the receipts trie to the header receiptsRoot', async () => {
    const trie = await buildReceiptsTrie(R.rawReceipts);
    expect(bytesToHex(trie.root())).toBe(R.receiptsRoot);
  });

  it('encodes typed receipts with a type byte and legacy ones without', () => {
    const typed = encodeReceipt(R.rawReceipts[R.typed.txIndex]);
    const legacy = encodeReceipt(R.rawReceipts[R.legacy.txIndex]);
    expect(typed[0]).toBe(R.typed.txType);
    expect(legacy[0]).toBeGreaterThanOrEqual(0xc0);
  });

  it('reproduces the committed proofs and they verify', async () => {
    for (const which of ['typed', 'legacy'] as const) {
      const f = R[which];
      const p = await proveReceipt(R.rawReceipts, R.receiptsRoot, f.txIndex, (_l, i) => i === f.logIndex);
      expect(p.key).toBe(f.key);
      expect(p.proof).toEqual(f.proof);
      const value = await new Trie().verifyProof(hexToBytes(R.receiptsRoot), hexToBytes(p.key), p.proof.map((n) => hexToBytes(n)));
      expect(value).not.toBeNull();
      expect(bytesToHex(value!)).toBe(bytesToHex(encodeReceipt(R.rawReceipts[f.txIndex])));
    }
  });

  it('refuses receipts that do not rebuild the header root', async () => {
    const tampered: RpcReceipt[] = structuredClone(R.rawReceipts);
    tampered[R.legacy.txIndex].logs[R.legacy.logIndex].data = `0x${'11'.repeat(32)}` as Hex;
    await expect(proveReceipt(tampered, R.receiptsRoot, R.legacy.txIndex)).rejects.toThrow(/receipts root/);
  });
});

describe('BSC storage proofs', () => {
  const accountKey = (a: string) => hexToBytes(keccak256(a as Hex));
  const slotKey = (s: string) => hexToBytes(keccak256(s as Hex));
  const verify = (root: Hex, key: Uint8Array, proof: Hex[]) =>
    new Trie().verifyProof(hexToBytes(root), key, proof.map((n) => hexToBytes(n)));

  it('pins the account proof to the block by stateRoot', () => {
    expect(stateRootOf({ accountProof: S.accountProof } as RpcProof)).toBe(S.stateRoot);
    expect(keccak256(S.rlps[0])).toBe(S.hashes[0]);
  });

  it('proves an existing slot, an absent slot and an absent account', async () => {
    const account = await verify(S.stateRoot, accountKey(S.account), S.accountProof);
    expect(account).not.toBeNull();
    const [, , storageRoot] = RLP.decode(account!) as Uint8Array[];
    expect(bytesToHex(storageRoot)).toBe(S.storageRoot);

    const existing = await verify(S.storageRoot, slotKey(S.existing.slot), S.existing.proof);
    expect(bytesToHex(RLP.decode(existing!) as Uint8Array)).toBe(S.existing.value);

    expect(await verify(S.storageRoot, slotKey(S.absent.slot), S.absent.proof)).toBeNull();
    expect(await verify(S.stateRoot, accountKey(S.absentAccount.account), S.absentAccount.accountProof)).toBeNull();
  });
});
