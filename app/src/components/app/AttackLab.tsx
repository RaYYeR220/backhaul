"use client";

import { useCallback, useRef, useState } from "react";
import { CHAINS, RPCS, type ChainName } from "@/lib/config";
import { RelayerError, relayer, type AttackInfo, type AttackResult } from "@/lib/relayer";
import { usePoll } from "@/lib/usePoll";
import { Roll } from "../rail/Roll";
import { StruckCircle } from "../rail/TransferRail";
import { Empty, Hex, RelayerBanner, ViewHead } from "./ui";
import s from "./AttackLab.module.css";

/** Each attack as the thing an attacker does. */
const VERBS: Record<string, string> = {
  "beefy-forged-signature": "Forge a BEEFY signature",
  "beefy-stale-set": "Sign with a retired validator set",
  "mmr-wrong-leaf": "Bend an MMR proof",
  "header-not-in-mmr": "Swap a header's state root",
  "tampered-storage-proof": "Change a proven storage value",
  "replayed-nonce": "Replay a delivered transfer",
  "parlia-forged-header": "Seal a header with a non-validator",
  "parlia-too-few-sealers": "Finalize with too few sealers",
  "receipt-not-included": "Prove a log that is not there",
  "settle-unfilled-order": "Claim an order nobody filled",
  "refund-filled-order": "Refund an order that was filled",
  "bnbb-beyond-locked": "Release BNB.b nobody locked",
};

/** What a not-ready attack is waiting for, in words. */
const MATERIAL: Record<string, string> = {
  beefy: "a BEEFY commitment of the current set",
  staleBeefy: "a commitment from an older BEEFY set",
  headerImport: "a header the BEEFY client can prove",
  portaldotCommitment: "a finalized transfer to BNB Chain",
  presentAbsence: "a finalized transfer to BNB Chain",
  transferToBsc: "a finalized transfer to BNB Chain",
  parliaWindow: "a fresh BNB Chain finality window",
  bscReceipt: "a BNB Chain block the Parlia client has finalized",
  openOrder: "an open order nobody has filled",
  "bsc client": "a BNB Chain RPC connection",
  "portaldot client": "a Portaldot RPC connection",
};

/** The throwaway key the lab sends its calls from (keccak256("backhaul attack lab")). */
const ATTACKER = "0x9bB40db9756BB471b4cdcF21b1599F37f8984A9e";

type Run = { st: "firing" } | { st: "done"; r: AttackResult } | { st: "missing"; missing: string[] } | { st: "error"; msg: string };

const needs = (missing: string[]) => {
  const words = [
    ...new Set(missing.map((m) => MATERIAL[m] ?? (m.startsWith("originSettler") ? "a deployed OriginSettler" : `the deployed ${m}`))),
  ];
  return words.join(" and ");
};

export function AttackLab() {
  const list = usePoll(
    (sig) => relayer.attacks(sig),
    () => 60_000,
    "attacks",
  );
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [volley, setVolley] = useState<{ at: number; of: number } | null>(null);
  const [said, setSaid] = useState("");
  const stop = useRef(false);

  const fire = useCallback(async (a: AttackInfo) => {
    setRuns((r) => ({ ...r, [a.id]: { st: "firing" } }));
    let run: Run;
    try {
      run = { st: "done", r: await relayer.fire(a.id) };
    } catch (e) {
      if (e instanceof RelayerError && e.status === 409) run = { st: "missing", missing: (e.body.missing as string[]) ?? [] };
      else run = { st: "error", msg: e instanceof Error ? e.message : String(e) };
    }
    setRuns((r) => ({ ...r, [a.id]: run }));
    const verb = VERBS[a.id] ?? a.title;
    setSaid(
      run.st === "done"
        ? run.r.defended
          ? `${verb}: rejected, ${run.r.reverted ? "reverted with" : "returned"} ${run.r.reason}.`
          : `${verb}: not rejected as expected, ${run.r.reason}.`
        : run.st === "missing"
          ? `${verb}: not ready.`
          : `${verb}: could not run.`,
    );
    return run;
  }, []);

  const items = list.data?.items ?? [];
  const ready = items.filter((a) => a.ready);

  const fireAll = async () => {
    stop.current = false;
    setVolley({ at: 0, of: ready.length });
    for (let i = 0; i < ready.length; i++) {
      if (stop.current) break;
      setVolley({ at: i + 1, of: ready.length });
      await fire(ready[i]);
    }
    setVolley(null);
  };

  const rejected = items.filter((a) => {
    const r = runs[a.id];
    return r?.st === "done" && r.r.defended;
  }).length;
  const fired = Object.values(runs).filter((r) => r.st === "done").length;
  const breached = items.filter((a) => {
    const r = runs[a.id];
    return r?.st === "done" && !r.r.defended;
  }).length;
  const total = list.data?.total ?? 0;

  const groups: { chain: ChainName; title: string; sub: string }[] = [
    {
      chain: "bsc",
      title: "Fired at BNB Chain",
      sub: "The BEEFY light client of Portaldot, its storage verifier and the BNB Chain gateway.",
    },
    {
      chain: "portaldot",
      title: "Fired at Portaldot",
      sub: "The Parlia light client of BNB Chain, its receipt verifier, the gateway and the order settler.",
    },
  ];

  let n = 0;
  return (
    <>
      <ViewHead
        kicker="Attack lab"
        title="Break a proof."
        lead="Each attack starts from real proof material the contracts accepted, changes exactly one thing, and is sent to the live contract as an eth_call. Nothing is signed or spent. The contract has to refuse it."
      />

      <RelayerBanner error={list.error} at={list.at} onRetry={list.refresh} />

      {list.data && (
        <section className={s.board} aria-label="Scoreboard">
          <div className={s.scoreCol}>
            <div className={`${s.score} ${rejected === total && total > 0 ? s.all : ""}`}>
              <span className={s.big}>
                <Roll value={String(rejected)} />
                <span className={s.of}>/ {total}</span>
              </span>
              <span className={s.word}>rejected</span>
            </div>
            <span className={s.pips} aria-hidden="true">
              {items.map((a) => {
                const r = runs[a.id];
                const st = !r
                  ? ""
                  : r.st === "firing"
                    ? s.pipFiring
                    : r.st === "done"
                      ? r.r.defended
                        ? s.pipRejected
                        : s.pipBreached
                      : "";
                return <i key={a.id} className={`${st} ${a.ready ? "" : s.pipWait}`} />;
              })}
            </span>
          </div>
          <div className={s.boardSide}>
            <p className={s.boardNote}>
              {fired === 0
                ? `${ready.length} of ${total} have their proof material. Fire one, or all of them.`
                : `${fired} fired${breached ? `, ${breached} not rejected as expected` : ""}. ${ready.length} of ${total} are ready.`}
            </p>
            <div className={s.boardActions}>
              {volley ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => (stop.current = true)}>
                  Stop · firing {volley.at} of {volley.of}
                </button>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={fireAll} disabled={!ready.length}>
                  Fire all {ready.length === total ? total : `${ready.length} ready`}
                </button>
              )}
            </div>
          </div>
        </section>
      )}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>

      {list.loading && <Empty title="Loading the attack lab…" />}
      {!list.loading && !list.data && (
        <Empty title="The attack lab needs the relayer.">
          It builds every forgery from real commitments, headers and receipts it has relayed, then calls the live contract.
        </Empty>
      )}

      {groups.map((g) => {
        const rows = items.filter((a) => a.chain === g.chain);
        if (!rows.length) return null;
        return (
          <section key={g.chain} className={s.group} aria-labelledby={`g-${g.chain}`}>
            <div className={s.groupHead}>
              <Tempo chain={g.chain} />
              <div>
                <h2 id={`g-${g.chain}`}>{g.title}</h2>
                <p>{g.sub}</p>
              </div>
            </div>
            <ol className={s.rows}>
              {rows.map((a) => {
                n += 1;
                return <AttackRow key={a.id} n={n} a={a} run={runs[a.id]} onFire={() => fire(a)} busy={!!volley} />;
              })}
            </ol>
          </section>
        );
      })}
    </>
  );
}

function AttackRow({ n, a, run, onFire, busy }: { n: number; a: AttackInfo; run?: Run; onFire: () => void; busy: boolean }) {
  const verb = VERBS[a.id] ?? a.title;
  const [contract, fn] = a.target.split(".");
  const done = run?.st === "done" ? run.r : null;
  const state = !run ? "idle" : run.st === "firing" ? "firing" : done ? (done.defended ? "rejected" : "breached") : "other";
  return (
    <li className={`${s.row} ${s[state] ?? ""}`}>
      <span className={s.n}>{String(n).padStart(2, "0")}</span>
      <span className={s.glyph} aria-hidden="true">
        {state === "rejected" ? <StruckCircle size={15} /> : <i />}
      </span>
      <div className={s.body}>
        <h3>{verb}</h3>
        <p className={s.desc}>{a.description ?? a.title}</p>
        <p className={s.target}>
          <span>
            Target{" "}
            {a.address ? (
              <Hex chain={a.chain} kind="address" value={a.address} label={`${contract}.${fn}`} />
            ) : (
              <span className="mono">
                {contract}.{fn}
              </span>
            )}{" "}
            on {CHAINS[a.chain].name}
          </span>
          <span>
            must refuse with{" "}
            {a.expects.map((e, i) => (
              <span key={e}>
                {i > 0 && " or "}
                <span className="mono">{e === "false" ? "false" : e}</span>
              </span>
            ))}
          </span>
        </p>
        <Outcome a={a} run={run} />
      </div>
      <div className={s.act}>
        <button
          type="button"
          className={`btn btn-sm ${state === "idle" ? "btn-primary" : "btn-ghost"} ${s.fire}`}
          // stays enabled while firing so keyboard focus is not dropped; a second press is ignored
          onClick={() => run?.st !== "firing" && onFire()}
          disabled={!a.ready || busy}
          aria-busy={run?.st === "firing"}
          aria-label={`Fire: ${verb}`}
        >
          {!a.ready ? "Not ready" : run?.st === "firing" ? "Firing…" : run ? "Fire again" : "Fire"}
        </button>
      </div>
    </li>
  );
}

function Outcome({ a, run }: { a: AttackInfo; run?: Run }) {
  if (!a.ready && !run) {
    return <p className={s.wait}>Waits for {needs(a.missing ?? [])}.</p>;
  }
  if (!run) return null;
  if (run.st === "firing") {
    return (
      <p className={s.firing}>
        <i aria-hidden="true" />
        Calling <span className="mono">{a.target}</span>
      </p>
    );
  }
  if (run.st === "missing") return <p className={s.wait}>Not ready: waits for {needs(run.missing)}.</p>;
  if (run.st === "error") return <p className={s.wait}>Could not run: {run.msg}</p>;
  const r = run.r;
  const name = r.reason.split("(")[0];
  const rpc = r.chain === "bsc" ? RPCS.bsc : RPCS.portaldotEvm;
  return (
    <div className={s.result}>
      <p className={s.verdict}>
        {r.defended ? (
          <span className={s.rev}>{r.reverted ? "Reverted" : "Refused"}</span>
        ) : (
          <span className={s.breach}>{r.reverted ? "Reverted, but not as expected" : "Not refused"}</span>
        )}
        <span className={`mono ${s.reason}`}>{r.reverted ? r.reason : `returned ${r.reason}`}</span>
        <span className={s.meta}>
          {r.defended ? `the expected ${name === "false" ? "refusal" : name}` : `expected ${a.expects.join(" or ")}`} · {r.ms} ms · eth_call
          to <Hex chain={r.chain} kind="address" value={r.call.to} />
        </span>
      </p>
      <details className={s.call}>
        <summary>Run it yourself</summary>
        <pre className="mono">{`cast call ${r.call.to} \\\n  ${r.call.data} \\\n  --from ${ATTACKER} \\\n  --rpc-url ${rpc}`}</pre>
      </details>
    </div>
  );
}

function Tempo({ chain }: { chain: ChainName }) {
  return (
    <span className={s.tempo} aria-hidden="true">
      {chain === "bsc"
        ? Array.from({ length: 12 }, (_, i) => <i key={i} className={s.tick} />)
        : Array.from({ length: 3 }, (_, i) => <i key={i} className={s.beat} />)}
    </span>
  );
}
