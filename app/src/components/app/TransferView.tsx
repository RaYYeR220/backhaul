"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { amount, chainLabel, jobAssets, routeOfKind } from "@/lib/assets";
import { CHAINS, type ChainName } from "@/lib/config";
import { fmt } from "@/lib/format";
import { links } from "@/lib/links";
import type { Rich } from "@/lib/rail/machine";
import { isUnreachable, RelayerError, relayer, type Job, type Status, type TransferJob } from "@/lib/relayer";
import { jobNodes, settled, type SignerCount, type TNode } from "@/lib/timeline";
import { useLanes } from "@/lib/useLanes";
import { useNow, usePoll } from "@/lib/usePoll";
import { useSigners, type Signers } from "@/lib/useSigners";
import { TransferRail, type Sealer } from "../rail/TransferRail";
import { Ago, clock, duration, Empty, Hex, RelayerBanner, StatePill, ViewHead } from "./ui";
import s from "./TransferView.module.css";

export function TransferView({ id }: { id: string }) {
  const firstMiss = useRef<number | null>(null);
  const job = usePoll(
    (sig) => relayer.job(id, sig),
    (d, e) => (d && settled(d) ? 20_000 : e && isUnreachable(e) ? 8_000 : 3_000),
    id,
  );
  const status = usePoll((sig) => relayer.status(sig), () => 60_000, "status");
  const notFound = job.error instanceof RelayerError && job.error.status === 404;
  if (notFound && firstMiss.current === null) firstMiss.current = Date.now();
  if (job.data) firstMiss.current = null;

  const j = job.data;
  if (!j) {
    return (
      <>
        <ViewHead kicker="Transfer" title={<span className={s.idTitle}>{id}</span>} />
        {notFound ? (
          <NotIndexed id={id} since={firstMiss.current ?? Date.now()} />
        ) : job.error ? (
          <RelayerBanner error={job.error} onRetry={job.refresh} />
        ) : (
          <Empty title="Looking it up…" />
        )}
      </>
    );
  }
  return <JobView j={j} status={status.data} error={job.error} at={job.at} onRetry={job.refresh} />;
}

function NotIndexed({ id, since }: { id: string; since: number }) {
  const now = useNow(1000);
  const waited = (now - since) / 1000;
  return (
    <Empty title={waited < 120 ? "Not indexed yet." : "Still not indexed."}>
      {waited < 120 ? (
        <>
          The relayer picks transfers up from finalized Portaldot blocks and from BNB Chain blocks 15 deep, so a new one shows up
          after about 15 s. This page checks every 3 s.
        </>
      ) : (
        <>
          Nothing is indexed under <span className="mono">{id}</span> after {duration(waited)}. If you just sent it, check that the
          source transaction landed; otherwise the id may be wrong.
        </>
      )}
      <div className={s.waited}>
        <span className="mono">{duration(waited)}</span> waiting
      </div>
    </Empty>
  );
}

const PILL: Record<string, { tone: "proven" | "waiting" | "failed"; label: string }> = {
  locked: { tone: "waiting", label: "Waiting for the proof" },
  proven: { tone: "waiting", label: "Proven, releasing" },
  finalized: { tone: "proven", label: "Released" },
  open: { tone: "waiting", label: "Open" },
  filled: { tone: "waiting", label: "Filled, repayment waits for the proof" },
  settled: { tone: "proven", label: "Settled" },
  refunded: { tone: "proven", label: "Refunded" },
  failed: { tone: "failed", label: "Stopped" },
};

function known(st?: Status) {
  return { ppot: st?.addresses?.bsc?.PPOT as string | undefined, bnbb: st?.addresses?.portaldot?.bnbb as string | undefined };
}

function JobView({ j, status, error, at, onRetry }: { j: Job; status?: Status; error: unknown; at: number | null; onRetry: () => void }) {
  const transfer = j.type === "transfer" ? j : null;
  const lock = j.steps.find((x) => x.name === "locked" || x.name === "opened");
  const lockBlock = lock?.block ? Number(lock.block) : null;
  const proven = j.steps.some((x) => x.name === "beefy" || x.name === "parlia" || x.name === "finalized");
  const sig = useSigners(transfer ? transfer.from : null, transfer ? lockBlock : null, proven);
  const reveal = useReveal(sig.signers?.kind === "parlia" ? sig.signers.order.length : 0);

  const count: SignerCount | null = useMemo(() => {
    const x = sig.signers;
    if (!x) return null;
    if (x.kind === "parlia") return { have: Math.min(reveal, x.quorum), need: x.quorum, of: x.validators.length };
    return { have: x.signedPast || proven ? x.authorities.length : 0, need: x.authorities.length, of: x.authorities.length };
  }, [sig.signers, reveal, proven]);

  const nodes = jobNodes(j, count, known(status));
  const a = jobAssets(j, known(status));
  const pill = PILL[j.state] ?? { tone: "waiting" as const, label: j.state };
  const title =
    j.type === "transfer" ? (
      <>
        {amount(j.amount)} {a.received} to {chainLabel(j.to)}
      </>
    ) : (
      <>
        {amount(j.inputAmount)} {a.sent} for {amount(j.outputAmount)} {a.received}
      </>
    );

  return (
    <>
      <ViewHead kicker={j.type === "transfer" ? `Transfer ${j.id}` : "Order, fast path"} title={title}>
        <dl className={s.meta}>
          <div>
            <dt>State</dt>
            <dd>
              <StatePill tone={pill.tone}>{pill.label}</StatePill>
            </dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>
              {chainLabel(j.from)} → {chainLabel(j.to)}
            </dd>
          </div>
          <div>
            <dt>Recipient</dt>
            <dd>
              <Hex chain={j.to} kind="address" value={j.recipient} />
            </dd>
          </div>
          <div>
            <dt>{j.type === "transfer" ? "Source" : "Opened in"}</dt>
            <dd>
              <Hex chain={j.from} kind="tx" value={j.sourceTx} block={lock?.block} />
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              {clock(j.createdAt)} · <Ago at={j.createdAt} />
            </dd>
          </div>
          {j.type === "order" && (
            <div>
              <dt>Fill deadline</dt>
              <dd>
                <Deadline at={j.fillDeadline * 1000} />
              </dd>
            </div>
          )}
          {j.type === "order" && (
            <div>
              <dt>Order id</dt>
              <dd>
                <span className="mono" title={j.orderId}>
                  {j.orderId.slice(0, 10)}…{j.orderId.slice(-6)}
                </span>
              </dd>
            </div>
          )}
        </dl>
      </ViewHead>

      <RelayerBanner error={error} at={at} onRetry={onRetry} />

      {transfer && <Rail j={transfer} signers={sig.signers} signersError={sig.error} reveal={reveal} lockBlock={lockBlock} />}

      <section className={s.timeline} aria-labelledby="tl-h">
        <h2 id="tl-h" className={s.h2}>
          Every step, as it landed
        </h2>
        <Timeline nodes={nodes} start={j.steps[0]?.at ?? j.createdAt} signers={sig.signers} reveal={reveal} signersError={sig.error} />
        <p className={s.after}>
          <Link href={links.transfers}>All transfers</Link>
          <span aria-hidden="true"> · </span>
          <Link href={links.status}>Both light clients</Link>
        </p>
      </section>
    </>
  );
}

function Deadline({ at }: { at: number }) {
  const now = useNow(1000);
  const left = (at - now) / 1000;
  return (
    <>
      {clock(at)} · {left > 0 ? `in ${duration(left)}` : `passed ${duration(-left)} ago`}
    </>
  );
}

/** Steps a count up to `target` one at a time, so a quorum read in one go still fills in order. */
function useReveal(target: number) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= target) {
      if (shown > target) setShown(target);
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(target);
      return;
    }
    const id = setTimeout(() => setShown((n) => Math.min(n + 1, target)), 240);
    return () => clearTimeout(id);
  }, [shown, target]);
  return shown;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const h = (n: number | string) => ({ mono: "#" + fmt(Number(n)) });

/* ---------- the rail, in this transfer's real state ---------- */

function Rail({ j, signers, signersError, reveal, lockBlock }: { j: TransferJob; signers: Signers | null; signersError: string | null; reveal: number; lockBlock: number | null }) {
  const lanes = useLanes();
  const dirIn = j.from === "bsc";
  const route = routeOfKind(j.kindName);
  const fin = j.steps.find((x) => x.name === "finalized");
  const lc = j.steps.some((x) => x.name === (dirIn ? "parlia" : "beefy"));
  const failed = j.state === "failed";
  // the gate stands for the light client: it opens on an accepted proof, even if the release later stops
  const gateOpen = lc || !!fin;
  const released = !!fin;
  const finBlock = fin?.block ? Number(fin.block) : null;

  let sealers: Sealer[] = [];
  let sealed = 0;
  let threshold = dirIn ? 6 : 2;
  let caption: Rich = [];

  if (signers?.kind === "parlia") {
    threshold = signers.quorum;
    const order = signers.order.slice(0, reveal);
    const quorum = order.length >= signers.quorum;
    sealed = Math.min(order.length, signers.quorum);
    sealers = signers.validators.map((v, i) => {
      const pos = order.indexOf(i);
      const state: Sealer["state"] = pos >= 0 ? (gateOpen ? "quorum" : pos === order.length - 1 && !quorum ? "active" : "sealed") : quorum || gateOpen ? "unused" : "idle";
      return { key: v, index: String(i), aside: pos >= 0 ? ordinal(pos + 1) : undefined, tag: v.slice(2, 6).toLowerCase(), state, meter: { filled: pos >= 0 ? Math.min(signers.counts[i], 8) : 0, of: 8 } };
    });
    caption = failed
      ? [j.error ?? "Stopped"]
      : gateOpen
        ? ["Finalized on Portaldot by the Parlia light client"]
        : quorum
          ? ["Quorum sealed above ", h(signers.from), ", waiting for the relayer to submit the window"]
          : [`${sealed} of ${signers.quorum} distinct validators have sealed from `, h(signers.from)];
  } else if (signers?.kind === "beefy") {
    threshold = signers.authorities.length;
    const signed = signers.signedPast || gateOpen;
    sealed = signed ? signers.authorities.length : 0;
    sealers = signers.authorities.map((k, i) => ({
      key: k,
      index: `authority ${i}`,
      tag: `${k.slice(4, 8)}…${k.slice(-4)}`,
      state: gateOpen ? "quorum" : signed ? "sealed" : "idle",
      status: gateOpen ? "proven" : signed ? "signed" : "waiting",
    }));
    caption = failed
      ? [j.error ?? "Stopped"]
      : gateOpen
        ? ["Proven on BNB Chain by the BEEFY light client"]
        : signed
          ? ["Both authorities signed past ", h(signers.from), ", waiting for the relayer to prove it on BNB Chain"]
          : ["Waiting for BEEFY to sign past ", h(signers.from), " (signed up to ", h(signers.beefyHead), ")"];
  } else {
    caption = signersError
      ? [`Could not read the ${dirIn ? "sealers from BNB Chain" : "BEEFY authorities from Portaldot"}: ${signersError}`]
      : gateOpen
        ? [dirIn ? "Finalized on Portaldot by the Parlia light client" : "Proven on BNB Chain by the BEEFY light client"]
        : [`Reading the ${dirIn ? "sealers from BNB Chain" : "BEEFY authorities from Portaldot"}`];
  }

  const ticks = lanes.ticks.map((n) => ({ n, mark: dirIn && n === lockBlock ? ("deposit" as const) : !dirIn && n === finBlock ? ("release" as const) : undefined }));
  const beats = lanes.beats.map((n) => ({ n, mark: !dirIn && n === lockBlock ? ("lock" as const) : dirIn && n === finBlock ? ("release" as const) : undefined }));
  const amt = amount(j.amount);

  return (
    <section className={s.railBox} aria-label="This transfer on the rail">
      <TransferRail
        direction={dirIn ? "toPortaldot" : "toBnb"}
        bnb={{ head: lanes.bscHead, ticks }}
        portaldot={{ head: lanes.pdtHead, beats }}
        verifier={dirIn ? "Parlia light client on Portaldot" : "BEEFY light client on BNB Chain"}
        gateOpen={gateOpen}
        chip={{
          amount: amt,
          asset: released ? (route?.receive ?? "") : (route?.send ?? ""),
          note: released ? "released" : failed ? "stopped" : route?.feeBps ? "net of fee" : undefined,
          at: released ? "destination" : "gate",
          released,
          stopped: failed,
        }}
        sealers={sealers}
        sealed={sealed}
        threshold={threshold}
        caption={<RichText parts={caption} />}
        reverted={failed}
        steps={[]}
        announcement={gateOpen ? String(caption.map((p) => (typeof p === "string" ? p : p.mono)).join("")) : undefined}
        footer={
          <p className={s.src}>
            {lanes.live
              ? "Lanes: live BNB Chain testnet headers and finalized Portaldot blocks."
              : lanes.failed
                ? "Lanes off: the live nodes did not answer."
                : "Connecting the lanes to the live nodes."}
            {signers?.kind === "parlia" && signers.scannedTo >= signers.from && (
              <>
                {" "}
                Sealers read from BNB Chain blocks <span className="mono">#{fmt(signers.from)}</span>–<span className="mono">#{fmt(signers.scannedTo)}</span>
                {signers.untrusted ? `, ${signers.untrusted} sealed by a validator outside the set and not counted` : ""}.
              </>
            )}
            {signers?.kind === "beefy" && <> Current BEEFY set {signers.setId}, read from Portaldot.</>}
          </p>
        }
      />
    </section>
  );
}

function RichText({ parts }: { parts: Rich }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <span key={i} className="mono">
            {p.mono}
          </span>
        ),
      )}
    </>
  );
}

/* ---------- the vertical timeline ---------- */

function Timeline({ nodes, start, signers, reveal, signersError }: { nodes: TNode[]; start: string; signers: Signers | null; reveal: number; signersError: string | null }) {
  // consecutive fast-lane nodes form one branch off the main line
  const groups: (TNode | TNode[])[] = [];
  for (const n of nodes) {
    const last = groups[groups.length - 1];
    if (n.lane === "fast") Array.isArray(last) ? last.push(n) : groups.push([n]);
    else groups.push(n);
  }
  const t0 = Date.parse(start);
  return (
    <ol className={s.tl}>
      {groups.map((g) =>
        Array.isArray(g) ? (
          <li key={g[0].key} className={s.branch}>
            <p className={s.branchLabel}>Fast fill, off the proof path</p>
            <ol>
              {g.map((n) => (
                <Node key={n.key} n={n} t0={t0} />
              ))}
            </ol>
          </li>
        ) : (
          <Node key={g.key} n={g} t0={t0}>
            {g.signers && <SignerList signers={signers} reveal={reveal} error={signersError} />}
          </Node>
        ),
      )}
    </ol>
  );
}

const TONE_WORD: Record<string, string> = { done: "done", proven: "proven", active: "in progress", pending: "not yet", failed: "stopped", info: "note" };

function Node({ n, t0, children }: { n: TNode; t0: number; children?: ReactNode }) {
  const at = n.at ? Date.parse(n.at) : null;
  return (
    <li className={`${s.node} ${s[n.tone]}`}>
      <span className={s.dot} aria-hidden="true">
        {n.tone === "proven" || n.tone === "done" ? (
          <svg width="8" height="8" viewBox="0 0 8 8">
            <path d="M1.2 4.2l1.8 1.8 3.8-4" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        ) : n.tone === "failed" ? (
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M3 11L11 3" stroke="currentColor" />
          </svg>
        ) : null}
      </span>
      <div className={s.nodeBody}>
        <div className={s.nodeHead}>
          <h3>
            <RichText parts={n.title} />
            <span className="sr-only"> ({TONE_WORD[n.tone]})</span>
          </h3>
          {at !== null && (
            <span className={s.when}>
              <span className="mono">{clock(at)}</span>
              {at > t0 && <span className={s.plus}> +{duration((at - t0) / 1000)}</span>}
            </span>
          )}
        </div>
        {n.body && (
          <p className={s.nodeText}>
            <RichText parts={n.body} />
          </p>
        )}
        {n.txs.length > 0 && (
          <p className={s.txs}>
            {n.txs.map((t, i) => (
              <span key={i}>
                {t.tx && (
                  <>
                    {CHAINS[(t.chain ?? "bsc") as ChainName].name} tx <Hex chain={t.chain} kind="tx" value={t.tx} block={t.block} />
                  </>
                )}
                {t.block && t.chain && (
                  <>
                    {t.tx ? " in " : "block "}
                    <Hex chain={t.chain} kind="block" value={t.block} />
                  </>
                )}
              </span>
            ))}
          </p>
        )}
        {children}
      </div>
    </li>
  );
}

function SignerList({ signers, reveal, error }: { signers: Signers | null; reveal: number; error: string | null }) {
  if (!signers) return error ? <p className={s.signNote}>Could not read the signers: {error}</p> : null;
  if (signers.kind === "beefy") {
    return (
      <p className={s.signers}>
        {signers.authorities.map((k, i) => (
          <span key={k} className={signers.signedPast ? s.signedOn : undefined}>
            authority {i} <span className="mono">{k.slice(0, 8)}…{k.slice(-6)}</span>
          </span>
        ))}
        <span className={s.signNote}>
          current BEEFY set {signers.setId} · signed up to <Hex chain="portaldot" kind="block" value={signers.beefyHead} />
        </span>
      </p>
    );
  }
  const order = signers.order.slice(0, reveal);
  if (!order.length) return <p className={s.signNote}>No header above the deposit is sealed yet.</p>;
  return (
    <p className={s.signers}>
      {order.map((i, k) => (
        <span key={i} className={s.signedOn}>
          {ordinal(k + 1)} <Hex chain="bsc" kind="address" value={signers.validators[i]} />
        </span>
      ))}
    </p>
  );
}
