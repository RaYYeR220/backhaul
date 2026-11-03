import { FIXTURE } from "../feed/fixture";
import type { LiveFeed } from "../feed/live";
import { Replay } from "../feed/replay";
import type { BeefyProof, BscHeader, ChainSets, FeedReset, FeedSink, PdtBlock } from "../feed/types";
import { fmt } from "../format";

/** Text with monospaced runs for heights, hashes and addresses. */
export type Rich = ReadonlyArray<string | { mono: string }>;

/** `in`: BNB Chain → Portaldot. `out`: Portaldot → BNB Chain. */
export type Direction = "in" | "out";
export type ChipStop = "origin" | "gate" | "destination";
export type SlotState = "idle" | "active" | "sealed" | "quorum" | "unused" | "forged";

export interface SlotView {
  key: string;
  index: string;
  aside?: string;
  tag: string;
  state: SlotState;
  /** BNB Chain sealers seal 8 headers per turn; this counts the ones over the deposit. */
  meter?: { filled: number; of: number };
  status?: string;
}

export interface RailSnapshot {
  direction: Direction;
  bscHead: number | null;
  pdtHead: number | null;
  ticks: { n: number; mark?: "deposit" | "release" }[];
  beats: { n: number; mark?: "lock" | "release" }[];
  gateOpen: boolean;
  chip: { amount: string; asset: string; note: string; at: ChipStop; released: boolean; stopped: boolean };
  slots: SlotView[];
  sealed: number;
  threshold: number;
  caption: Rich;
  reverted: boolean;
  steps: { label: Rich; done: boolean }[];
  forgeArmed: boolean;
  source: "replay" | "live";
  /** A live feed is ready and takes over when the current transfer finishes. */
  liveQueued: boolean;
  setId: number;
  /** The last forge outcome, for screen readers. */
  announcement: string;
}

type Phase = "arm" | "wait" | "open" | "travel" | "land" | "done";

const LANE_TICKS = 46;
const LANE_BEATS = 7;
const SLICE_MS = 50;
const AMOUNT = "0.25";

const short = (a: string) => a.slice(0, 10);
const tag = (a: string) => a.slice(2, 6).toLowerCase();
const height = (n: number) => ({ mono: "#" + fmt(n) });

/**
 * Drives one transfer at a time across the rail from chain events alone: a deposit waits at the
 * gate until enough distinct BNB Chain sealers have sealed above it (or both BEEFY authorities
 * have signed over the lock), then crosses. Time runs on its own clock so a replayed frame is the
 * same on the server and in the browser.
 */
export class RailMachine implements FeedSink {
  private readonly replay = new Replay(FIXTURE);
  private chain: ChainSets = this.replay.sets;
  private source: "replay" | "live" = "replay";
  private live: LiveFeed | null = null;
  private offered: LiveFeed | null = null;
  private cycle = 0;

  private dir: Direction = "in";
  private phase: Phase = "arm";
  private depositN: number | null = null;
  private lockN: number | null = null;
  private counted = new Map<number, number>();
  private active: number | null = null;
  private forged: number | null = null;
  private signed = new Set<number>();
  private gate = false;
  private chip: RailSnapshot["chip"] = { amount: AMOUNT, asset: "tBNB", note: "", at: "origin", released: false, stopped: false };
  private caption: Rich = [];
  private reverted = false;
  private steps: RailSnapshot["steps"] = [];
  private queued = false;
  private forging = false;
  private pending: (() => void) | null = null;
  private announcement = "";

  private head: BscHeader | null = null;
  private pdtHead: number | null = null;
  private beefyBlock = 0;
  private lastProof: BeefyProof | null = null;
  private ticks: RailSnapshot["ticks"] = [];
  private beats: RailSnapshot["beats"] = [];

  private now = 0;
  private timers: { at: number; run: () => void }[] = [];
  private listeners = new Set<() => void>();
  private snapshot: RailSnapshot | null = null;
  private dirty = true;

  /** A machine already a few seconds into the first recorded transfer, so the rail opens mid-proof. */
  static boot(): RailMachine {
    const m = new RailMachine();
    const first = m.replay.cycles[0];
    m.replay.seek(first.start, m);
    m.startIn();
    m.run(first.deposit.t + 13 * FIXTURE.bsc.dt - first.start);
    return m;
  }

  get replaySpan() {
    return this.replay.span;
  }

  /* ---------- outside world ---------- */

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RailSnapshot => {
    if (this.dirty || !this.snapshot) {
      this.snapshot = this.build();
      this.dirty = false;
    }
    return this.snapshot;
  };

  /** Advances the clock by one animation frame. */
  step(ms: number) {
    this.run(Math.min(ms, 250));
    if (this.dirty) this.listeners.forEach((l) => l());
  }

  setDirection = (d: Direction) => {
    if (d === this.dir && this.phase !== "done") return;
    this.dirty = true;
    if (this.offered) this.switchToLive();
    if (this.source === "replay") {
      const c = this.replay.cycles[this.cycle];
      this.replay.seek(d === "in" ? c.start : c.backStart, this);
    }
    if (d === "in") this.startIn();
    else this.startOut();
  };

  /** Use this feed from the next transfer on. */
  offerLive(feed: LiveFeed) {
    if (this.live === feed) return;
    this.offered = feed;
    this.dirty = true;
  }

  /** Back to the recording, from its first transfer. */
  dropLive() {
    this.offered = null;
    this.dirty = true;
    if (this.source !== "live") return;
    this.live?.detach();
    this.live = null;
    this.source = "replay";
    this.cycle = 0;
    this.replay.seek(this.replay.cycles[0].start, this);
    this.startIn();
  }

  /**
   * The forged-seal interaction. A seal from a key that did not seal the header (or a BEEFY
   * signature that recovers to no authority) is refused and the gate stays shut.
   */
  forge = () => {
    this.dirty = true;
    this.queued = false;
    if (this.phase !== "wait") {
      this.queued = true;
      return;
    }
    if (this.forging) return;
    let undo: () => void;
    if (this.dir === "in") {
      const n = this.chain.validators.length;
      const head = this.head;
      if (!head) return;
      const hm = head.sealer >= 0 ? head.sealer : 0;
      const ahead = (i: number) => (i - hm + n) % n;
      const free = [...Array(n).keys()].filter((i) => !this.counted.has(i) && i !== head.sealer);
      free.sort((a, b) => ahead(b) - ahead(a));
      const pick = free.includes(0) && ahead(0) > 2 ? 0 : free[0];
      if (pick === undefined) return;
      const who = short(this.chain.validators[pick]);
      this.forged = pick;
      this.caption = ["Reverted · ", { mono: who }, " did not seal ", height(head.n), " · gate stays shut"];
      this.announcement = `Reverted. ${who} did not seal header ${fmt(head.n)}. The gate stays shut.`;
      undo = () => {
        this.caption = this.depositCaption();
      };
    } else {
      this.forged = 0;
      this.caption = ["Reverted · signature does not recover to an authority of set ", { mono: String(this.chain.setId) }, " · gate stays shut"];
      this.announcement = `Reverted. The signature does not recover to an authority of set ${this.chain.setId}. The gate stays shut.`;
      undo = () => {
        this.caption = this.lockCaption();
      };
    }
    this.forging = true;
    this.reverted = true;
    this.chip = { ...this.chip, stopped: true };
    this.after(2900, () => {
      this.forging = false;
      this.forged = null;
      this.reverted = false;
      this.chip = { ...this.chip, stopped: false };
      undo();
      const p = this.pending;
      this.pending = null;
      p?.();
    });
  };

  /* ---------- FeedSink ---------- */

  reset(s: FeedReset) {
    this.dirty = true;
    this.chain = s.sets;
    this.head = s.headers[s.headers.length - 1] ?? null;
    this.beefyBlock = s.beefyBlock;
    this.ticks = s.headers.slice(-LANE_TICKS).map((h) => ({ n: h.n }));
    this.beats = s.blocks.slice(-LANE_BEATS).map((b) => ({ n: b.n }));
    this.pdtHead = s.blocks.length ? s.blocks[s.blocks.length - 1].n : null;
  }

  sets(s: ChainSets) {
    this.dirty = true;
    this.chain = s;
  }

  header(h: BscHeader) {
    this.dirty = true;
    this.head = h;
    this.ticks = [...this.ticks, { n: h.n }].slice(-LANE_TICKS);
    if (this.dir === "in") {
      const c = this.plan();
      if (this.phase === "arm" && (!c || h.n >= c.deposit.n)) this.deposit(h);
      else if (this.phase === "wait") this.seal(h);
    } else if (this.phase === "land") {
      this.releaseOnBsc(h);
    }
  }

  block(b: PdtBlock) {
    this.dirty = true;
    this.pdtHead = b.n;
    this.beats = [...this.beats, { n: b.n }].slice(-LANE_BEATS);
    if (this.dir === "in" && this.phase === "land") this.releaseOnPortaldot(b);
    else if (this.dir === "out" && this.phase === "arm") {
      const c = this.plan();
      if (!c || b.n >= c.lockBlock.n) this.lock(b);
    } else if (this.dir === "out" && this.phase === "wait" && !this.forging) {
      this.caption = this.lockCaption();
    }
  }

  beefy(e: BeefyProof) {
    this.dirty = true;
    this.beefyBlock = e.block;
    this.lastProof = e;
    if (this.dir === "out" && this.phase === "wait" && this.lockN !== null && e.block >= this.lockN) this.sign(e);
  }

  /* ---------- the transfer ---------- */

  private get threshold() {
    const n = this.dir === "in" ? this.chain.validators.length : this.chain.authorities.length;
    // Parlia finality here: ⌈2N/3⌉ distinct sealers. BEEFY: more than 2/3 of the authorities.
    return this.dir === "in" ? Math.ceil((2 * n) / 3) : Math.floor((2 * n) / 3) + 1;
  }

  private plan() {
    return this.source === "replay" ? this.replay.cycles[this.cycle] : null;
  }

  private clear() {
    this.timers = [];
    this.phase = "arm";
    this.depositN = null;
    this.lockN = null;
    this.counted = new Map();
    this.active = null;
    this.forged = null;
    this.signed = new Set();
    this.gate = false;
    this.forging = false;
    this.pending = null;
    this.reverted = false;
  }

  private startIn() {
    this.clear();
    this.dir = "in";
    const n = this.chain.validators.length;
    this.chip = { amount: AMOUNT, asset: "tBNB", note: "depositing on BNB Chain", at: "origin", released: false, stopped: false };
    this.caption = [`${this.threshold} of ${n} BNB Chain sealers must seal the deposit header`];
    this.steps = [
      { label: [`Sealed by ${this.threshold} of ${n}`], done: false },
      { label: ["Receipt proof verified"], done: false },
      { label: ["Released on Portaldot"], done: false },
    ];
  }

  private startOut() {
    this.clear();
    this.dir = "out";
    const n = this.chain.authorities.length;
    const who = this.threshold === n ? (n === 2 ? "both" : `all ${n}`) : `${this.threshold} of ${n}`;
    this.chip = { amount: AMOUNT, asset: "BNB.b", note: "locking on Portaldot", at: "origin", released: false, stopped: false };
    this.caption = [`${who} Portaldot BEEFY authorities of set `, { mono: String(this.chain.setId) }, " must sign"];
    this.steps = [
      { label: [`Signed ${this.threshold} of ${n}`], done: false },
      { label: ["MMR + storage proof verified"], done: false },
      { label: ["Released on BNB Chain"], done: false },
    ];
  }

  private depositCaption(): Rich {
    return ["distinct sealers on deposit header ", height(this.depositN ?? 0)];
  }

  private lockCaption(): Rich {
    return ["locked in Portaldot ", height(this.lockN ?? 0), " · BEEFY has signed through ", height(this.beefyBlock)];
  }

  private deposit(h: BscHeader) {
    this.depositN = h.n;
    this.phase = "wait";
    this.mark("ticks", h.n, "deposit");
    this.chip = { ...this.chip, note: "", at: "gate" };
    this.caption = this.depositCaption();
    this.seal(h);
    if (this.queued) this.after(900, this.forge);
  }

  private seal(h: BscHeader) {
    if (h.sealer < 0) return;
    this.counted.set(h.sealer, (this.counted.get(h.sealer) ?? 0) + 1);
    this.active = h.sealer;
    if (this.counted.size >= this.threshold) {
      if (this.forging) this.pending = () => this.openIn(h);
      else this.openIn(h);
    }
  }

  private openIn(h: BscHeader) {
    const n = this.chain.validators.length;
    this.phase = "open";
    this.active = null;
    this.gate = true;
    this.caption = ["header ", height(this.depositN!), " is final · sealed through ", height(h.n)];
    this.steps[0] = { label: [`Sealed by ${this.threshold} of ${n} · `, height(this.depositN!)], done: true };
    this.after(520, () => (this.steps[1] = { label: ["Receipt proof verified · ", { mono: "Locked" }, " log"], done: true }));
    this.after(640, () => {
      this.phase = "travel";
      this.chip = { ...this.chip, note: "next Portaldot block", at: "destination" };
    });
    this.after(640 + 980, () => (this.phase = "land"));
  }

  private releaseOnPortaldot(b: PdtBlock) {
    this.phase = "done";
    this.mark("beats", b.n, "release");
    this.chip = { amount: AMOUNT, asset: "BNB.b", note: "released · 0 trusted parties", at: "destination", released: true, stopped: false };
    this.steps[2] = { label: ["Released on Portaldot ", height(b.n)], done: true };
    this.after(3400, () => this.next());
  }

  private lock(b: PdtBlock) {
    this.lockN = b.n;
    this.phase = "wait";
    this.mark("beats", b.n, "lock");
    this.chip = { ...this.chip, note: "", at: "gate" };
    this.caption = this.lockCaption();
    if (this.queued) this.after(900, this.forge);
    if (this.beefyBlock >= b.n) {
      const proof = this.lastProof;
      this.after(400, () => this.sign({ block: this.beefyBlock, setId: this.chain.setId, signed: proof?.signed ?? [], t: 0 }));
    }
  }

  private sign(e: BeefyProof) {
    if (this.forging) {
      this.pending = () => this.sign(e);
      return;
    }
    const n = this.chain.authorities.length;
    const who = e.signed.length ? e.signed : [...Array(n).keys()];
    this.phase = "open";
    this.signed = new Set(who.slice(0, 1));
    this.after(300, () => {
      this.signed = new Set(who);
      this.gate = true;
      this.caption = ["BEEFY commitment ", height(e.block), " covers ", height(this.lockN!)];
      this.steps[0] = {
        label: [`Signed ${who.length} of ${n} · BEEFY `, height(e.block), " · set ", { mono: String(e.setId || this.chain.setId) }],
        done: true,
      };
    });
    this.after(820, () => (this.steps[1] = { label: ["MMR + storage proof verified"], done: true }));
    this.after(940, () => {
      this.phase = "travel";
      this.chip = { ...this.chip, note: "next BNB Chain header", at: "destination" };
    });
    this.after(940 + 980, () => (this.phase = "land"));
  }

  private releaseOnBsc(h: BscHeader) {
    this.phase = "done";
    this.mark("ticks", h.n, "release");
    this.chip = { amount: AMOUNT, asset: "tBNB", note: "released · 0 trusted parties", at: "destination", released: true, stopped: false };
    this.steps[2] = { label: ["Released on BNB Chain ", height(h.n)], done: true };
    this.after(3400, () => this.next());
  }

  private next() {
    if (this.offered) {
      this.switchToLive();
      if (this.dir === "in") this.startOut();
      else this.startIn();
      return;
    }
    if (this.dir === "in") return this.startOut();
    if (this.source === "replay") {
      this.cycle = (this.cycle + 1) % this.replay.cycles.length;
      this.replay.seek(this.replay.cycles[this.cycle].start, this);
    }
    this.startIn();
  }

  private switchToLive() {
    const feed = this.offered;
    if (!feed) return;
    this.offered = null;
    this.source = "live";
    this.live = feed;
    feed.attach(this);
  }

  /* ---------- clock ---------- */

  private after(ms: number, run: () => void) {
    this.timers.push({ at: this.now + ms, run });
  }

  private run(ms: number) {
    let left = ms;
    while (left > 0) {
      const slice = Math.min(SLICE_MS, left);
      left -= slice;
      this.now += slice;
      for (;;) {
        const due = this.timers.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        this.timers = this.timers.filter((t) => t !== due);
        due.run();
        this.dirty = true;
      }
      if (this.source === "replay") this.replay.advance(slice, this);
    }
  }

  private mark<K extends "ticks" | "beats">(lane: K, n: number, mark: string) {
    this.dirty = true;
    if (lane === "ticks") this.ticks = this.ticks.map((t) => (t.n === n ? { ...t, mark: mark as "deposit" | "release" } : t));
    else this.beats = this.beats.map((b) => (b.n === n ? { ...b, mark: mark as "lock" | "release" } : b));
  }

  /* ---------- snapshot ---------- */

  private build(): RailSnapshot {
    const quorum = this.gate;
    const slots: SlotView[] =
      this.dir === "in"
        ? this.chain.validators.map((v, i) => {
            const seals = this.counted.get(i) ?? 0;
            let state: SlotState = seals ? (this.active === i ? "active" : "sealed") : "idle";
            if (quorum) state = seals ? "quorum" : "unused";
            if (this.forged === i) state = "forged";
            return { key: v, index: String(i), tag: tag(v), state, meter: { filled: Math.min(seals, FIXTURE.bsc.turn), of: FIXTURE.bsc.turn } };
          })
        : this.chain.authorities.map((a, i) => {
            const forged = this.forged === i;
            const signed = this.signed.has(i);
            return {
              key: a,
              index: `authority ${i}`,
              aside: `set ${this.chain.setId}`,
              tag: `${a.slice(0, 10)}…${a.slice(-6)}`,
              state: forged ? "forged" : signed ? (quorum ? "quorum" : "sealed") : "idle",
              status: forged ? "forged" : signed ? "signed" : "waiting",
            };
          });
    const sealed = this.dir === "in" ? Math.min(this.counted.size, this.threshold) : this.signed.size;
    return {
      direction: this.dir,
      bscHead: this.head?.n ?? null,
      pdtHead: this.pdtHead,
      ticks: this.ticks,
      beats: this.beats,
      gateOpen: this.gate,
      chip: this.chip,
      slots,
      sealed,
      threshold: this.threshold,
      caption: this.caption,
      reverted: this.reverted,
      steps: this.steps.map((s) => ({ ...s })),
      forgeArmed: this.queued,
      source: this.source,
      liveQueued: this.offered !== null,
      setId: this.chain.setId,
      announcement: this.announcement,
    };
  }
}
