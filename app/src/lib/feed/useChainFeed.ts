"use client";

import { useCallback, useEffect, useState } from "react";
import { LiveFeed } from "./live";

export type FeedStatus =
  | { mode: "connecting" }
  | { mode: "live"; feed: LiveFeed }
  | { mode: "replay"; reason: "unreachable" | "dropped" | "chosen" };

/**
 * Connects to BNB Chain testnet and Portaldot V3 in the browser. While it connects, and whenever
 * it cannot connect or the connection drops, the status says to show the recorded replay.
 */
export function useChainFeed() {
  const [status, setStatus] = useState<FeedStatus>({ mode: "connecting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt < 0) return;
    if (typeof WebSocket === "undefined") {
      setStatus({ mode: "replay", reason: "unreachable" });
      return;
    }
    let alive = true;
    const feed = new LiveFeed();
    feed.onDrop = () => alive && setStatus({ mode: "replay", reason: "dropped" });
    feed.connect().then(
      () => alive && setStatus({ mode: "live", feed }),
      () => alive && setStatus({ mode: "replay", reason: "unreachable" }),
    );
    return () => {
      alive = false;
      feed.close();
    };
  }, [attempt]);

  const connect = useCallback(() => {
    setStatus({ mode: "connecting" });
    setAttempt((a) => Math.abs(a) + 1);
  }, []);

  const showReplay = useCallback(() => {
    setStatus({ mode: "replay", reason: "chosen" });
    setAttempt((a) => -Math.abs(a) - 1);
  }, []);

  return { status, connect, showReplay };
}
