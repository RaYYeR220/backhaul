"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** Fades `.reveal` blocks in once as they enter the viewport; the hero staggers by 70 ms. */
export function Reveal() {
  const path = usePathname();
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>(".reveal:not(.in)")];
    const show = (el: Element) => el.classList.add("in");
    els.forEach((el, i) => {
      if (el.dataset.stagger !== undefined) el.style.transitionDelay = `${Math.min(i, 5) * 70}ms`;
    });
    if (!("IntersectionObserver" in window)) {
      els.forEach(show);
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            show(e.target);
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.08 },
    );
    els.forEach((el) => io.observe(el));
    const failsafe = setTimeout(() => els.forEach(show), 1600);
    return () => {
      io.disconnect();
      clearTimeout(failsafe);
    };
  }, [path]);
  return null;
}
