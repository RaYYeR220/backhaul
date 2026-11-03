import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TypeRegistry } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';
import { describe, expect, it } from 'vitest';
import { getAddress, type Hex } from 'viem';
import {
  codeParam,
  decodeInkStorageAt,
  decodeInkSubmitWindow,
  decodeInkTrustedSet,
  encodeInkConstructor,
  encodeInkStorageAt,
  encodeInkSubmitWindow,
  inkSelector,
} from '../src/ink/parlia.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const H = JSON.parse(readFileSync(join(fixtures, 'bsc-headers.json'), 'utf8'));

describe('ink! parlia_client messages', () => {
  it('uses the ink! 5 selector rule', () => {
    // From the metadata cargo-contract writes (target/ink/parlia_client.json).
    expect(u8aToHex(inkSelector('new'))).toBe('0x9bae9d5e');
    expect(u8aToHex(inkSelector('submit_window'))).toBe('0xc22be324');
    expect(u8aToHex(inkSelector('storage_at'))).toBe('0xb0becf6d');
  });

  it('SCALE-encodes the constructor like ParliaClient.sol takes it', () => {
    const cp = H.checkpoint;
    const data = encodeInkConstructor(97, 1000n, 604800n, {
      epoch: BigInt(cp.epoch),
      timestamp: BigInt(cp.timestamp),
      activeFrom: BigInt(cp.activeFrom),
      turnLength: cp.turnLength,
      validators: cp.validators,
    });
    const le = (n: bigint) => n.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
    expect(data).toBe(
      `0x9bae9d5e${le(97n)}${le(1000n)}${le(604800n)}${le(BigInt(cp.epoch))}${le(BigInt(cp.timestamp))}${le(BigInt(cp.activeFrom))}08` +
        `24${cp.validators.map((v: string) => v.slice(2).toLowerCase()).join('')}`,
    );
  });

  it('encodes a window as Vec<Vec<u8>> with compact lengths', () => {
    expect(encodeInkSubmitWindow(['0x01', '0x0203'])).toBe('0xc22be32408040108' + '0203');
    const rlps: Hex[] = H.rlps.slice(0, 48);
    const data = encodeInkSubmitWindow(rlps);
    const raw = rlps.reduce((n, r) => n + (r.length - 2) / 2, 0);
    // selector + compact(48) + per header compact(len) (2 bytes for 64..16383) + bytes
    expect((data.length - 2) / 2).toBe(4 + 1 + 48 * 2 + raw);
  });

  it('encodes storage_at', () => {
    const data = encodeInkStorageAt(5n, '0x00000000000000000000000000000000000000aa', ['0x11'], `0x${'22'.repeat(32)}`, []);
    expect(data).toBe(`0xb0becf6d0500000000000000${'00'.repeat(19)}aa04` + `0411${'22'.repeat(32)}00`);
  });

  it('decodes results and errors', () => {
    expect(decodeInkSubmitWindow(Uint8Array.from([0, 0, 0xf0, 0x72, 0x5d, 0x08, 0, 0, 0, 0]))).toEqual({ ok: true, value: 140342000n });
    // Err(TooFewSigners(5, 6))
    expect(decodeInkSubmitWindow(Uint8Array.from([0, 1, 4, 5, 0, 0, 0, 6, 0, 0, 0]))).toEqual({ ok: false, error: 'TooFewSigners(5, 6)' });
    expect(decodeInkStorageAt(Uint8Array.from([0, 0, 0]))).toEqual({ ok: true, value: undefined });
    expect(decodeInkStorageAt(Uint8Array.from([0, 1, 8, 1, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ ok: false, error: 'NotFinalized(1)' });
    const set = decodeInkTrustedSet(Uint8Array.from([0, 4, ...new Array(20).fill(0xab), 8, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]));
    expect(set).toEqual({ validators: [getAddress(`0x${'ab'.repeat(20)}`)], turnLength: 8, epoch: 1n, activeFrom: 2n, epochTimestamp: 3n });
    expect(() => decodeInkSubmitWindow(Uint8Array.from([1, 1]))).toThrow(/LangError/);
  });

  it('hands code to polkadot.js as hex, not as a raw Uint8Array', () => {
    const wasm = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const registry = new TypeRegistry();
    // A raw Uint8Array is read as length-prefixed: the leading 0x00 of every wasm makes it empty.
    expect(registry.createType('Bytes', wasm).length).toBe(0);
    expect(registry.createType('Bytes', codeParam(wasm)).length).toBe(wasm.length);
  });
});
