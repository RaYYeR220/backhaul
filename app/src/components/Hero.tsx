"use client";

import Link from "next/link";
import { useCallback, type MouseEvent } from "react";
import { useChainFeed, type FeedStatus } from "@/lib/feed/useChainFeed";
import { fmt, utcStamp } from "@/lib/format";
import { links } from "@/lib/links";
import type { RailMachine, RailSnapshot, Rich } from "@/lib/rail/machine";
import { useTransferDemo } from "@/lib/rail/useTransferDemo";
import { TransferRail } from "./rail/TransferRail";
import s from "./Hero.module.css";

export function Hero() {
  const feed = useChainFeed();
  const { snap, machine } = useTransferDemo(feed.status);

  const breakProof = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("rail")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      machine.forge();
    },
    [machine],
  );

  const out = snap.direction === "out";
  return (
    <main id="main" className={s.hero}>
      <h1 className={`${s.h1} reveal`} data-stagger>
        Proven both ways across.
      </h1>
      <p className={`${s.sub} reveal`} data-stagger>
        Every Portaldot bridge so far trusts someone on the way back. Backhaul trusts no one, in either direction.
      </p>
      <div className={`${s.ctas} reveal`} data-stagger>
        <Link className="btn btn-primary" href={links.app}>
          Bridge both ways
        </Link>
        <a className="btn btn-ghost" href="#rail" onClick={breakProof}>
          Break a proof
        </a>
      </div>
      <p className={`${s.proofline} reveal`} data-stagger>
        <i className={s.dot} aria-hidden="true" />
        Portaldot V3 testnet ↔ BNB Chain testnet · 0 trusted parties, either way
      </p>

      <div className={`${s.object} reveal`} data-stagger>
        <TransferRail
          id="rail"
          direction={out ? "toBnb" : "toPortaldot"}
          onDirectionChange={(d) => machine.setDirection(d === "toBnb" ? "out" : "in")}
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
          forge={{ label: out ? "Forge a signature" : "Forge a seal", armed: snap.forgeArmed, onForge: machine.forge }}
          announcement={snap.announcement}
          footer={<SourceLine snap={snap} status={feed.status} span={machine.replaySpan} onLive={feed.connect} onReplay={feed.showReplay} />}
        />
      </div>
    </main>
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

/** Says where the rail's data comes from right now: the live nodes, or the recording. */
function SourceLine({
  snap,
  status,
  span,
  onLive,
  onReplay,
}: {
  snap: RailSnapshot;
  status: FeedStatus;
  span: RailMachine["replaySpan"];
  onLive: () => void;
  onReplay: () => void;
}) {
  if (snap.source === "live") {
    return (
      <div className={`${s.src} ${s.live}`}>
        <i className={s.ld} aria-hidden="true" />
        <span>
          live · BNB Chain testnet headers · Portaldot V3 finalized blocks and BEEFY justifications, set {snap.setId}
        </span>
        <button type="button" onClick={onReplay}>
          show the replay
        </button>
      </div>
    );
  }
  const recorded = `replay of real headers · BSC testnet #${fmt(span.bsc[0])}–#${fmt(span.bsc[1])} · Portaldot V3 #${fmt(span.pdt[0])}–#${fmt(span.pdt[1])} · recorded ${utcStamp(span.recorded)}`;
  let note = "";
  let action: { label: string; run: () => void } | null = null;
  if (snap.liveQueued) note = "live nodes connected, they take over after this transfer";
  else if (status.mode === "connecting") note = "connecting to the live nodes";
  else if (status.mode === "replay" && status.reason === "unreachable") {
    note = "live nodes unreachable";
    action = { label: "try again", run: onLive };
  } else if (status.mode === "replay" && status.reason === "dropped") {
    note = "live feed dropped";
    action = { label: "reconnect", run: onLive };
  } else if (status.mode === "replay") action = { label: "go live", run: onLive };
  return (
    <div className={s.src}>
      <i className={s.ld} aria-hidden="true" />
      <span>
        {recorded}
        {note && ` · ${note}`}
      </span>
      {action && (
        <button type="button" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
