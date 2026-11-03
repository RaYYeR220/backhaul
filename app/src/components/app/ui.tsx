"use client";

import type { ReactNode } from "react";
import { RELAYER_URL, type ChainName } from "@/lib/config";
import { addressUrl, blockUrl, shortHex, txUrl } from "@/lib/explorer";
import { fmt } from "@/lib/format";
import { isUnreachable, RelayerError } from "@/lib/relayer";
import { useNow } from "@/lib/usePoll";
import { StruckCircle } from "../rail/TransferRail";
import s from "./app.module.css";

/** The page head every app view shares: kicker, title, one or two lines of lead. */
export function ViewHead({ kicker, title, lead, children }: { kicker: string; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className={s.head}>
      <p className={s.kicker}>{kicker}</p>
      <h1 id="view-h" className={s.h1}>
        {title}
      </h1>
      {lead && <p className={s.lead}>{lead}</p>}
      {children}
    </header>
  );
}

/**
 * Says plainly that the relayer is not answering, and how old anything still on screen is.
 * Renders nothing while the relayer answers.
 */
export function RelayerBanner({ error, at, onRetry }: { error: unknown; at?: number | null; onRetry?: () => void }) {
  if (!error) return null;
  const unreachable = isUnreachable(error);
  const msg = error instanceof RelayerError ? error.message : error instanceof Error ? error.message : String(error);
  return (
    <div className={s.banner} role="status">
      <StruckCircle size={14} />
      <div>
        <b>{unreachable ? "The relayer is not answering." : "The relayer answered with an error."}</b>
        <span>
          {unreachable ? (
            <>
              Nothing here is live until <span className="mono">{RELAYER_URL}</span> answers.
            </>
          ) : (
            msg
          )}
          {at ? ` What you see is from ${clock(at)}.` : ""}
        </span>
      </div>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** A height, hash or address in mono, linked to its explorer when one exists. */
export function Hex({
  chain,
  kind,
  value,
  block,
  full,
  label,
}: {
  chain: ChainName | null;
  kind: "tx" | "block" | "address";
  value: string | number;
  block?: string | number | null;
  full?: boolean;
  label?: string;
}) {
  const v = String(value);
  const text = label ?? (kind === "block" ? "#" + fmt(Number(v)) : full ? v : shortHex(v));
  const url = !chain ? null : kind === "block" ? blockUrl(chain, v) : kind === "tx" ? txUrl(chain, v, block) : addressUrl(chain, v);
  if (!url) return <span className={`mono ${s.hex}`}>{text}</span>;
  return (
    <a className={`mono ${s.hex} ${s.hexLink}`} href={url} target="_blank" rel="noreferrer" title={v}>
      {text}
    </a>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 18:02:11 UTC */
export function clock(ms: number | string) {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function duration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

/** "12 s ago", refreshed every second. */
export function Ago({ at }: { at: number | string }) {
  const now = useNow(1000);
  const t = typeof at === "number" ? at : Date.parse(at);
  return <time dateTime={new Date(t).toISOString()}>{duration((now - t) / 1000)} ago</time>;
}

/** A small state label. `proven` carries the accent, `failed` is hollow and struck. */
export function StatePill({ tone, children }: { tone: "proven" | "waiting" | "failed" | "quiet"; children: ReactNode }) {
  return (
    <span className={`${s.pill} ${s[`pill_${tone}`]}`}>
      {tone === "failed" ? <StruckCircle size={11} /> : <i aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Centered note for empty, loading and not-found states. */
export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <b>{title}</b>
      {children && <div>{children}</div>}
    </div>
  );
}
