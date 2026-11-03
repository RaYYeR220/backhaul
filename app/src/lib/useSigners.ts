"use client";

import { useEffect, useRef, useState } from "react";
import { beefyFinalized, beefyValidatorSet, bscHead, bscMiners, bscValidatorsAt, parliaQuorum } from "./chain";

/** Distinct BNB Chain sealers from the deposit block upward, in the order they first sealed. */
export interface ParliaSigners {
  kind: "parlia";
  from: number;
  epoch: number;
  validators: string[];
  quorum: number;
  /** Validator indices, in the order each first sealed a header at or above `from`. */
  order: number[];
  /** Headers each validator sealed in the window so far. */
  counts: number[];
  /** Headers in the window sealed by an address outside the set. */
  untrusted: number;
  /** Highest header read so far. */
  scannedTo: number;
}

/** Portaldot's BEEFY authorities and whether BEEFY has signed past the deposit block. */
export interface BeefySigners {
  kind: "beefy";
  from: number;
  setId: number;
  authorities: string[];
  beefyHead: number;
  signedPast: boolean;
}

export type Signers = ParliaSigners | BeefySigners;

/** Long enough for 6 of 9 distinct sealers at turn length 8, with room to spare. */
const WINDOW = 64;

/**
 * Follows the signers over a deposit at `from` on `chain`, straight from the chains. Stops once a
 * quorum is in, or when `done` says the light client has already accepted the proof.
 */
export function useSigners(chain: "bsc" | "portaldot" | null, from: number | null, done: boolean) {
  const [signers, setSigners] = useState<Signers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    if (!chain || from == null || !Number.isFinite(from)) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    setSigners(null);
    setError(null);

    if (chain === "bsc") {
      let state: ParliaSigners | null = null;
      const step = async () => {
        try {
          if (!state) {
            const set = await bscValidatorsAt(from, ctl.signal);
            state = {
              kind: "parlia",
              from,
              epoch: set.epoch,
              validators: set.validators,
              quorum: parliaQuorum(set.validators.length),
              order: [],
              counts: set.validators.map(() => 0),
              untrusted: 0,
              scannedTo: from - 1,
            };
          }
          const head = await bscHead(ctl.signal);
          const to = Math.min(head, from + WINDOW - 1, state.scannedTo + 32);
          if (to > state.scannedTo) {
            const miners = await bscMiners(state.scannedTo + 1, to, ctl.signal);
            const next = { ...state, order: [...state.order], counts: [...state.counts] };
            for (const b of miners) {
              if (next.order.length >= next.quorum) break;
              const i = next.validators.findIndex((v) => v.toLowerCase() === b.miner);
              if (i < 0) next.untrusted += 1;
              else {
                next.counts[i] += 1;
                if (!next.order.includes(i)) next.order.push(i);
              }
              next.scannedTo = b.n;
            }
            state = next;
            if (alive) setSigners(next);
          } else if (alive) setSigners(state);
          const complete = state.order.length >= state.quorum || state.scannedTo >= from + WINDOW - 1;
          if (!complete && alive) timer = setTimeout(step, 1500);
        } catch (e) {
          if (!alive || ctl.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          timer = setTimeout(step, 6000);
        }
      };
      step();
    } else {
      let set: { setId: number; authorities: string[] } | null = null;
      const step = async () => {
        try {
          set ??= await beefyValidatorSet(ctl.signal);
          const head = await beefyFinalized(ctl.signal);
          const s: BeefySigners = {
            kind: "beefy",
            from,
            setId: set.setId,
            authorities: set.authorities,
            beefyHead: head,
            signedPast: head >= from,
          };
          if (alive) {
            setSigners(s);
            setError(null);
          }
          if (!s.signedPast && !doneRef.current && alive) timer = setTimeout(step, 6000);
        } catch (e) {
          if (!alive || ctl.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          timer = setTimeout(step, 8000);
        }
      };
      step();
    }
    return () => {
      alive = false;
      ctl.abort();
      clearTimeout(timer);
    };
  }, [chain, from]);

  return { signers, error };
}
