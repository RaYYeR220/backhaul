"use client";

import { useEffect, useState } from "react";
import { LiveFeed } from "./feed/live";
import type { BeefyProof, BscHeader, ChainSets, FeedReset, FeedSink, PdtBlock } from "./feed/types";

export interface Lanes {
  live: boolean;
  failed: boolean;
  bscHead: number | null;
  pdtHead: number | null;
  ticks: number[];
  beats: number[];
}

const TICKS = 46;
const BEATS = 7;

/** The rail's two tempo lanes, fed by live BNB Chain headers and finalized Portaldot blocks. */
export function useLanes(): Lanes {
  const [lanes, setLanes] = useState<Lanes>({ live: false, failed: false, bscHead: null, pdtHead: null, ticks: [], beats: [] });

  useEffect(() => {
    if (typeof WebSocket === "undefined") {
      setLanes((l) => ({ ...l, failed: true }));
      return;
    }
    let alive = true;
    let ticks: number[] = [];
    let beats: number[] = [];
    const push = () =>
      alive && setLanes({ live: true, failed: false, bscHead: ticks.at(-1) ?? null, pdtHead: beats.at(-1) ?? null, ticks: [...ticks], beats: [...beats] });
    const sink: FeedSink = {
      reset(r: FeedReset) {
        ticks = r.headers.map((h) => h.n).slice(-TICKS);
        beats = r.blocks.map((b) => b.n).slice(-BEATS);
        push();
      },
      header(h: BscHeader) {
        ticks = [...ticks, h.n].slice(-TICKS);
        push();
      },
      block(b: PdtBlock) {
        beats = [...beats, b.n].slice(-BEATS);
        push();
      },
      beefy(_: BeefyProof) {},
      sets(_: ChainSets) {},
    };
    const feed = new LiveFeed();
    feed.onDrop = () => alive && setLanes((l) => ({ ...l, live: false, failed: true }));
    feed.connect().then(
      () => alive && feed.attach(sink),
      () => alive && setLanes((l) => ({ ...l, failed: true })),
    );
    return () => {
      alive = false;
      feed.close();
    };
  }, []);

  return lanes;
}
