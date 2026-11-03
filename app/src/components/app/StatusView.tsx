"use client";

import { useEffect, useState, type ReactNode } from "react";
import { amount } from "@/lib/assets";
import { babeEpoch, beefyCommitmentSigners, beefyValidatorSet, bscMiners } from "@/lib/chain";
import { CHAINS, type ChainName } from "@/lib/config";
import { blockUrl } from "@/lib/explorer";
import { fmt } from "@/lib/format";
import { relayer, type BeefySide, type ParliaSide, type Status } from "@/lib/relayer";
import { useNow, usePoll } from "@/lib/usePoll";
import { Roll } from "../rail/Roll";
import { StruckCircle } from "../rail/TransferRail";
import { Ago, clock, duration, Empty, Hex, RelayerBanner, ViewHead } from "./ui";
import s from "./StatusView.module.css";

const TRUSTING_PERIOD = 7 * 86_400;

export function StatusView() {
  const st = usePoll((sig) => relayer.status(sig), () => 5_000, "status");
  const d = st.data;
  return (
    <>
      <ViewHead
        kicker="Proof"
        title="Each chain, as the other sees it."
        lead="A light client of Portaldot runs on BNB Chain and a light client of BNB Chain runs on Portaldot. Each panel is what one chain has proven about the other, read from the relayer and checked against the chains."
      />
      <RelayerBanner error={st.error} at={st.at} onRetry={st.refresh} />
      {st.loading ? (
        <Empty title="Reading both light clients…" />
      ) : !d ? (
        <Empty title="No status without the relayer.">Both panels come from the light-client contracts, which the relayer reads on each chain.</Empty>
      ) : (
        <>
          <div className={s.faces}>
            <BeefyPanel b={d.portaldotToBsc} />
            <div className={s.channel} aria-hidden="true">
              <span>proofs</span>
              <i />
              <span>proofs</span>
            </div>
            <ParliaPanel p={d.bscToPortaldot} />
          </div>
          <p className={s.stamp}>
            Read by the relayer at <span className="mono">{clock(d.at)}</span> · <Ago at={d.at} />, refreshed every 5 s.
          </p>
          <Health d={d} />
          <Addresses d={d} />
        </>
      )}
    </>
  );
}

/* ---------- Portaldot, as BNB Chain sees it ---------- */

function BeefyPanel({ b }: { b: BeefySide }) {
  const now = useNow(1000);
  const [epoch, setEpoch] = useState<{ index: number; endsAt: number } | null>(null);
  const [auth, setAuth] = useState<{ setId: number; authorities: string[] } | null>(null);
  const [signed, setSigned] = useState<{ tx: string; idx: number[] | null } | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const load = () => {
      babeEpoch(ctl.signal).then(setEpoch, () => {});
      beefyValidatorSet(ctl.signal).then(setAuth, () => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      ctl.abort();
      clearInterval(id);
    };
  }, []);

  const lastTx = b.lastTx;
  useEffect(() => {
    if (!lastTx || lastTx.kind !== "commitment" || signed?.tx === lastTx.tx) return;
    const ctl = new AbortController();
    beefyCommitmentSigners(lastTx.tx, ctl.signal).then((idx) => setSigned({ tx: lastTx.tx, idx }), () => setSigned({ tx: lastTx.tx, idx: null }));
    return () => ctl.abort();
  }, [lastTx, signed?.tx]);

  const n = auth?.authorities.length ?? 2;
  const idx = signed && signed.tx === lastTx?.tx ? signed.idx : null;
  const left = epoch ? (epoch.endsAt - now) / 1000 : null;

  return (
    <section className={s.panel} aria-labelledby="beefy-h">
      <PanelHead id="beefy-h" title="Portaldot, as BNB Chain sees it" sub="BEEFY light client on BNB Chain" chain="bsc" address={b.client} tempo="beats" />
      {b.error ? (
        <PanelError msg={b.error} />
      ) : (
        <>
          <Big label="Latest Portaldot block proven on BNB Chain" chain="portaldot" n={b.latestBlock} />
          <div className={s.dots} aria-label={idx ? `${idx.length} of ${n} BEEFY authorities signed the last commitment` : `${n} BEEFY authorities`}>
            {Array.from({ length: n }, (_, i) => (
              <i key={i} className={idx ? (idx.includes(i) ? s.on : undefined) : s.req} />
            ))}
            <span>
              {idx
                ? `${idx.length} of ${n} authorities signed the last commitment`
                : `${n} of ${n} authorities must sign every commitment`}
            </span>
          </div>
          {b.halted && (
            <p className={s.halt}>
              <StruckCircle size={13} />
              <span>
                <b>Halted.</b> {b.halted}
              </span>
            </p>
          )}
          <dl className={s.rows}>
            <Row k="Validator set">
              <span className="mono">{b.setId}</span>
            </Row>
            <Row k="Behind Portaldot finality">
              {b.lagBlocks != null ? (
                <>
                  <span className="mono">{fmt(b.lagBlocks)}</span> blocks, about {duration(b.lagBlocks * CHAINS.portaldot.blockSec)} · finalized{" "}
                  {b.finalized != null && <Hex chain="portaldot" kind="block" value={b.finalized} />}
                </>
              ) : (
                "unknown"
              )}
            </Row>
            <Row k="BEEFY has signed up to">{b.beefyHead != null ? <Hex chain="portaldot" kind="block" value={b.beefyHead} /> : "unknown"}</Row>
            <Row k="Last light-client transaction">
              {lastTx ? (
                <>
                  {lastTx.kind === "commitment" ? "commitment" : lastTx.kind === "header" ? "header import" : "set rotation"} ·{" "}
                  <Hex chain="bsc" kind="tx" value={lastTx.tx} />
                </>
              ) : (
                "none yet"
              )}
            </Row>
            <Row k="Next set handoff">
              {left != null && epoch ? (
                left > 0 ? (
                  <>
                    in {duration(left)}, at <span className="mono">{clock(epoch.endsAt)}</span> (BABE epoch <span className="mono">{fmt(epoch.index)}</span> ends)
                  </>
                ) : (
                  <>due now (BABE epoch {fmt(epoch.index)} has ended)</>
                )
              ) : (
                "reading Portaldot"
              )}
            </Row>
            <Row k="Commitments archived">{b.archived != null ? <span className="mono">{fmt(b.archived)}</span> : "unknown"}</Row>
            {b.lastError && <Row k="Last error">{b.lastError}</Row>}
          </dl>
        </>
      )}
    </section>
  );
}

/* ---------- BNB Chain, as Portaldot sees it ---------- */

function ParliaPanel({ p }: { p: ParliaSide }) {
  const now = useNow(1000);
  const [window, setWindow] = useState<{ block: string; sealed: number[]; untrusted: number } | null>(null);
  const lw = p.lastWindow;
  const validators = p.validators ?? [];

  useEffect(() => {
    if (!lw || !validators.length || window?.block === lw.block) return;
    const ctl = new AbortController();
    const from = Number(lw.block);
    bscMiners(from, from + lw.headers - 1, ctl.signal).then(
      (miners) => {
        const set = validators.map((v) => v.toLowerCase());
        const sealed = [...new Set(miners.map((m) => set.indexOf(m.miner)).filter((i) => i >= 0))];
        setWindow({ block: lw.block, sealed, untrusted: miners.filter((m) => !set.includes(m.miner)).length });
      },
      () => {},
    );
    return () => ctl.abort();
  }, [lw, validators, window?.block]);

  const sealed = window && lw && window.block === lw.block ? window.sealed : null;
  const remaining = p.epochTimestamp ? Number(p.epochTimestamp) + TRUSTING_PERIOD - now / 1000 : p.trustRemainingSec ? Number(p.trustRemainingSec) : null;
  const expires = p.epochTimestamp ? (Number(p.epochTimestamp) + TRUSTING_PERIOD) * 1000 : null;
  const lag = p.lagBlocks != null ? Number(p.lagBlocks) : null;

  return (
    <section className={s.panel} aria-labelledby="parlia-h">
      <PanelHead id="parlia-h" title="BNB Chain, as Portaldot sees it" sub="Parlia light client on Portaldot" chain="portaldot" address={p.client} tempo="ticks" />
      {p.error ? (
        <PanelError msg={p.error} />
      ) : (
        <>
          <Big label={lw ? "Latest BNB Chain block finalized on Portaldot" : "No window submitted yet"} chain="bsc" n={lw ? Number(lw.block) : undefined} />
          <div className={s.dots} aria-label={sealed ? `${sealed.length} of ${validators.length} trusted validators sealed the last window` : `${validators.length} trusted validators`}>
            {validators.map((v, i) => (
              <i key={v} className={sealed ? (sealed.includes(i) ? s.on : undefined) : undefined} title={v} />
            ))}
            <span>
              {sealed && lw
                ? `${sealed.length} of ${validators.length} trusted validators sealed the last window of ${lw.headers} headers`
                : lw
                  ? `reading the ${lw.headers} headers of the last window from BNB Chain`
                  : `${validators.length} validators in the trusted set`}
            </span>
          </div>
          <dl className={s.rows}>
            <Row k="Trusted epoch">
              {p.trustedEpoch ? (
                <>
                  <Hex chain="bsc" kind="block" value={p.trustedEpoch} />
                  {p.activeFrom && (
                    <>
                      , in force from <Hex chain="bsc" kind="block" value={p.activeFrom} />
                    </>
                  )}
                </>
              ) : (
                "unknown"
              )}
            </Row>
            <Row k="Behind BNB Chain head">
              {lag != null ? (
                <>
                  <span className="mono">{fmt(lag)}</span> blocks, about {duration(lag * CHAINS.bsc.blockSec)} · head{" "}
                  {p.bscHead && <Hex chain="bsc" kind="block" value={p.bscHead} />}
                </>
              ) : (
                "no window yet"
              )}
            </Row>
            <Row k="BNB Chain's live set it trusts">
              {p.liveOverlap != null ? (
                <>
                  <span className="mono">{p.liveOverlap}</span> of {validators.length || 9} validators · a new epoch is submitted below 7
                </>
              ) : (
                "unknown"
              )}
            </Row>
            <Row k="Trusting period">
              {remaining != null ? (
                <span className={s.trust}>
                  <span>
                    {remaining > 0 ? `${duration(remaining)} left` : "expired"}
                    {expires && (
                      <>
                        , until <span className="mono">{new Date(expires).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                      </>
                    )}
                  </span>
                  <i aria-hidden="true">
                    <b style={{ width: `${Math.max(0, Math.min(1, remaining / TRUSTING_PERIOD)) * 100}%` }} />
                  </i>
                </span>
              ) : (
                "unknown"
              )}
            </Row>
            <Row k="Last window transaction">
              {lw ? (
                <>
                  <span className="mono">{lw.headers}</span> headers · <Hex chain="portaldot" kind="tx" value={lw.tx} />
                </>
              ) : (
                "none yet"
              )}
            </Row>
            {window?.untrusted ? <Row k="Seals not counted">{window.untrusted} headers in the last window came from validators outside the trusted set</Row> : null}
            {p.lastError && <Row k="Last error">{p.lastError}</Row>}
          </dl>
        </>
      )}
    </section>
  );
}

/* ---------- parts ---------- */

function PanelHead({ id, title, sub, chain, address, tempo }: { id: string; title: string; sub: string; chain: ChainName; address: string; tempo: "ticks" | "beats" }) {
  return (
    <header className={s.ph}>
      <span className={s.tempo} aria-hidden="true">
        {tempo === "ticks" ? Array.from({ length: 12 }, (_, i) => <i key={i} className={s.tick} />) : Array.from({ length: 3 }, (_, i) => <i key={i} className={s.beat} />)}
      </span>
      <h2 id={id}>{title}</h2>
      <p>
        {sub} · <Hex chain={chain} kind="address" value={address} />
      </p>
    </header>
  );
}

function Big({ label, chain, n }: { label: string; chain: ChainName; n?: number }) {
  return (
    <div className={s.big}>
      {n != null ? (
        <a className={s.height} href={blockUrl(chain, n)} target="_blank" rel="noreferrer" aria-label={`${label}: ${fmt(n)}, on the explorer`}>
          <Roll className="mono" value={"#" + fmt(n)} />
        </a>
      ) : (
        <span className={`${s.height} ${s.none}`}>—</span>
      )}
      <span className={s.bigLabel}>{label}</span>
    </div>
  );
}

function PanelError({ msg }: { msg: string }) {
  return (
    <p className={s.halt}>
      <StruckCircle size={13} />
      <span>
        <b>Could not read the client.</b> {msg}
      </span>
    </p>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/* ---------- relayer health ---------- */

function Health({ d }: { d: Status }) {
  const t = d.jobs.transfers;
  const o = d.jobs.orders;
  const list = (r: Record<string, number>) =>
    Object.entries(r).length ? (
      Object.entries(r)
        .map(([k, v]) => `${v} ${k}`)
        .join(" · ")
    ) : (
      <span className={s.dim}>none</span>
    );
  return (
    <section className={s.health} aria-labelledby="relayer-h">
      <h2 id="relayer-h" className={s.h2}>
        Relayer
      </h2>
      <p className={s.note}>Anyone can run one. It carries proofs across and pays the gas; the light clients decide what is true.</p>
      <dl className={s.grid}>
        <Row k="Address">
          <Hex chain="bsc" kind="address" value={d.relayer.address} /> <span className={s.dim}>on both chains</span>
        </Row>
        <Row k="Gas balances">
          <span className="mono">{d.relayer.balances.portaldot}</span> tPOT · <span className="mono">{d.relayer.balances.bsc}</span> tBNB
        </Row>
        <Row k="Transfers">{list(t)}</Row>
        <Row k="Orders">{list(o)}</Row>
        <Row k="Solver">
          {d.solver ? (
            <>
              on · <Hex chain="bsc" kind="address" value={d.solver.address} /> · fills at {d.solver.limits.minFeeBps} bps or more, {d.solver.limits.minDeadlineLeft} s of
              deadline left
            </>
          ) : (
            <span className={s.dim}>off on this relayer</span>
          )}
        </Row>
        <Row k="Demo wallet">
          {d.demo ? (
            <>
              on · <Hex chain="bsc" kind="address" value={d.demo.address} /> · used today{" "}
              {Object.entries(d.demo.usedToday).length
                ? Object.entries(d.demo.usedToday)
                    .map(([k, v]) => `${amount(v ?? "0")} ${k}`)
                    .join(", ")
                : "nothing"}
            </>
          ) : (
            <span className={s.dim}>off on this relayer</span>
          )}
        </Row>
      </dl>
    </section>
  );
}

function Addresses({ d }: { d: Status }) {
  const side = (chain: ChainName) =>
    Object.entries(d.addresses[chain] ?? {}).filter(([k, v]) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && k !== "bnbbAssetId") as [string, string][];
  return (
    <section className={s.addrs} aria-labelledby="addr-h">
      <h2 id="addr-h" className={s.h2}>
        Contracts
      </h2>
      <div className={s.addrCols}>
        {(["portaldot", "bsc"] as const).map((c) => (
          <div key={c}>
            <h3>{CHAINS[c].full}</h3>
            {side(c).length ? (
              <dl>
                {side(c).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k === "bnbb" ? "BNB.b (assets precompile)" : k}</dt>
                    <dd>
                      <Hex chain={c} kind="address" value={v} />
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={s.dim}>Not deployed yet.</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
