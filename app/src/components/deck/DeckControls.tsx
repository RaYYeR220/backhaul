"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mark } from "@/components/Chrome";
import s from "./Deck.module.css";

const slides = () => [...document.querySelectorAll<HTMLElement>("[data-slide]")];

/** Which slide is nearest the middle of the window. */
function current(list: HTMLElement[]) {
  const mid = window.innerHeight / 2;
  let best = 0;
  let gap = Infinity;
  list.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - mid);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}

/** ← and → step through the slides; the counter follows the scroll. */
export function DeckControls({ total }: { total: number }) {
  const [at, setAt] = useState(0);
  // while a smooth scroll is on its way, the next key press counts from where it is going
  const target = useRef({ i: 0, until: 0 });

  const go = useCallback((delta: number | "first" | "last") => {
    const list = slides();
    if (!list.length) return;
    const from = performance.now() < target.current.until ? target.current.i : current(list);
    const i = delta === "first" ? 0 : delta === "last" ? list.length - 1 : Math.max(0, Math.min(list.length - 1, from + delta));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list[i].scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    target.current = { i, until: performance.now() + (reduce ? 0 : 900) };
    setAt(i);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const move: Record<string, number | "first" | "last"> = {
        ArrowRight: 1,
        PageDown: 1,
        ArrowLeft: -1,
        PageUp: -1,
        Home: "first",
        End: "last",
      };
      const m = move[e.key];
      if (m === undefined) return;
      e.preventDefault();
      go(m);
    };
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (performance.now() >= target.current.until) setAt(current(slides()));
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [go]);

  return (
    <>
      <header className={s.bar}>
        <Link className={s.brand} href="/" aria-label="Backhaul home">
          <Mark />
          Backhaul
        </Link>
        <span className={s.barNote}>Pitch deck · use ← and → to move</span>
        <a className="btn btn-ghost btn-sm" href="/backhaul-deck.pdf" download>
          Download PDF
        </a>
      </header>
      <nav className={s.pager} aria-label="Slides">
        <button type="button" onClick={() => go(-1)} aria-label="Previous slide" disabled={at === 0}>
          <span aria-hidden="true">←</span>
        </button>
        <span className="mono" aria-live="polite">
          {String(at + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
        </span>
        <button type="button" onClick={() => go(1)} aria-label="Next slide" disabled={at === total - 1}>
          <span aria-hidden="true">→</span>
        </button>
      </nav>
    </>
  );
}
