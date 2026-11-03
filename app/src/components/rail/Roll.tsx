"use client";

import { useEffect, useState } from "react";
import s from "./TransferRail.module.css";

/** A number whose changed characters roll; unchanged ones stay put. */
export function Roll({ value, className }: { value: string; className?: string }) {
  return (
    <span className={className}>
      <span className="sr-only">{value}</span>
      {/* a length change remounts every slot instead of rolling */}
      <span key={value.length} className={s.roll} aria-hidden="true">
        {[...value].map((c, i) => (
          <Char key={i} c={c} />
        ))}
      </span>
    </span>
  );
}

function Char({ c }: { c: string }) {
  const [st, setSt] = useState({ cur: c, prev: null as string | null, gen: 0 });
  if (st.cur !== c) setSt({ cur: c, prev: st.cur, gen: st.gen + 1 });

  useEffect(() => {
    if (st.prev === null) return;
    const gen = st.gen;
    const id = setTimeout(() => setSt((x) => (x.gen === gen ? { ...x, prev: null } : x)), 430);
    return () => clearTimeout(id);
  }, [st.gen, st.prev]);

  return (
    <span className={s.rd}>
      {st.prev !== null && (
        <span key={`o${st.gen}`} className={`${s.rc} ${s.rcOut}`}>
          {st.prev}
        </span>
      )}
      <span key={`i${st.gen}`} className={st.prev !== null ? `${s.rc} ${s.rcIn}` : s.rc}>
        {st.cur}
      </span>
    </span>
  );
}
