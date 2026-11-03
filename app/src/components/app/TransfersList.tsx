"use client";

import Link from "next/link";
import { useState } from "react";
import { amount, chainLabel, jobAssets } from "@/lib/assets";
import { links } from "@/lib/links";
import { relayer, type Job } from "@/lib/relayer";
import { jobNodes } from "@/lib/timeline";
import { usePoll } from "@/lib/usePoll";
import { Ago, Empty, RelayerBanner, StatePill, ViewHead } from "./ui";
import s from "./TransfersList.module.css";

type Filter = "all" | "transfer" | "order";

const PILL: Record<string, { tone: "proven" | "waiting" | "failed"; label: string }> = {
  locked: { tone: "waiting", label: "Waiting for proof" },
  proven: { tone: "waiting", label: "Proven" },
  finalized: { tone: "proven", label: "Released" },
  open: { tone: "waiting", label: "Open" },
  filled: { tone: "waiting", label: "Filled" },
  settled: { tone: "proven", label: "Settled" },
  refunded: { tone: "proven", label: "Refunded" },
  failed: { tone: "failed", label: "Stopped" },
};

export function TransfersList() {
  const [filter, setFilter] = useState<Filter>("all");
  const list = usePoll((sig) => relayer.transfers({ limit: 100, type: filter === "all" ? undefined : filter }, sig), () => 8_000, `list:${filter}`);
  const status = usePoll((sig) => relayer.status(sig), () => 60_000, "status");
  const known = { ppot: status.data?.addresses?.bsc?.PPOT, bnbb: status.data?.addresses?.portaldot?.bnbb as string | undefined };
  const items = list.data?.items ?? [];

  return (
    <>
      <ViewHead
        kicker="Transfers"
        title="Everything crossing, newest first."
        lead="Canonical transfers wait for a light-client proof. Orders on the fast path are paid by a solver first and repaid after the proof."
      />
      <RelayerBanner error={list.error} at={list.at} onRetry={list.refresh} />

      <div className={s.bar}>
        <div className={s.seg} role="group" aria-label="Show">
          {(["all", "transfer", "order"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "transfer" ? "Transfers" : "Orders"}
            </button>
          ))}
        </div>
        {list.data && (
          <span className={s.count}>
            {items.length} {items.length === 1 ? "job" : "jobs"}
          </span>
        )}
      </div>

      {list.loading ? (
        <Empty title="Loading…" />
      ) : !list.data ? (
        <Empty title="No list without the relayer.">The relayer indexes every transfer and order it sees on both chains.</Empty>
      ) : items.length === 0 ? (
        <Empty title={filter === "order" ? "No orders yet." : "Nothing has crossed yet."}>
          <Link className="btn btn-ghost btn-sm" href={links.app}>
            Send the first one
          </Link>
        </Empty>
      ) : (
        <ul className={s.list}>
          {items.map((j) => (
            <Row key={j.id} j={j} known={known} />
          ))}
        </ul>
      )}
    </>
  );
}

function Row({ j, known }: { j: Job; known: { ppot?: string; bnbb?: string } }) {
  const a = jobAssets(j, known);
  const pill = PILL[j.state] ?? { tone: "waiting" as const, label: j.state };
  const nodes = jobNodes(j, null).filter((n) => n.lane === "main");
  const what =
    j.type === "transfer" ? (
      <>
        <span className="mono">{amount(j.amount)}</span> {a.received}
      </>
    ) : (
      <>
        <span className="mono">{amount(j.inputAmount)}</span> {a.sent} <span className={s.dim}>for</span> <span className="mono">{amount(j.outputAmount)}</span>{" "}
        {a.received}
      </>
    );
  return (
    <li>
      <Link className={s.row} href={`/transfers/${encodeURIComponent(j.id)}`}>
        <span className={s.route}>
          {chainLabel(j.from)} <span className={s.dim}>→</span> {chainLabel(j.to)}
          <span className={s.type}>{j.type === "order" ? "order" : "transfer"}</span>
        </span>
        <span className={s.what}>{what}</span>
        <span className={s.progress} aria-hidden="true">
          {nodes.map((n) => (
            <i key={n.key} className={s[n.tone]} />
          ))}
        </span>
        <span className={s.state}>
          <StatePill tone={pill.tone}>{pill.label}</StatePill>
        </span>
        <span className={`mono ${s.id}`}>{j.type === "order" ? `${j.id.slice(0, 10)}…` : j.id}</span>
        <span className={s.when}>
          <Ago at={j.createdAt} />
        </span>
      </Link>
    </li>
  );
}
