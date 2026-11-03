"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { TransferRail } from "@/components/rail/TransferRail";
import { useChainFeed } from "@/lib/feed/useChainFeed";
import { fmt, utcStamp } from "@/lib/format";
import { RailMachine, type RailSnapshot, type Rich } from "@/lib/rail/machine";
import { useTransferDemo } from "@/lib/rail/useTransferDemo";
import s from "./Deck.module.css";

/**
 * The landing's transfer rail on a slide. On screen it runs like the hero: the recording first,
 * the live chains once they answer. For print (and for `?print`) it holds one recorded transfer at
 * the moment it is released, so every export shows the same, real frame.
 */
export function DeckRail() {
  const [still, setStill] = useState(true);

  useEffect(() => {
    const pinned = new URLSearchParams(window.location.search).has("print");
    if (pinned) {
      document.documentElement.dataset.deckReady = "1";
      return;
    }
    setStill(false);
    const before = () => flushSync(() => setStill(true));
    const after = () => setStill(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  return (
    <div className={s.rail} data-clip-ok>
      {still ? <StillRail /> : <LiveRail />}
    </div>
  );
}

let released: { snap: RailSnapshot; span: RailMachine["replaySpan"] } | null = null;

/** The first recorded transfer, run on its own clock until BNB.b is released on Portaldot. */
function releasedFrame() {
  if (released) return released;
  const m = RailMachine.boot();
  let snap = m.getSnapshot();
  for (let i = 0; i < 4000 && !(snap.chip.released && snap.steps.every((x) => x.done)); i++) {
    m.step(50);
    snap = m.getSnapshot();
  }
  released = { snap, span: m.replaySpan };
  return released;
}

function StillRail() {
  const { snap, span } = releasedFrame();
  return (
    <Rail
      snap={snap}
      footer={
        <p className={s.railSrc}>
          <i aria-hidden="true" />
          replay of real headers · BNB Chain testnet #{fmt(span.bsc[0])}–#{fmt(span.bsc[1])} · Portaldot V3 #{fmt(span.pdt[0])}–#
          {fmt(span.pdt[1])} · recorded {utcStamp(span.recorded)}
        </p>
      }
    />
  );
}

function LiveRail() {
  const feed = useChainFeed();
  const { snap, machine } = useTransferDemo(feed.status);
  const out = snap.direction === "out";
  const span = machine.replaySpan;
  const where =
    snap.source === "live"
      ? `live · BNB Chain testnet headers · Portaldot V3 finalized blocks and BEEFY justifications, set ${snap.setId}`
      : `replay of real headers · BNB Chain testnet #${fmt(span.bsc[0])}–#${fmt(span.bsc[1])} · recorded ${utcStamp(span.recorded)}${
          snap.liveQueued ? " · live from the next transfer" : feed.status.mode === "connecting" ? " · connecting to the live nodes" : ""
        }`;
  return (
    <Rail
      snap={snap}
      onDirection={(d) => machine.setDirection(d === "toBnb" ? "out" : "in")}
      forge={{ label: out ? "Forge a signature" : "Forge a seal", armed: snap.forgeArmed, onForge: machine.forge }}
      footer={
        <p className={`${s.railSrc} ${snap.source === "live" ? s.railLive : ""}`}>
          <i aria-hidden="true" />
          {where}
        </p>
      }
    />
  );
}

function Rail({
  snap,
  footer,
  onDirection,
  forge,
}: {
  snap: RailSnapshot;
  footer: React.ReactNode;
  onDirection?: (d: "toBnb" | "toPortaldot") => void;
  forge?: { label: string; armed: boolean; onForge: () => void };
}) {
  const out = snap.direction === "out";
  return (
    <TransferRail
      id="deck-rail"
      direction={out ? "toBnb" : "toPortaldot"}
      onDirectionChange={onDirection}
      bnb={{ head: snap.bscHead, ticks: snap.ticks }}
      portaldot={{ head: snap.pdtHead, beats: snap.beats }}
      verifier={out ? "BEEFY light client on BNB Chain" : "Parlia light client on Portaldot"}
      gateOpen={snap.gateOpen}
      chip={snap.chip}
      sealers={snap.slots}
      sealed={snap.sealed}
      threshold={snap.threshold}
      caption={<RichText parts={snap.caption} />}
      reverted={snap.reverted}
      steps={snap.steps.map((st) => ({ label: <RichText parts={st.label} />, done: st.done }))}
      forge={forge}
      announcement={snap.announcement}
      footer={footer}
    />
  );
}

function RichText({ parts }: { parts: Rich }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <span key={i} className="mono">
            {p.mono}
          </span>
        ),
      )}
    </>
  );
}
