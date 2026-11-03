"use client";

import type { ReactNode } from "react";
import { fmt } from "@/lib/format";
import { BnbLane, PortaldotLane, type LaneBeat, type LaneTick } from "./Lanes";
import { Roll } from "./Roll";
import s from "./TransferRail.module.css";

export type RailDirection = "toPortaldot" | "toBnb";
export type ChipStop = "origin" | "gate" | "destination";
export type SealState = "idle" | "active" | "sealed" | "quorum" | "unused" | "forged";

export interface Sealer {
  key: string;
  /** Small label in the slot's corner: a validator index, or "authority 0". */
  index: string;
  aside?: string;
  /** The signer's short tag: four hex characters of an address, or a shortened key. */
  tag: string;
  state: SealState;
  /** How many of this signer's consecutive seals landed over the transfer. */
  meter?: { filled: number; of: number };
  status?: string;
}

export interface ProofStep {
  label: ReactNode;
  done: boolean;
}

export interface TransferRailProps {
  direction: RailDirection;
  onDirectionChange?: (d: RailDirection) => void;
  bnb: { head: number | null; ticks: LaneTick[] };
  portaldot: { head: number | null; beats: LaneBeat[] };
  /** The light client the gate stands for. */
  verifier: string;
  gateOpen: boolean;
  chip: { amount: string; asset: string; note?: string; at: ChipStop; released?: boolean; stopped?: boolean };
  sealers: Sealer[];
  sealed: number;
  threshold: number;
  caption: ReactNode;
  reverted?: boolean;
  steps: ProofStep[];
  forge?: { label: string; armed?: boolean; onForge: () => void };
  /** Polite announcement for screen readers, e.g. a forged seal's revert reason. */
  announcement?: string;
  footer?: ReactNode;
  id?: string;
}

/**
 * The transfer rail: value waits at a gate between BNB Chain and Portaldot until the other chain's
 * signers reach quorum over it, then crosses. Each chain is drawn by its own tempo.
 */
export function TransferRail(p: TransferRailProps) {
  const toPdt = p.direction === "toPortaldot";
  const [pct, self, px] = chipPlace(p.direction, p.chip.at);
  const wide = p.sealers.length <= 3;

  return (
    <section className={s.obj} id={p.id} aria-label="Transfer rail: a transfer waits at a gate until the other chain's signers reach quorum">
      <div className={s.top}>
        <div className={s.seg} role="group" aria-label="Direction">
          <button type="button" aria-pressed={toPdt} className={toPdt ? s.on : undefined} onClick={() => p.onDirectionChange?.("toPortaldot")}>
            <span className={s.long}>BNB Chain</span>
            <span className={s.short}>BNB</span> <span className={s.arr}>→</span> Portaldot
          </button>
          <button type="button" aria-pressed={!toPdt} className={!toPdt ? s.on : undefined} onClick={() => p.onDirectionChange?.("toBnb")}>
            Portaldot <span className={s.arr}>→</span> <span className={s.long}>BNB Chain</span>
            <span className={s.short}>BNB</span>
          </button>
        </div>
        {p.forge && (
          <button type="button" className={`${s.forge} ${p.forge.armed ? s.armed : ""}`} onClick={p.forge.onForge}>
            <StruckCircle size={13} />
            <span>{p.forge.label}</span>
          </button>
        )}
      </div>

      <div className={s.rail}>
        <div className={`${s.endH} ${s.endHB}`}>
          <span>BNB Chain</span>
          {p.bnb.head !== null && <Roll className="mono" value={"#" + fmt(p.bnb.head)} />}
        </div>
        <BnbLane ticks={p.bnb.ticks} />
        <div className={`${s.tempo} ${s.tempoB}`}>a header every 0.45 s</div>

        <div className={s.track}>
          <i className={s.hl} />
          <i className={`${s.dash} ${p.chip.stopped ? s.dashOn : ""} ${toPdt ? s.dashIn : s.dashOut}`} />
          <i className={`${s.acc} ${s.accL} ${p.gateOpen && !toPdt ? s.accOn : ""}`} />
          <i className={`${s.acc} ${s.accR} ${p.gateOpen && toPdt ? s.accOn : ""}`} />
          <div className={`${s.verifier} ${p.gateOpen ? s.verifierOn : ""}`}>{p.verifier}</div>
          <div className={`${s.gate} ${p.gateOpen ? s.gateOpen : ""}`} aria-hidden="true">
            <i />
          </div>
          <div className={s.chipRail} style={{ transform: `translateX(${pct}%)` }}>
            <div
              className={`${s.chip} ${p.chip.released ? s.chipRel : ""} ${p.chip.stopped ? s.chipStopped : ""}`}
              style={{ transform: `translateX(calc(${self}% + ${px}px))` }}
            >
              <span>
                {p.chip.amount} {p.chip.asset}
              </span>
              {p.chip.note && <span className={s.chipNote}>{p.chip.note}</span>}
            </div>
          </div>
        </div>

        <div className={`${s.endH} ${s.endHP}`}>
          {p.portaldot.head !== null && <Roll className="mono" value={"#" + fmt(p.portaldot.head)} />}
          <span>Portaldot</span>
        </div>
        <PortaldotLane beats={p.portaldot.beats} />
        <div className={`${s.tempo} ${s.tempoP}`}>a block every 6 s</div>
      </div>

      <div className={s.count}>
        <span className={`${s.cn} ${p.gateOpen ? s.cnMet : ""}`}>
          <Roll value={String(p.sealed)} />
          <span className={s.of}>/ {p.threshold}</span>
        </span>
        <span className={`${s.cap} ${p.reverted ? s.capRev : ""}`}>
          {p.reverted && <StruckCircle size={12} />}
          <span>{p.caption}</span>
        </span>
      </div>
      <p className="sr-only" aria-live="polite">
        {p.announcement}
      </p>

      <div className={s.slots}>
        <div key={p.direction} className={`${s.row} ${wide ? s.rowWide : ""}`}>
          {p.sealers.map((x) => (
            <div key={x.key} className={`${s.sl} ${s[x.state] ?? ""}`}>
              <div className={s.ix}>
                <span>{x.index}</span>
                {x.aside && <span>{x.aside}</span>}
              </div>
              <div className={s.tag}>{x.tag}</div>
              {x.meter ? (
                <div className={s.meter}>
                  {Array.from({ length: x.meter.of }, (_, i) => (
                    <i key={i} className={i < x.meter!.filled ? s.f : undefined} />
                  ))}
                </div>
              ) : (
                <div className={s.st}>{x.status}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      <ol className={s.steps}>
        {p.steps.map((step, i) => (
          <li key={i} className={step.done ? s.ok : undefined}>
            <span className={s.ck}>
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <path d="M1.2 4.2l1.8 1.8 3.8-4" stroke="#fff" strokeWidth="1.3" fill="none" />
              </svg>
            </span>
            <span>{step.label}</span>
            <span className="sr-only">{step.done ? " (done)" : " (pending)"}</span>
          </li>
        ))}
      </ol>

      {p.footer}
    </section>
  );
}

/**
 * Where the chip sits, as [% of the track, % of the chip's own width, px]. The gate is 20 px wide
 * at the centre and the chip waits 16 px short of it.
 */
function chipPlace(d: RailDirection, at: ChipStop): [number, number, number] {
  if (d === "toPortaldot") return at === "origin" ? [0, 0, 0] : at === "gate" ? [50, -100, -26] : [100, -100, 0];
  return at === "origin" ? [100, -100, 0] : at === "gate" ? [50, 0, 26] : [0, 0, 0];
}

export function StruckCircle({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="5.6" stroke="currentColor" strokeDasharray="2 2" />
      <path d="M2.6 10.4l7.8-7.8" stroke="currentColor" />
    </svg>
  );
}
