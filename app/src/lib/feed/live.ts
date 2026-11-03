import type { BscHeader, ChainSets, FeedSink, PdtBlock } from "./types";

export const BSC_WSS = "wss://bsc-testnet-rpc.publicnode.com";
export const PORTALDOT_WSS = "wss://test-node-v3.portaldot.dev";

/** twox128("Beefy") ‖ twox128("Authorities") */
const BEEFY_AUTHORITIES_KEY = "0x08c41974a97dbf15cfbec28365bea2da5e0621c4869aa60c02be9adcc98a0d1d";
/** twox128("Beefy") ‖ twox128("ValidatorSetId") */
const BEEFY_SET_ID_KEY = "0x08c41974a97dbf15cfbec28365bea2da8f05bccc2f70ec66a32999c5761156be";

const KEEP_HEADERS = 48;
const KEEP_BLOCKS = 7;
const BSC_EPOCH = 1000;
const BSC_TURN = 8;
const STALE_BSC_MS = 15_000;
const STALE_PDT_MS = 45_000;

/**
 * Live chain events over plain WebSocket JSON-RPC: BNB Chain testnet `newHeads`, Portaldot V3
 * finalized heads and BEEFY justifications. Any socket error, close or stall drops the feed.
 */
export class LiveFeed {
  sets: ChainSets = { validators: [], authorities: [], setId: 0 };
  /** Called once if the feed fails after it was ready. */
  onDrop: () => void = () => {};

  private bsc: RpcSocket | null = null;
  private pdt: RpcSocket | null = null;
  private headers: BscHeader[] = [];
  private blocks: PdtBlock[] = [];
  private beefyBlock = 0;
  private sink: FeedSink | null = null;
  private ready = false;
  private closed = false;
  private loadingSet = false;
  private lastBsc = 0;
  private lastPdt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private firstEvents: () => void = () => {};
  private failConnect: (e: Error) => void = () => {};

  async connect(timeoutMs = 12_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failed = new Promise<never>((_, reject) => {
      this.failConnect = reject;
      timer = setTimeout(() => reject(new Error("live nodes did not answer in time")), timeoutMs);
    });
    const firstEvents = new Promise<void>((resolve) => (this.firstEvents = resolve));
    const work = (async () => {
      this.bsc = new RpcSocket(BSC_WSS, (m, r) => this.onBsc(m, r), () => this.drop());
      this.pdt = new RpcSocket(PORTALDOT_WSS, (m, r) => this.onPdt(m, r), () => this.drop());
      await Promise.all([this.bsc.opened, this.pdt.opened]);
      await Promise.all([this.initBsc(this.bsc), this.initPdt(this.pdt)]);
      await firstEvents;
    })();
    try {
      await Promise.race([work, failed]);
    } catch (e) {
      this.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    this.ready = true;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      if (now - this.lastBsc > STALE_BSC_MS || now - this.lastPdt > STALE_PDT_MS) this.drop();
    }, 5000);
  }

  /** Starts feeding `sink`, beginning with everything seen so far. */
  attach(sink: FeedSink) {
    this.sink = sink;
    sink.reset({
      sets: { ...this.sets },
      headers: [...this.headers],
      blocks: [...this.blocks],
      beefyBlock: this.beefyBlock,
    });
  }

  detach() {
    this.sink = null;
  }

  close() {
    this.closed = true;
    this.sink = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.bsc?.close();
    this.pdt?.close();
  }

  private drop() {
    if (this.closed) return;
    const wasReady = this.ready;
    this.close();
    if (wasReady) this.onDrop();
    else this.failConnect(new Error("live node connection failed"));
  }

  /* ---------- BNB Chain ---------- */

  private async initBsc(rpc: RpcSocket) {
    const n = parseInt(await rpc.call<string>("eth_blockNumber"), 16);
    await this.loadValidators(rpc, n);
    await rpc.call("eth_subscribe", ["newHeads"]);
  }

  /**
   * Reads the validator set from the epoch header in force at `n`. A set announced at epoch E takes
   * over at E + (⌊N/2⌋ + 1) · turnLength − 1, as BNB Chain's own snapshot logic applies it.
   */
  private async loadValidators(rpc: RpcSocket, n: number) {
    const size = this.sets.validators.length || 9;
    const delay = (Math.floor(size / 2) + 1) * BSC_TURN - 1;
    let epoch = Math.floor(n / BSC_EPOCH) * BSC_EPOCH;
    if (n < epoch + delay) epoch -= BSC_EPOCH;
    const block = await rpc.call<{ extraData: string }>("eth_getBlockByNumber", ["0x" + epoch.toString(16), false]);
    const extra = block.extraData.slice(2);
    const count = parseInt(extra.slice(64, 66), 16);
    const validators: string[] = [];
    for (let i = 0; i < count; i++) validators.push("0x" + extra.slice(66 + i * 136, 106 + i * 136));
    if (!validators.length) throw new Error(`epoch header ${epoch} carries no validator set`);
    this.sets = { ...this.sets, validators };
    this.sink?.sets({ ...this.sets });
  }

  private onBsc(method: string, result: unknown) {
    if (method !== "eth_subscription") return;
    const r = result as { number: string; miner: string };
    const n = parseInt(r.number, 16);
    const last = this.headers[this.headers.length - 1];
    if (last && n <= last.n) return;
    const miner = r.miner.toLowerCase();
    const sealer = this.sets.validators.findIndex((v) => v.toLowerCase() === miner);
    if (sealer < 0 && !this.loadingSet && this.bsc) {
      this.loadingSet = true;
      this.loadValidators(this.bsc, n)
        .catch(() => {})
        .finally(() => (this.loadingSet = false));
    }
    const h: BscHeader = { n, sealer, t: Date.now() };
    this.headers.push(h);
    if (this.headers.length > KEEP_HEADERS) this.headers.shift();
    this.lastBsc = h.t;
    this.sink?.header(h);
    this.checkFirst();
  }

  /* ---------- Portaldot ---------- */

  private async initPdt(rpc: RpcSocket) {
    const [authorities, setId, finalized] = await Promise.all([
      rpc.call<string>("state_getStorage", [BEEFY_AUTHORITIES_KEY]),
      rpc.call<string>("state_getStorage", [BEEFY_SET_ID_KEY]),
      rpc.call<string>("beefy_getFinalizedHead"),
    ]);
    const header = await rpc.call<{ number: string }>("chain_getHeader", [finalized]);
    this.beefyBlock = parseInt(header.number, 16);
    this.sets = { ...this.sets, authorities: decodeAuthorities(authorities), setId: decodeU64(setId) };
    await rpc.call("chain_subscribeFinalizedHeads");
    await rpc.call("beefy_subscribeJustifications");
  }

  private onPdt(method: string, result: unknown) {
    if (method === "chain_finalizedHead") {
      const n = parseInt((result as { number: string }).number, 16);
      const last = this.blocks[this.blocks.length - 1];
      if (last && n <= last.n) return;
      // GRANDPA can finalize several blocks at once; each of them is final, so each gets its beat.
      const from = last ? Math.max(last.n + 1, n - KEEP_BLOCKS + 1) : n;
      const t = Date.now();
      for (let k = from; k <= n; k++) {
        const b: PdtBlock = { n: k, t };
        this.blocks.push(b);
        if (this.blocks.length > KEEP_BLOCKS) this.blocks.shift();
        this.sink?.block(b);
      }
      this.lastPdt = t;
      this.checkFirst();
    } else if (method === "beefy_justifications") {
      let proof;
      try {
        proof = decodeJustification(result as string);
      } catch {
        return;
      }
      if (proof.block <= this.beefyBlock) return;
      this.beefyBlock = proof.block;
      if (proof.setId !== this.sets.setId) {
        this.sets = { ...this.sets, setId: proof.setId };
        this.pdt
          ?.call<string>("state_getStorage", [BEEFY_AUTHORITIES_KEY])
          .then((raw) => {
            this.sets = { ...this.sets, authorities: decodeAuthorities(raw) };
            this.sink?.sets({ ...this.sets });
          })
          .catch(() => {});
        this.sink?.sets({ ...this.sets });
      }
      this.sink?.beefy({ ...proof, t: Date.now() });
    }
  }

  private checkFirst() {
    if (this.headers.length && this.blocks.length) this.firstEvents();
  }
}

/* ---------- JSON-RPC over one WebSocket ---------- */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

class RpcSocket {
  readonly opened: Promise<void>;
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private id = 0;
  private down = false;
  private rejectOpen: (e: Error) => void = () => {};

  constructor(
    url: string,
    private readonly onNotify: (method: string, result: unknown) => void,
    private readonly onDown: () => void,
  ) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.rejectOpen = reject;
      this.ws.onopen = () => resolve();
    });
    this.opened.catch(() => {});
    this.ws.onerror = () => this.fail();
    this.ws.onclose = () => this.fail();
    this.ws.onmessage = (ev) => {
      let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { result: unknown } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method && msg.params) {
        this.onNotify(msg.method, msg.params.result);
      }
    };
  }

  call<T = unknown>(method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
    if (this.down) return Promise.reject(new Error("socket closed"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    if (this.down) return;
    this.down = true;
    this.settle();
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }

  private fail() {
    if (this.down) return;
    this.down = true;
    this.settle();
    this.onDown();
  }

  private settle() {
    const err = new Error("socket closed");
    this.rejectOpen(err);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/* ---------- the SCALE bits the rail reads ---------- */

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  u8() {
    if (this.o >= this.b.length) throw new Error("read past end");
    return this.b[this.o++];
  }
  u32() {
    const v = this.b[this.o] | (this.b[this.o + 1] << 8) | (this.b[this.o + 2] << 16) | (this.b[this.o + 3] << 24);
    this.o += 4;
    if (this.o > this.b.length) throw new Error("read past end");
    return v >>> 0;
  }
  u64() {
    const lo = this.u32();
    return lo + this.u32() * 2 ** 32;
  }
  compact() {
    const first = this.b[this.o];
    switch (first & 3) {
      case 0:
        return this.u8() >> 2;
      case 1: {
        const v = this.b[this.o] | (this.b[this.o + 1] << 8);
        this.o += 2;
        return v >> 2;
      }
      case 2:
        return this.u32() >>> 2;
      default:
        throw new Error("compact integer too large");
    }
  }
  take(n: number) {
    if (this.o + n > this.b.length) throw new Error("read past end");
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
}

function hexBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesHex(b: Uint8Array) {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** SCALE `Vec<ecdsa::Public>`, the value of `Beefy::Authorities`. */
export function decodeAuthorities(hex: string): string[] {
  const r = new Reader(hexBytes(hex));
  const n = r.compact();
  return Array.from({ length: n }, () => bytesHex(r.take(33)));
}

function decodeU64(hex: string) {
  return new Reader(hexBytes(hex)).u64();
}

/**
 * A justification from `beefy_subscribeJustifications`: `0x01 ‖ CompactSignedCommitment`, where
 * the commitment is `{ payload, blockNumber: u32, validatorSetId: u64 }` and the signer bitfield
 * is MSB-first.
 */
export function decodeJustification(hex: string): { block: number; setId: number; signed: number[] } {
  const r = new Reader(hexBytes(hex));
  if (r.u8() !== 1) throw new Error("unknown BEEFY finality proof version");
  const items = r.compact();
  for (let i = 0; i < items; i++) {
    r.take(2);
    r.take(r.compact());
  }
  const block = r.u32();
  const setId = r.u64();
  const bitfield = r.take(r.compact());
  const setLen = r.u32();
  const signed: number[] = [];
  for (let i = 0; i < setLen; i++) if ((bitfield[i >> 3] >> (7 - (i & 7))) & 1) signed.push(i);
  return { block, setId, signed };
}
