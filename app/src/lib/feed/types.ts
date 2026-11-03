/** A BNB Chain header as the rail needs it. */
export interface BscHeader {
  n: number;
  /** Index of the sealer in the validator set in force at this height, or -1 if unknown. */
  sealer: number;
  /** Time the header was produced (replay) or received (live), in ms. */
  t: number;
}

/** A finalized Portaldot block. */
export interface PdtBlock {
  n: number;
  t: number;
}

/** A BEEFY justification: the authorities of `setId` signed a commitment to `block`. */
export interface BeefyProof {
  block: number;
  setId: number;
  /** Indices of the authorities whose signatures are in the justification. */
  signed: number[];
  t: number;
}

/** Who signs on each side, as of the latest data. */
export interface ChainSets {
  /** BNB Chain validator addresses, in set order. */
  validators: string[];
  /** Portaldot BEEFY authority keys (33-byte compressed), in set order. */
  authorities: string[];
  setId: number;
}

export interface FeedReset {
  sets: ChainSets;
  /** Recent BNB Chain headers, oldest first; the last one is the head. */
  headers: BscHeader[];
  /** Recent finalized Portaldot blocks, oldest first. */
  blocks: PdtBlock[];
  /** Latest Portaldot block covered by a BEEFY justification. */
  beefyBlock: number;
}

/** Anything that consumes chain events: the replay and the live feed both write into one. */
export interface FeedSink {
  reset(s: FeedReset): void;
  header(h: BscHeader): void;
  block(b: PdtBlock): void;
  beefy(e: BeefyProof): void;
  sets(s: ChainSets): void;
}

/** Shape of the recorded replay fixture. */
export interface Fixture {
  recorded: string;
  bsc: {
    rpc: string;
    /** Number of the first recorded header. */
    n0: number;
    /** Timestamp of the first recorded header, ms. */
    t0: number;
    /** Block time, ms. */
    dt: number;
    epoch: number;
    turn: number;
    validators: string[];
    /** One digit per header: the index of its sealer. */
    miners: string;
    /** Eight hex characters of each header hash, concatenated. */
    hash: string;
  };
  pdt: {
    rpc: string;
    setId: number;
    authorities: string[];
    /** [number, timestamp ms, hash prefix] */
    blocks: [number, number, string][];
    /** [received at ms, block number covered, hash prefix] */
    beefy: [number, number, string][];
  };
}
