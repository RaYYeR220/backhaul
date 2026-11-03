"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { FeedStatus } from "../feed/useChainFeed";
import { RailMachine } from "./machine";

/** Runs the hero transfer: the recording first, the live chains from the next transfer once they answer. */
export function useTransferDemo(status: FeedStatus) {
  const [machine] = useState(() => RailMachine.boot());
  const snap = useSyncExternalStore(machine.subscribe, machine.getSnapshot, machine.getSnapshot);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      machine.step(now - last);
      last = now;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [machine]);

  useEffect(() => {
    if (status.mode === "live") machine.offerLive(status.feed);
    else if (status.mode === "replay") machine.dropLive();
  }, [machine, status]);

  return { snap, machine };
}
