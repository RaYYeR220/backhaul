import Link from "next/link";
import { links, sources } from "@/lib/links";
import { StruckCircle } from "./rail/TransferRail";
import s from "./Sections.module.css";

function Head({ kicker, title, id }: { kicker: string; title: string; id: string }) {
  return (
    <>
      <p className={s.kicker}>{kicker}</p>
      <h2 id={id} className={s.h2}>
        {title}
      </h2>
    </>
  );
}

const LOSSES = [
  { name: "Ronin", keys: "5 of 9 validator keys", amount: "$625M", src: sources.ronin, via: "Ronin post-mortem" },
  { name: "Harmony Horizon", keys: "2 of 5 multisig keys", amount: "~$100M", src: sources.harmony, via: "Elliptic" },
  { name: "Orbit", keys: "7 of 10 multisig keys", amount: "$81.5M", src: sources.orbit, via: "Blockworks" },
];

export function Losses() {
  return (
    <section className={`${s.section} reveal`} aria-labelledby="why-h">
      <Head id="why-h" kicker="Why it matters" title="About $806M has been taken from bridges that a handful of keys could sign for." />
      <ul className={s.losses} aria-label="Bridge losses by key threshold">
        {LOSSES.map((l) => (
          <li key={l.name} className={s.loss}>
            <b>{l.name}</b>
            <span>{l.keys}</span>
            <span className={`${s.amount} mono`}>{l.amount}</span>
            <a className={s.srcLink} href={l.src} target="_blank" rel="noreferrer">
              {l.via} <span aria-hidden="true">↗</span>
            </a>
          </li>
        ))}
      </ul>
      <p className={s.lead}>
        Backhaul has no keys to take. BNB Chain&apos;s own validators prove the way in, Portaldot&apos;s own BEEFY authorities
        prove the way back, and a light client on each side checks the proof before anything is released.
      </p>
    </section>
  );
}

const WAYS = [
  {
    from: "BNB Chain",
    to: "Portaldot",
    tempo: "ticks" as const,
    steps: [
      { verb: "Lock", what: "on BNB Chain", body: "You lock tBNB in the bridge contract on BNB Chain." },
      {
        verb: "Seal",
        what: "6 of 9 BNB Chain validators",
        body: "Six distinct validators seal the headers above your lock. Portaldot's Parlia light client checks every seal itself.",
      },
      { verb: "Release", what: "on Portaldot", body: "A receipt proof of your lock releases BNB.b to you on Portaldot." },
    ],
  },
  {
    from: "Portaldot",
    to: "BNB Chain",
    tempo: "beats" as const,
    steps: [
      { verb: "Lock", what: "on Portaldot", body: "You lock BNB.b or tPOT on Portaldot, and the outbox commits to it in storage." },
      {
        verb: "Sign",
        what: "2 of 2 BEEFY signatures + MMR proof",
        body: "Both BEEFY authorities sign a commitment, and an MMR proof ties your block to what they signed.",
      },
      { verb: "Release", what: "on BNB Chain", body: "A storage proof of the commitment releases tBNB or pPOT to you on BNB Chain." },
    ],
  },
];

function Tempo({ kind }: { kind: "ticks" | "beats" }) {
  return (
    <span className={s.tempo} aria-hidden="true">
      {kind === "ticks"
        ? Array.from({ length: 14 }, (_, i) => <i key={i} className={s.tick} />)
        : Array.from({ length: 3 }, (_, i) => <i key={i} className={s.beat} />)}
    </span>
  );
}

export function HowItCrosses() {
  return (
    <section id="how" className={`${s.section} reveal`} aria-labelledby="how-h">
      <Head id="how-h" kicker="How it crosses" title="Three steps each way, each one checked on chain." />
      <div className={s.ways}>
        {WAYS.map((w) => (
          <div key={w.from} className={s.way}>
            <div className={s.wayHead}>
              <Tempo kind={w.tempo} />
              <span>
                {w.from} <span className={s.arr}>→</span> {w.to}
              </span>
            </div>
            <ol className={s.verbs}>
              {w.steps.map((st, i) => (
                <li key={st.verb} className={s.verb}>
                  <span className={s.n}>{i + 1}</span>
                  <h3>
                    {st.verb} <span>{st.what}</span>
                  </h3>
                  <p>{st.body}</p>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
      <p className={s.note}>
        A relayer carries the proofs across. Anyone can run one, and a relayer can delay a transfer but never forge one.
      </p>
    </section>
  );
}

const ORDER = [
  { what: "Order opened", body: "Your funds go into escrow on the origin chain." },
  { what: "Solver pays you", body: "An independent solver pays you on the destination chain, seconds later." },
  { what: "Fill proven", body: "The light client checks the solver's fill on the other chain.", proven: true },
  { what: "Solver repaid", body: "Only now does your escrow move, to the solver.", proven: true },
];

export function Liquidity() {
  return (
    <section className={`${s.section} ${s.split} reveal`} aria-labelledby="fast-h">
      <div>
        <Head id="fast-h" kicker="Liquidity engine" title="Paid in seconds. Repaid only after the proof." />
        <p className={s.lead}>
          Open an ERC-7683 order and you don&apos;t wait for the proof yourself. An independent solver pays you on the other
          chain out of its own funds, and is repaid from your escrow only once the light client has proven the fill.
        </p>
        <p className={s.lead}>
          LP vaults on both sides fill only against a proof that the order was opened, so no operator decides what they pay
          out. If nobody fills before the deadline, a proof that the order was never filled refunds you.
        </p>
      </div>
      <ol className={s.sequence}>
        {ORDER.map((o) => (
          <li key={o.what} className={o.proven ? s.proven : undefined}>
            <i aria-hidden="true" />
            <b>{o.what}</b>
            <span>{o.body}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const PLACES = [
  { where: "pallet-assets", body: "A native Portaldot balance, shown as it is in SubWallet and polkadot.js." },
  { where: "ERC-20", body: "The same balance through the assets precompile, so MetaMask sees it too." },
  { where: "AssetConversion", body: "Trade it in the runtime's own pools, with no extra exchange contract." },
  { where: "Gas included", body: "A fresh wallet gets a small tPOT drop with its first BNB.b, so it can move it right away." },
];

export function NativeAsset() {
  return (
    <section className={`${s.section} ${s.split} reveal`} aria-labelledby="asset-h">
      <div>
        <Head id="asset-h" kicker="Native on Portaldot" title="BNB arrives as a native Portaldot asset." />
        <p className={s.lead}>
          Bridged tBNB lands as BNB.b in Portaldot&apos;s own pallet-assets. The bridge contract holds its whole fixed supply
          and every asset role, so the BNB.b in circulation always equals the tBNB locked on BNB Chain.
        </p>
      </div>
      <dl className={s.places}>
        {PLACES.map((p) => (
          <div key={p.where}>
            <dt>{p.where}</dt>
            <dd>{p.body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const ATTACKS = [
  "Forge a BEEFY signature",
  "Seal a header with a non-validator",
  "Tamper one byte of a receipt",
  "Sign with a stale BEEFY set",
  "Replay a spent nonce",
  "Claim a fill that never happened",
];

export function AttackTeaser() {
  return (
    <section className={`${s.section} ${s.split} reveal`} aria-labelledby="lab-h">
      <div>
        <Head id="lab-h" kicker="Attack lab" title="Break a proof. Each one reverts." />
        <p className={s.lead}>
          The attack lab hands you a forger&apos;s tools and points them at the light clients on both testnets. You fire each
          attack yourself and read the revert reason, next to the recorded transaction where it failed.
        </p>
        <Link className={`btn btn-ghost ${s.cta}`} href={links.attacks}>
          Open the attack lab
        </Link>
      </div>
      <ul className={s.attacks}>
        {ATTACKS.map((a) => (
          <li key={a}>
            <StruckCircle size={13} />
            <span>{a}</span>
            <span className={s.reverts}>reverts</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const TRUSTED = [
  { what: "Portaldot's validators", body: "There are 2 of them, and the chain has a sudo key." },
  {
    what: "BNB Chain's validator set",
    body: "Under a 2/3 seal rule. Its BLS fast-finality votes are not checked, because Portaldot has no BLS precompile, and 2/3 of the last proven set must stay honest for 7 days after it was proven.",
  },
  { what: "The deploy checkpoint", body: "Each light client starts from a checkpoint chosen at deploy. A wrong one means a fresh deploy, not an admin fix." },
  { what: "Unaudited code", body: "Including the vendored Merkle trie and BLAKE2 verifiers." },
];

const UNTRUSTED = [
  { what: "Relayers", body: "Anyone can run one. A relayer can delay a transfer, never forge one." },
  { what: "Solvers and LP operators", body: "They are repaid only against a proof of the fill." },
  { what: "Our server, and us", body: "No admin key over funds or messages. No pause, no upgrade, no guardian." },
];

export function Trust() {
  return (
    <section id="trust" className={`${s.section} reveal`} aria-labelledby="trust-h">
      <Head id="trust-h" kicker="Trust model" title="What you still trust, said plainly." />
      <div className={s.trust}>
        <div>
          <h3 className={s.col}>Trusted</h3>
          <dl className={s.places}>
            {TRUSTED.map((t) => (
              <div key={t.what}>
                <dt>{t.what}</dt>
                <dd>{t.body}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className={s.col}>Not trusted</h3>
          <dl className={s.places}>
            {UNTRUSTED.map((t) => (
              <div key={t.what}>
                <dt>{t.what}</dt>
                <dd>{t.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <a className={s.more} href={links.trust}>
        Read the full trust model <span aria-hidden="true">→</span>
      </a>
    </section>
  );
}
