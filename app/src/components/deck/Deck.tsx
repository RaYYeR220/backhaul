import type { ReactNode } from "react";
import { Mark } from "@/components/Chrome";
import { facts, kb, kGas, type DeckFacts, type DeployedContract } from "@/lib/deck/facts";
import { addressUrl, shortHex, txUrl } from "@/lib/explorer";
import { fmt } from "@/lib/format";
import { REPO } from "@/lib/links";
import { DeckControls } from "./DeckControls";
import { DeckRail } from "./DeckRail";
import { scaleScript } from "./scale";
import s from "./Deck.module.css";

const SITE = "https://backhaul-bridge.vercel.app";
const host = (u: string) => u.replace(/^https?:\/\//, "");
const pad = (n: number) => String(n).padStart(2, "0");
const tag4 = (a: string) => a.slice(2, 6).toLowerCase();

interface SlideDef {
  kicker: string;
  tempo?: "ticks" | "beats";
  tone?: "title" | "close";
  body: ReactNode;
}

export function Deck() {
  const list = slides(facts);
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: scaleScript }} />
      <DeckControls total={list.length} />
      <main id="main" className={s.deck} data-deck>
        {list.map((d, i) => (
          <Slide key={d.kicker} n={i + 1} total={list.length} def={d} />
        ))}
      </main>
    </>
  );
}

function Slide({ n, total, def }: { n: number; total: number; def: SlideDef }) {
  return (
    <section className={s.frame} aria-label={`Slide ${n} of ${total}: ${def.kicker}`}>
      <div className={`${s.slide} ${def.tone === "title" ? s.toneTitle : def.tone === "close" ? s.toneClose : ""}`} data-slide>
        <div className={s.top}>
          <span className={s.kicker}>
            {def.tempo && <Tempo kind={def.tempo} />}
            {def.kicker}
          </span>
          <span className={`${s.num} mono`}>
            {pad(n)} / {pad(total)}
          </span>
        </div>
        <div className={s.body} data-fit>
          {def.body}
        </div>
        <div className={s.foot}>
          <span className={s.footBrand}>
            <Mark />
            Backhaul
          </span>
          <span className="mono">{host(SITE)}</span>
        </div>
      </div>
    </section>
  );
}

function Tempo({ kind }: { kind: "ticks" | "beats" }) {
  return (
    <span className={s.tempo} aria-hidden="true">
      {kind === "ticks"
        ? Array.from({ length: 14 }, (_, i) => <i key={i} className={s.tick} />)
        : Array.from({ length: 3 }, (_, i) => <i key={i} className={s.beat} />)}
    </span>
  );
}

/* ---------- slides ---------- */

function slides(f: DeckFacts): SlideDef[] {
  return [
    { kicker: "Portaldot Hacker House 2026 · Multi-Chain & Cross-Chain Infra", tone: "title", body: <TitleSlide /> },
    { kicker: "Problem addressed", body: <ProblemSlide /> },
    { kicker: "What Backhaul does", body: <WhatSlide /> },
    { kicker: "How it crosses · BNB Chain → Portaldot", tempo: "ticks", body: <InSlide f={f} /> },
    { kicker: "How it crosses · Portaldot → BNB Chain", tempo: "beats", body: <OutSlide f={f} /> },
    { kicker: "Why Portaldot is essential", body: <PortaldotSlide f={f} /> },
    { kicker: "Liquidity engine", body: <LiquiditySlide /> },
    { kicker: "Proof of product functionality", body: <ProofSlide f={f} /> },
    { kicker: "Business potential", body: <BusinessSlide f={f} /> },
    { kicker: "Reasons for continued future support", body: <SupportSlide /> },
    { kicker: "Try it", tone: "close", body: <CloseSlide /> },
  ];
}

function TitleSlide() {
  return (
    <div className={s.titleWrap}>
      <div className={s.titleText}>
        <h1 className={s.h1}>Proven both ways across.</h1>
        <p className={s.thesis}>Every Portaldot bridge so far trusts someone on the way back. Backhaul trusts no one, in either direction.</p>
        <p className={s.proofline}>
          <i className={s.dot} aria-hidden="true" />
          Portaldot V3 testnet ↔ BNB Chain testnet · 0 trusted parties, either way
        </p>
        <a className={`${s.url} mono`} href={SITE}>
          {host(SITE)}
        </a>
      </div>
      <Horizon />
    </div>
  );
}

/** The rail reduced to its idea: BNB Chain's fine ticks, Portaldot's wide beats, an open gate. */
function Horizon() {
  return (
    <div className={s.horizon} aria-hidden="true">
      <div className={s.hzRow}>
        <div className={s.hzTicks}>
          {Array.from({ length: 72 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
        <div className={s.hzMid}>
          <i className={s.hzLine} />
          <i className={s.hzAcc} />
          <div className={s.hzGate} />
          <span className={`${s.hzChip} mono`}>0.25 BNB.b · released</span>
        </div>
        <div className={s.hzBeats}>
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      </div>
      <div className={s.hzLabels}>
        <span>BNB Chain · a header every 0.45 s</span>
        <span>6 of 9 seals in · 2 of 2 signatures back</span>
        <span>Portaldot · a block every 6 s</span>
      </div>
    </div>
  );
}

const LOSSES = [
  { name: "Ronin", of: 9, took: 5, keys: "5 of 9 validator keys", amount: "$625M" },
  { name: "Harmony Horizon", of: 5, took: 2, keys: "2 of 5 multisig keys", amount: "~$100M" },
  { name: "Orbit Chain", of: 10, took: 7, keys: "7 of 10 multisig keys", amount: "$81.5M" },
];

function ProblemSlide() {
  return (
    <div className={s.split}>
      <h2 className={`${s.h2} ${s.h2Problem}`}>A bridge is only as safe as the few keys that can sign for it.</h2>
      <div>
        <p className={s.big}>$806M</p>
        <p className={s.bigCap}>taken from three bridges that a handful of keys could sign for</p>
      </div>
      <dl className={s.rows}>
        <div>
          <dt>Portaldot ↔ BNB Chain today</dt>
          <dd>Custodial. You send to an address, and a service pays you out on the other side.</dd>
        </div>
        <div>
          <dt>A committee on the way back</dt>
          <dd>The same risk as a multisig: whoever holds a few keys can sign for everything locked.</dd>
        </div>
      </dl>
      <div>
        <ul className={s.losses}>
          {LOSSES.map((l) => (
            <li key={l.name}>
              <b>{l.name}</b>
              <span className={s.keys} aria-hidden="true">
                {Array.from({ length: l.of }, (_, i) => (
                  <i key={i} className={i < l.took ? s.keyTaken : undefined} />
                ))}
              </span>
              <span className={s.keysTxt}>{l.keys}</span>
              <span className={`${s.amount} mono`}>{l.amount}</span>
            </li>
          ))}
        </ul>
        <p className={s.srcs}>Sources: Ronin post-mortem (Mar 2022) · Elliptic (Jun 2022) · Blockworks (Jan 2024)</p>
      </div>
    </div>
  );
}

function WhatSlide() {
  return (
    <div className={s.what}>
      <div className={s.whatHead}>
        <h2 className={`${s.h2} ${s.h2Tight}`}>Each chain runs a light client of the other. Nothing crosses without a proof.</h2>
        <div className={s.zero}>
          <span className={s.zeroN}>0</span>
          <span className={s.zeroCap}>trusted parties, either way</span>
        </div>
      </div>
      <DeckRail />
    </div>
  );
}

function Slots({ items, wide }: { items: { index: string; aside?: string; tag: string; on: boolean; status: string }[]; wide?: boolean }) {
  return (
    <div className={`${s.slots} ${wide ? s.slotsWide : ""}`} aria-hidden="true">
      {items.map((x) => (
        <div key={x.index} className={`${s.slot} ${x.on ? s.slotOn : s.slotOff}`}>
          <div className={s.slotIx}>
            <span>{x.index}</span>
            {x.aside && <span>{x.aside}</span>}
          </div>
          <div className={`${s.slotTag} mono`}>{x.tag}</div>
          <div className={s.slotSt}>{x.status}</div>
        </div>
      ))}
    </div>
  );
}

function Quorum({ met, of, cap }: { met: number; of: number; cap: ReactNode }) {
  return (
    <div className={s.quorum}>
      <p className={s.qN}>
        <span className={s.qMet}>{met}</span>
        <span className={s.qOf}>/ {of}</span>
      </p>
      <p className={s.qCap}>{cap}</p>
    </div>
  );
}

function Steps({ items }: { items: { verb: string; what: string; body: string; code: string }[] }) {
  return (
    <ol className={s.steps}>
      {items.map((st, i) => (
        <li key={st.verb}>
          <span className={`${s.stepN} mono`}>{i + 1}</span>
          <h3>
            {st.verb} <span>{st.what}</span>
          </h3>
          <p>{st.body}</p>
          <code className="mono">{st.code}</code>
        </li>
      ))}
    </ol>
  );
}

function InSlide({ f }: { f: DeckFacts }) {
  const vals = f.parlia?.validators.length ? f.parlia.validators : [];
  const n = vals.length || 9;
  const need = Math.ceil((2 * n) / 3);
  const headers = f.parlia?.headers;
  return (
    <div className={s.mech}>
      <h2 className={s.h2}>Six of nine BNB Chain validators seal it. Portaldot checks every seal itself.</h2>
      <div className={s.qRow}>
        <Quorum
          met={need}
          of={n}
          cap={
            <>
              distinct validators seal the headers above your lock
              {headers ? (
                <span className={`${s.qSub} mono`}>
                  ≈ {headers} headers · ≈ {Math.round(headers * 0.45)} s
                </span>
              ) : null}
            </>
          }
        />
        <Slots
          items={Array.from({ length: n }, (_, i) => ({
            index: String(i),
            tag: vals[i] ? tag4(vals[i]) : "····",
            on: i < need,
            status: i < need ? "sealed" : "not needed",
          }))}
        />
      </div>
      <Steps
        items={[
          { verb: "Lock", what: "on BNB Chain", body: "You lock tBNB in the bridge contract on BNB Chain.", code: "BscGateway.lockBNB" },
          {
            verb: "Seal",
            what: `${need} of ${n} validators`,
            body: "A Parlia light client on Portaldot's EVM checks each seal against the BNB Chain validator set it has proven.",
            code: "ParliaClient.submitWindow",
          },
          {
            verb: "Prove",
            what: "receipt proof",
            body: "A Merkle-Patricia proof shows your lock's receipt under the finalized header's receipts root.",
            code: "BscVerifier · Locked log",
          },
          {
            verb: "Release",
            what: "on Portaldot",
            body: "BNB.b arrives as a native pallet-assets asset, with a little tPOT so a fresh wallet can move it.",
            code: "BNB.b · pallet-assets",
          },
        ]}
      />
    </div>
  );
}

function OutSlide({ f }: { f: DeckFacts }) {
  const b = f.beefy;
  const signers = b?.signers.length ? b.signers : ["0x····", "0x····"];
  const set = b?.fromSet ?? null;
  return (
    <div className={s.mech}>
      <h2 className={s.h2}>Portaldot&apos;s own BEEFY finality, checked signature by signature on BNB Chain.</h2>
      <div className={`${s.qRow} ${s.qRowOut}`}>
        <Quorum met={signers.length} of={signers.length} cap={
            <>
              BEEFY authorities sign every commitment
              {set !== null && <span className={`${s.qSub} mono`}>set {set}</span>}
            </>
          } />
        <Slots
          wide
          items={signers.map((a, i) => ({
            index: `authority ${i}`,
            aside: set !== null ? `set ${set}` : undefined,
            tag: shortHex(a, 6, 4),
            on: true,
            status: "signed",
          }))}
        />
        {b && (
          <ol className={s.path} aria-label="Proof path from a signed commitment to a storage slot">
            <li>
              <span>signed MMR root</span>
              <code className="mono">{shortHex(b.mmrRoot ?? "", 6, 4)}</code>
            </li>
            <li>
              <span>header, BLAKE2b</span>
              <code className="mono">#{fmt(b.header ?? 0)}</code>
            </li>
            <li>
              <span>revive child trie</span>
              <code className="mono">{shortHex(b.trieId ?? "", 6, 4)}</code>
            </li>
          </ol>
        )}
      </div>
      <Steps
        items={[
          {
            verb: "Lock",
            what: "on Portaldot",
            body: "You lock tPOT or BNB.b, and the outbox writes a commitment to it in revive storage.",
            code: "PortaldotGateway · Outbox",
          },
          {
            verb: "Sign",
            what: `${signers.length} of ${signers.length} BEEFY authorities`,
            body: "Both authorities sign the MMR root. A light client on BNB Chain recovers each secp256k1 signature.",
            code: "PortaldotLightClient",
          },
          {
            verb: "Prove",
            what: "MMR + storage proof",
            body: "An MMR proof ties your block to the signed root. A BLAKE2b child-trie proof reads the commitment.",
            code: b?.storageProofBytes ? `PortaldotVerifier · ${(b.storageProofBytes / 1000).toFixed(1)} KB proof` : "PortaldotVerifier",
          },
          { verb: "Release", what: "on BNB Chain", body: "pPOT is minted or tBNB released to you, once per nonce.", code: "BscGateway.finalize" },
        ]}
      />
    </div>
  );
}

function PortaldotSlide({ f }: { f: DeckFacts }) {
  const w = f.wasm;
  const cols = [
    {
      tag: "pallet-beefy · pallet-mmr",
      title: "Bridge-grade finality, built in",
      body: "Portaldot signs an MMR root of its blocks with secp256k1 keys any EVM chain can check. Backhaul is the first bridge to verify it.",
      foot: f.gas?.beefyCommitment ? `${kGas(f.gas.beefyCommitment)} gas per signed commitment` : "BEEFY light client on BNB Chain",
    },
    {
      tag: "pallet-revive",
      title: "Unmodified Solidity next to the pallets",
      body: "The Parlia light client and the gateways are ordinary Solidity on Portaldot's EVM, and their storage is provable from the state root.",
      foot: "ParliaClient · BscVerifier · gateways",
    },
    {
      tag: "pallet-assets · ERC-20 precompile · AssetConversion",
      title: "A native asset, not a wrapped token",
      body: "BNB.b lives in pallet-assets. SubWallet shows it, MetaMask sees it through the precompile, and it can trade in the runtime's own pools.",
      foot: "fixed supply, every role held by the bridge",
    },
    {
      tag: "pallet-contracts · ink!",
      title: "The same light client on the second VM",
      body: "An ink! twin of the Parlia client gives WASM contracts proven BNB Chain state, measured side by side with the EVM build.",
      foot:
        w?.wasmBytes && w.window48RefTimeMs
          ? `${kb(w.wasmBytes)} WASM · ${w.window48Headers}-header window in ${w.window48RefTimeMs} ms`
          : "ink! 5 · pallet-contracts",
    },
  ];
  return (
    <div className={s.prim}>
      <h2 className={s.h2}>Every part of Backhaul is a Portaldot V3 primitive.</h2>
      <div className={s.runtime}>
        <p className={s.runtimeName}>Portaldot V3 runtime</p>
        <div className={s.primCols}>
          {cols.map((c) => (
            <div key={c.tag}>
              <code className="mono">{c.tag}</code>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              <span className={`${s.primFoot} mono`}>{c.foot}</span>
            </div>
          ))}
        </div>
      </div>
      <p className={s.note}>Modular runtime, two VMs, native assets and its own bridge finality: Portaldot V3 ships all of it today.</p>
    </div>
  );
}

const ORDER = [
  { what: "Order opened", body: "Your funds go into escrow on the origin chain as an ERC-7683 order." },
  { what: "Solver pays you", body: "An independent solver pays you on the destination chain, out of its own funds." },
  { what: "Fill proven", body: "The light client checks the solver's fill on the other chain.", proven: true },
  { what: "Solver repaid", body: "Only now does your escrow move, to the solver.", proven: true },
];

function LiquiditySlide() {
  return (
    <div className={s.liq}>
      <h2 className={s.h2}>Paid in seconds. Repaid only after the proof.</h2>
      <div className={s.time}>
        <div className={s.timeLine} aria-hidden="true">
          <i className={s.tlAcc} />
          <span className={s.seg1}>seconds</span>
          <span className={s.seg2}>the proof settles behind it</span>
        </div>
        <ol className={s.timeSteps}>
          {ORDER.map((o) => (
            <li key={o.what} className={o.proven ? s.proven : undefined}>
              <i aria-hidden="true" />
              <b>{o.what}</b>
              <span>{o.body}</span>
            </li>
          ))}
        </ol>
      </div>
      <dl className={s.cols3}>
        <div>
          <dt>ERC-7683 orders</dt>
          <dd>A standard intent format, so any solver can read an order and fill it.</dd>
        </div>
        <div>
          <dt>Proof-gated LP vaults</dt>
          <dd>Vaults fill only against a proof that the order was opened. No operator decides what they pay out.</dd>
        </div>
        <div>
          <dt>Fees to LPs</dt>
          <dd>Every fill pays a spread to whoever supplied the liquidity. That is the business model.</dd>
        </div>
      </dl>
      <p className={s.note}>Nobody fills before the deadline? A proof that the order was never filled refunds you.</p>
    </div>
  );
}

function ProofSlide({ f }: { f: DeckFacts }) {
  const t = f.tests;
  const b = f.beefy;
  const p = f.parlia;
  const a = f.attacks;
  const label = (n: string) => (n === "ink" ? "ink!" : n);
  const tiles = [
    { big: fmt(t.total), what: "tests passing", detail: t.suites.map((x) => `${label(x.name)} ${x.count}`).join(" · ") },
    b?.fromSet != null && b.toSet != null
      ? {
          big: `${b.fromSet} → ${b.toSet}`,
          what: "live BEEFY set handoff, verified on a BNB Chain testnet fork",
          detail: `commitment ${fmt(b.commitmentGas ?? 0)} gas · header ${fmt(b.headerGas ?? 0)} gas`,
        }
      : null,
    p?.headers
      ? {
          big: String(p.headers),
          what: "real BNB Chain headers finalized as one window",
          detail: `${kb(p.bytes)} · ${p.distinctSealers} sealers · ${p.untrustedSeals} seals from outside the set not counted`,
        }
      : null,
    a
      ? {
          big: `${a.total} / ${a.total}`,
          what: "forged proofs rejected by the attack lab",
          detail: `${a.items.filter((x) => x.rejected).length} of them again in the live-data rehearsals`,
        }
      : null,
  ].filter((x): x is { big: string; what: string; detail: string } => x !== null);

  const g = f.gas;
  const bars = g
    ? [
        { what: "BEEFY commitment", v: g.beefyCommitment },
        { what: "Header import", v: g.headerImport },
        { what: "BEEFY set handoff", v: g.setHandoff },
        { what: "Storage proof", v: g.storageProof },
      ].filter((x): x is { what: string; v: number } => x.v != null)
    : [];
  const max = Math.max(...bars.map((x) => x.v), 1);

  return (
    <div className={s.proof}>
      <h2 className={`${s.h2} ${s.h2Line}`}>Tested on real data from both chains. Then attacked.</h2>
      <div className={s.tiles}>
        {tiles.map((x) => (
          <div key={x.what} className={s.tile}>
            <p className={s.tileN}>{x.big}</p>
            <p className={s.tileWhat}>{x.what}</p>
            <p className={`${s.tileDetail} mono`}>{x.detail}</p>
          </div>
        ))}
      </div>
      <div className={s.proofLow}>
        <div>
          <p className={s.colHead}>Gas per call on the BNB Chain side</p>
          <ul className={s.bars}>
            {bars.map((x) => (
              <li key={x.what}>
                <span>{x.what}</span>
                <span className={s.barTrack} aria-hidden="true">
                  <i style={{ width: `${(x.v / max) * 100}%` }} />
                </span>
                <span className="mono">{kGas(x.v)}</span>
              </li>
            ))}
          </ul>
        </div>
        <OnTestnet f={f} />
      </div>
      <p className={s.fine}>Every number on this slide is generated from results/ and deployments/ in the repository.</p>
    </div>
  );
}

function OnTestnet({ f }: { f: DeckFacts }) {
  const d = f.deployment;
  if (!d) {
    return (
      <div className={s.testnet}>
        <p className={s.colHead}>On testnet</p>
        <p className={s.pending}>Testnet deployment: in progress.</p>
        <p className={s.pendingNote}>Contract addresses and transaction links appear on this slide once both sides are live.</p>
      </div>
    );
  }
  const rows: { chain: "portaldot" | "bsc"; c: DeployedContract }[] = [
    ...pick(d.portaldot?.contracts, ["ParliaClient", "PortaldotGateway"]).map((c) => ({ chain: "portaldot" as const, c })),
    ...pick(d.bsc?.contracts, ["PortaldotLightClient", "BscGateway"]).map((c) => ({ chain: "bsc" as const, c })),
  ];
  const all = (d.portaldot?.contracts.length ?? 0) + (d.bsc?.contracts.length ?? 0);
  const txs = f.transfers.slice(0, 3);
  return (
    <div className={s.testnet}>
      <p className={s.colHead}>On testnet · {all} contracts</p>
      <ul className={s.addrs}>
        {rows.map(({ chain, c }) => (
          <li key={chain + c.name}>
            <span className={s.chainTag}>{chain === "bsc" ? "BNB Chain" : "Portaldot"}</span>
            <span>{c.name}</span>
            <a className="mono" href={addressUrl(chain, c.address)}>
              {shortHex(c.address)}
            </a>
          </li>
        ))}
        {txs.map((t) => {
          const url = txUrl(t.chain, t.tx, t.block);
          return (
            <li key={t.tx}>
              <span className={s.chainTag}>{t.chain === "bsc" ? "BNB Chain" : "Portaldot"}</span>
              <span>{t.label}</span>
              {url ? (
                <a className="mono" href={url}>
                  {shortHex(t.tx)}
                </a>
              ) : (
                <span className="mono">{shortHex(t.tx)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The named contracts first, then whatever else was deployed, two in all. */
function pick(list: DeployedContract[] | undefined, names: string[]) {
  const l = list ?? [];
  return [...names.map((n) => l.find((c) => c.name === n)).filter((c): c is DeployedContract => !!c), ...l.filter((c) => !names.includes(c.name))].slice(0, 2);
}

function BusinessSlide({ f }: { f: DeckFacts }) {
  const c = f.deployCost;
  return (
    <div className={s.biz}>
      <h2 className={s.h2}>A route for BNB Chain liquidity into Portaldot, with no custodian.</h2>
      <div className={s.cols3x}>
        <div>
          <p className={s.colHead}>Who uses it</p>
          <dl className={s.rows}>
            <div>
              <dt>POT holders</dt>
              <dd>moving between BNB Chain and V3 mainnet without handing coins to a service.</dd>
            </div>
            <div>
              <dt>BNB Chain liquidity</dt>
              <dd>arriving as native BNB.b, ready for Portaldot&apos;s own AssetConversion pools.</dd>
            </div>
            <div>
              <dt>Portaldot dApps</dt>
              <dd>reading proven BNB Chain data, starting with the Chainlink BNB/USD feed (BscFeed).</dd>
            </div>
          </dl>
        </div>
        <div>
          <p className={s.colHead}>How it earns</p>
          <dl className={s.rows}>
            <div>
              <dt>Fast fills</dt>
              <dd>a spread on every fill, earned by whoever supplies the liquidity: an LP vault or an independent solver.</dd>
            </div>
            <div>
              <dt>Canonical transfers</dt>
              <dd>a 0.1% fee on tPOT sent out, which today pays the gas a fresh wallet needs when BNB.b arrives.</dd>
            </div>
            <div>
              <dt>No middleman</dt>
              <dd>fees reach LPs by contract. Nobody can redirect them or freeze a transfer.</dd>
            </div>
          </dl>
        </div>
        <div>
          <p className={s.colHead}>Path to mainnet</p>
          <ol className={s.pathV}>
            <li className={s.pathNow}>
              <b>
                Testnet <em>{f.deployment ? "live" : "deploying now"}</em>
              </b>
              <span>both light clients, bridges, settlers and vaults</span>
            </li>
            <li>
              <b>Audit</b>
              <span>light clients, the Merkle trie and BLAKE2 code</span>
            </li>
            <li>
              <b>V3 mainnet, with caps</b>
              <span>per-transfer and total limits that rise as it proves itself</span>
            </li>
          </ol>
          {c?.portaldotTpot != null && (
            <p className={`${s.cost} mono`}>
              full deploy: {fmt(Math.round(c.portaldotTpot))} tPOT
              {c.bscTbnb != null && <> + {c.bscTbnb.toFixed(4)} tBNB</>}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const NEXT = [
  {
    what: "Mainnet light clients for V3 Live",
    body: "The same immutable contracts, started from a mainnet checkpoint, with caps that rise as they prove themselves.",
  },
  {
    what: "More chains on the same verifiers",
    body: "The BEEFY light client runs on any EVM chain with the BLAKE2 precompile, so each new chain is a deploy, not a rewrite.",
  },
  {
    what: "An SDK and a relayer anyone can run",
    body: "Proof builders for BEEFY, MMR, Substrate tries, Parlia and receipts. A relayer can delay a transfer, never forge one.",
  },
  {
    what: "Findings filed for the platform",
    body: "Public nodes run without off-chain indexing, so mmr_generateProof fails, and keep BEEFY justifications only for the current session.",
  },
];

function SupportSlide() {
  return (
    <div className={s.support}>
      <h2 className={s.h2}>BNB Chain is the first counterparty, not the last.</h2>
      <ol className={s.grid2}>
        {NEXT.map((x, i) => (
          <li key={x.what}>
            <span className={`${s.gridN} mono`}>{pad(i + 1)}</span>
            <h3>{x.what}</h3>
            <p>{x.body}</p>
          </li>
        ))}
      </ol>
      <p className={s.ask}>Continued support pays for the audit, a capped mainnet launch, and relayers that run for everyone.</p>
    </div>
  );
}

const LINKS = [
  { what: "App", href: `${SITE}/app` },
  { what: "Attack lab", href: `${SITE}/attacks` },
  { what: "Source", href: REPO },
  { what: "Docs", href: `${REPO}/tree/main/docs` },
];

function CloseSlide() {
  return (
    <div className={s.closeWrap}>
      <span className={s.closeMark} aria-hidden="true">
        <Mark />
      </span>
      <h2 className={s.closeH}>Bridge both ways. Then try to break it.</h2>
      <p className={s.thesis}>Every Portaldot bridge so far trusts someone on the way back. Backhaul trusts no one, in either direction.</p>
      <ul className={s.links}>
        {LINKS.map((l) => (
          <li key={l.what}>
            <span>{l.what}</span>
            <a className="mono" href={l.href}>
              {host(l.href)}
            </a>
            <span className={s.arrow} aria-hidden="true">
              ↗
            </span>
          </li>
        ))}
      </ul>
      <p className={s.fine}>MIT licensed · Portaldot V3 testnet ↔ BNB Chain testnet</p>
    </div>
  );
}
