"use client";

import { useLayoutEffect, useRef } from "react";
import s from "./TransferRail.module.css";

export interface LaneTick {
  n: number;
  mark?: "deposit" | "release";
}
export interface LaneBeat {
  n: number;
  mark?: "lock" | "release";
}

/** Slides a row by `offset` px and back whenever its newest item changes, so new items push in. */
function useSlide(newest: number | undefined, offset: number) {
  const row = useRef<HTMLDivElement>(null);
  const seen = useRef(newest);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || newest === undefined || seen.current === undefined || newest === seen.current) {
      seen.current = newest;
      return;
    }
    seen.current = newest;
    el.classList.remove(s.slide);
    el.style.transform = `translateX(${offset}px)`;
    const id = requestAnimationFrame(() => {
      el.classList.add(s.slide);
      el.style.transform = "";
    });
    return () => cancelAnimationFrame(id);
  }, [newest, offset]);
  return row;
}

/** BNB Chain's tempo: a fine tick per header, every 0.45 s. */
export function BnbLane({ ticks }: { ticks: LaneTick[] }) {
  const row = useSlide(ticks[ticks.length - 1]?.n, 5);
  return (
    <div className={`${s.lane} ${s.laneB}`} aria-hidden="true">
      <div ref={row} className={s.laneRow}>
        {ticks.map((t) => (
          <i key={t.n} className={`${s.tk} ${t.mark === "deposit" ? s.tkDep : t.mark === "release" ? s.tkRel : ""}`} />
        ))}
      </div>
    </div>
  );
}

/** Portaldot's tempo: a wide beat per block, every 6 s. */
export function PortaldotLane({ beats }: { beats: LaneBeat[] }) {
  const row = useSlide(beats[beats.length - 1]?.n, -32);
  return (
    <div className={`${s.lane} ${s.laneP}`} aria-hidden="true">
      <div ref={row} className={s.laneRow}>
        {beats.map((b) => (
          <i key={b.n} className={`${s.bt} ${b.mark === "lock" ? s.btLock : b.mark === "release" ? s.btRel : ""}`} />
        ))}
      </div>
    </div>
  );
}
