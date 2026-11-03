"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Poll<T> {
  data: T | undefined;
  error: unknown;
  /** True until the first answer or error. */
  loading: boolean;
  /** When `data` was last refreshed, ms. */
  at: number | null;
  refresh: () => void;
}

/**
 * Loads `load` now and again every `every(data)` ms (null stops). The last good answer is kept
 * through later errors, so the view can say how old it is. Paused while the tab is hidden.
 */
export function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, every: (data: T | undefined, error: unknown) => number | null, key: string): Poll<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean; at: number | null; key: string }>({
    data: undefined,
    error: null,
    loading: true,
    at: null,
    key,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  const everyRef = useRef(every);
  loadRef.current = load;
  everyRef.current = every;

  if (state.key !== key) setState({ data: undefined, error: null, loading: true, at: null, key });

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let last: T | undefined;

    const schedule = (data: T | undefined, error: unknown) => {
      const ms = everyRef.current(data, error);
      if (ms == null || !alive) return;
      timer = setTimeout(run, ms);
    };

    const run = async () => {
      if (document.hidden) {
        const resume = () => {
          document.removeEventListener("visibilitychange", resume);
          if (alive) run();
        };
        document.addEventListener("visibilitychange", resume);
        return;
      }
      try {
        const data = await loadRef.current(ctl.signal);
        if (!alive) return;
        last = data;
        setState({ data, error: null, loading: false, at: Date.now(), key });
        schedule(data, null);
      } catch (error) {
        if (!alive || ctl.signal.aborted) return;
        setState((s) => ({ ...s, error, loading: false }));
        schedule(last, error);
      }
    };

    run();
    return () => {
      alive = false;
      ctl.abort();
      clearTimeout(timer);
    };
  }, [key, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, at: state.at, refresh };
}

/** Re-renders every `ms`, for "12 s ago" labels and countdowns. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
