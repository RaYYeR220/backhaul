import { hexToU8a, u8aConcat, u8aToHex } from "@polkadot/util";

export type Hex = `0x${string}`;

export const toU8a = (v: Hex | Uint8Array): Uint8Array => (typeof v === "string" ? hexToU8a(v) : v);
export const toHex = (v: Uint8Array): Hex => u8aToHex(v) as Hex;

/** Little-endian u32. */
export function le32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`not a u32: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** Little-endian u64. */
export function le64(n: bigint | number): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 64n) throw new RangeError(`not a u64: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** SCALE compact encoding of an unsigned integer. */
export function encodeCompact(n: bigint | number): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new RangeError("negative compact");
  if (v < 1n << 6n) return new Uint8Array([Number(v) << 2]);
  if (v < 1n << 14n) {
    const x = (Number(v) << 2) | 0b01;
    return new Uint8Array([x & 0xff, x >> 8]);
  }
  if (v < 1n << 30n) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, (Number(v) << 2) | 0b10, true);
    return out;
  }
  const bytes: number[] = [];
  let rest = v;
  while (rest > 0n) {
    bytes.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  if (bytes.length > 67) throw new RangeError("compact too large");
  return new Uint8Array([((bytes.length - 4) << 2) | 0b11, ...bytes]);
}

/** Cursor over a SCALE byte string. Every read is bounds-checked. */
export class ScaleReader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  take(len: number): Uint8Array {
    if (len < 0 || this.offset + len > this.bytes.length) throw new RangeError("SCALE input too short");
    const out = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  u64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }

  compact(): bigint {
    const b0 = this.u8();
    switch (b0 & 0b11) {
      case 0b00:
        return BigInt(b0 >> 2);
      case 0b01:
        return BigInt((b0 | (this.u8() << 8)) >> 2);
      case 0b10: {
        const rest = this.take(3);
        return BigInt(((b0 | (rest[0] << 8) | (rest[1] << 16)) >>> 2) + rest[2] * (1 << 22));
      }
      default: {
        const len = (b0 >> 2) + 4;
        const bytes = this.take(len);
        let v = 0n;
        for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
        return v;
      }
    }
  }

  compactNumber(): number {
    const v = this.compact();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("compact exceeds safe integer");
    return Number(v);
  }

  /** `Vec<u8>`: compact length followed by the bytes. */
  bytesVec(): Uint8Array {
    return this.take(this.compactNumber());
  }

  end(): void {
    if (this.remaining !== 0) throw new RangeError(`trailing ${this.remaining} bytes in SCALE input`);
  }
}

export const concat = (...parts: Uint8Array[]): Uint8Array => u8aConcat(...parts);
