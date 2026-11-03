"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { getAddress, isAddress, parseUnits } from "viem";
import { amount as fmtAmount, chainLabel, ROUTES, type Route } from "@/lib/assets";
import { CHAINS, type ChainName } from "@/lib/config";
import { isUnreachable, RelayerError, relayer, type Status } from "@/lib/relayer";
import { usePoll } from "@/lib/usePoll";
import { allowance, approveCall, balanceOf, gatewayCall, gatewayFor, injected, lockedNonce, switchTo, waitReceipt, walletMessage, type Eip1193 } from "@/lib/wallet";
import { StruckCircle } from "../rail/TransferRail";
import { duration, Hex, RelayerBanner, ViewHead } from "./ui";
import s from "./Bridge.module.css";

type Dir = "toPortaldot" | "toBnb";

/** What the visitor typed, checked against the route; `wei` is set when it is sendable. */
function parseAmount(raw: string, route: Route): { wei: bigint | null; problem: string | null } {
  const v = raw.trim();
  if (!v) return { wei: null, problem: null };
  if (!/^\d*\.?\d*$/.test(v) || v === ".") return { wei: null, problem: "Type a number, like 0.5." };
  const frac = v.split(".")[1] ?? "";
  if (frac.length > route.decimals) return { wei: null, problem: `${route.send} takes at most ${route.decimals} decimals.` };
  const wei = parseUnits(v, 18);
  if (wei <= 0n) return { wei: null, problem: "The amount has to be above zero." };
  return { wei, problem: null };
}

const STEPS: Record<string, { verb: string; what: string; body: string }[]> = {
  BNB_TO_PORTALDOT: [
    { verb: "Lock", what: "tBNB on BNB Chain", body: "The gateway holds it and logs the transfer." },
    { verb: "Seal", what: "6 of 9 BNB Chain validators", body: "Six distinct validators seal the headers from your lock onward. Portaldot's Parlia light client checks every seal." },
    { verb: "Release", what: "BNB.b on Portaldot", body: "A receipt proof of your lock releases BNB.b, a native Portaldot asset, with a small tPOT gas drop for a fresh account." },
  ],
  PPOT_TO_PORTALDOT: [
    { verb: "Burn", what: "pPOT on BNB Chain", body: "The gateway burns it and logs the transfer." },
    { verb: "Seal", what: "6 of 9 BNB Chain validators", body: "Six distinct validators seal the headers from your burn onward. Portaldot's Parlia light client checks every seal." },
    { verb: "Release", what: "tPOT on Portaldot", body: "A receipt proof of your burn releases tPOT from the gateway's lock." },
  ],
  POT_TO_BSC: [
    { verb: "Lock", what: "tPOT on Portaldot", body: "The Outbox commits to the transfer in contract storage. Portaldot charges a storage deposit for that slot." },
    { verb: "Sign", what: "2 of 2 BEEFY authorities", body: "Both BEEFY authorities sign a commitment past your block, and an MMR proof ties your block to it." },
    { verb: "Release", what: "pPOT on BNB Chain", body: "A storage proof of the commitment mints pPOT, net of the 0.1 % bridge fee." },
  ],
  BNBB_TO_BSC: [
    { verb: "Return", what: "BNB.b on Portaldot", body: "The gateway takes the BNB.b back and the Outbox commits to the transfer." },
    { verb: "Sign", what: "2 of 2 BEEFY authorities", body: "Both BEEFY authorities sign a commitment past your block, and an MMR proof ties your block to it." },
    { verb: "Release", what: "tBNB on BNB Chain", body: "A storage proof of the commitment releases tBNB from the gateway's lock." },
  ],
};

export function Bridge() {
  const router = useRouter();
  const uid = useId();
  const [dir, setDir] = useState<Dir>("toPortaldot");
  const [asset, setAsset] = useState<Record<Dir, number>>({ toPortaldot: 0, toBnb: 0 });
  const [raw, setRaw] = useState("");
  const [recipient, setRecipient] = useState("");
  const [touched, setTouched] = useState(false);
  const st = usePoll((sig) => relayer.status(sig), () => 15_000, "status");

  const routes = ROUTES.filter((r) => (dir === "toPortaldot" ? r.from === "bsc" : r.from === "portaldot"));
  const route = routes[asset[dir]] ?? routes[0];
  const amt = parseAmount(raw, route);
  const recipientOk = isAddress(recipient.trim(), { strict: false });
  const receives = amt.wei != null ? amt.wei - (amt.wei * BigInt(route.feeBps)) / 10_000n : null;

  const wallet = useWallet();
  const ready = amt.wei != null && recipientOk;

  return (
    <>
      <ViewHead
        kicker="Bridge"
        title="Bridge both ways."
        lead="Every transfer is released against a proof of the other chain's finalized state, checked by a light client on chain. No relayer, committee or server signs for it."
      />
      <RelayerBanner error={st.error} at={st.at} onRetry={st.refresh} />

      <div className={s.layout}>
        <form className={s.card} onSubmit={(e) => e.preventDefault()} aria-label="Transfer">
          <div className={s.seg} role="group" aria-label="Direction">
            {(["toPortaldot", "toBnb"] as const).map((d) => (
              <button key={d} type="button" aria-pressed={dir === d} onClick={() => setDir(d)}>
                {d === "toPortaldot" ? (
                  <>
                    BNB Chain <span className={s.arr}>→</span> Portaldot
                  </>
                ) : (
                  <>
                    Portaldot <span className={s.arr}>→</span> BNB Chain
                  </>
                )}
              </button>
            ))}
          </div>

          <div className={s.field}>
            <label htmlFor={`${uid}-amt`}>
              You send on {chainLabel(route.from)}
            </label>
            <div className={s.amountRow}>
              <input
                id={`${uid}-amt`}
                className={`${s.amount} mono`}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.0"
                value={raw}
                onChange={(e) => setRaw(e.target.value.replace(",", "."))}
                aria-invalid={!!amt.problem}
                aria-describedby={`${uid}-amt-note`}
              />
              <div className={s.assets} role="radiogroup" aria-label="Asset">
                {routes.map((r, i) => (
                  <button
                    key={r.kind}
                    type="button"
                    role="radio"
                    aria-checked={r === route}
                    onClick={() => setAsset((a) => ({ ...a, [dir]: i }))}
                  >
                    {r.send}
                  </button>
                ))}
              </div>
            </div>
            <p id={`${uid}-amt-note`} className={amt.problem ? s.problem : s.hint}>
              {amt.problem ??
                (receives != null ? (
                  <>
                    Arrives as <span className="mono">{fmtAmount(receives, 14)}</span> {route.receive} on {chainLabel(route.to)}
                    {route.feeBps ? `, after the ${route.feeBps / 100} % bridge fee` : ""}.
                  </>
                ) : (
                  <>
                    Arrives as {route.receive} on {chainLabel(route.to)}
                    {route.feeBps ? `, after the ${route.feeBps / 100} % bridge fee` : ", one for one"}.
                  </>
                ))}
            </p>
          </div>

          <div className={s.field}>
            <label htmlFor={`${uid}-to`}>Recipient on {chainLabel(route.to)}</label>
            <div className={s.recRow}>
              <input
                id={`${uid}-to`}
                className={`${s.input} mono`}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                onBlur={() => setTouched(true)}
                aria-invalid={touched && !!recipient && !recipientOk}
                aria-describedby={`${uid}-to-note`}
              />
              {wallet.account && recipient.toLowerCase() !== wallet.account.toLowerCase() && (
                <button type="button" className={s.mini} onClick={() => setRecipient(wallet.account!)}>
                  Use my wallet
                </button>
              )}
            </div>
            <p id={`${uid}-to-note`} className={touched && recipient && !recipientOk ? s.problem : s.hint}>
              {touched && recipient && !recipientOk
                ? "That is not a 0x address."
                : `Any EVM address. The same address works on both chains${route.to === "portaldot" ? "; Portaldot maps it to a native account" : ""}.`}
            </p>
          </div>

          <DemoSend route={route} raw={raw} wei={amt.wei} recipient={recipient} ready={ready} status={st.data} statusError={st.error} onSent={(id) => router.push(`/transfers/${encodeURIComponent(id)}`)} />

          <WalletSend route={route} wei={amt.wei} recipient={recipient} ready={ready} wallet={wallet} onSent={(id) => router.push(`/transfers/${encodeURIComponent(id)}`)} />
        </form>

        <aside className={s.side} aria-labelledby={`${uid}-how`}>
          <h2 id={`${uid}-how`}>
            How {route.send} crosses to {chainLabel(route.to)}
          </h2>
          <ol className={s.verbs}>
            {STEPS[route.kind].map((x, i) => (
              <li key={x.verb} className={i === 2 ? s.release : undefined}>
                <span className={s.n}>{i + 1}</span>
                <h3>
                  {x.verb} <span>{x.what}</span>
                </h3>
                <p>{x.body}</p>
              </li>
            ))}
          </ol>
          <p className={s.sideNote}>After you send, the transfer view follows each step live, with its transaction on the explorer.</p>
        </aside>
      </div>
    </>
  );
}

/* ---------- the demo wallet: no credentials, capped ---------- */

function DemoSend({
  route,
  raw,
  wei,
  recipient,
  ready,
  status,
  statusError,
  onSent,
}: {
  route: Route;
  raw: string;
  wei: bigint | null;
  recipient: string;
  ready: boolean;
  status?: Status;
  statusError: unknown;
  onSent: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const demo = status?.demo ?? null;
  const cap = demo?.limits.perRequest[route.send];
  const day = demo?.limits.perDay[route.send];
  const used = demo?.usedToday[route.send] ?? "0";
  const left = day != null ? BigInt(day) - BigInt(used) : null;
  const over = wei != null && cap != null && wei > BigInt(cap);
  const ppot = status?.addresses?.bsc?.PPOT;
  const bnbb = status?.addresses?.portaldot?.bnbb as string | undefined;
  const tokens = useMemo(() => ({ ppot, bnbb }), [ppot, bnbb]);

  // pPOT and BNB.b leave from what the demo key holds, so say so when it holds none
  const demoAddress = demo?.address;
  useEffect(() => {
    setHeld(null);
    if (!demoAddress || (route.send !== "pPOT" && route.send !== "BNB.b")) return;
    let alive = true;
    balanceOf(route.from, route.send, demoAddress, tokens).then(
      (b) => alive && setHeld(b),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [demoAddress, route, tokens]);

  useEffect(() => setError(null), [route, raw, recipient]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await relayer.demo(route.demo, raw.trim(), getAddress(recipient));
      onSent(r.id);
    } catch (e) {
      setBusy(false);
      if (e instanceof RelayerError && e.status === 429) {
        const after = Number(e.body.retryAfterSec);
        setError(`${e.message}${Number.isFinite(after) ? `. Try again in ${duration(after, true)}.` : "."}`);
      } else if (e instanceof RelayerError && e.status === 400 && e.body.cap) setError(`At most ${fmtAmount(String(e.body.cap), 14)} ${route.send} per request.`);
      else if (e instanceof RelayerError && e.status === 503) setError("The demo wallet is off on this relayer.");
      else setError(e instanceof Error ? e.message : String(e));
    }
  };

  const off = !status ? (isUnreachable(statusError) ? "The relayer is not answering, so the demo wallet cannot send." : "Reading the demo wallet's limits from the relayer.") : !demo ? "The demo wallet is off on this relayer." : null;
  const empty = held === 0n;

  return (
    <section className={s.path} aria-label="Send with the demo wallet">
      <button type="button" className={`btn btn-primary ${s.wide}`} disabled={!!off || !ready || over || busy || empty} onClick={send}>
        {busy ? "Sending from the demo wallet…" : "Send with the demo wallet"}
      </button>
      <p className={s.pathNote}>
        {off ??
          (empty ? (
            `The demo wallet holds no ${route.send} on ${chainLabel(route.from)} right now. Pick another asset or use your own wallet.`
          ) : (
            <>
              No wallet needed: the relayer&apos;s demo key sends it for you. Up to <span className="mono">{fmtAmount(cap ?? "0", 14)}</span> {route.send} per request,{" "}
              {demo!.limits.perIpPerHour} requests an hour per visitor
              {left != null && (
                <>
                  , <span className="mono">{fmtAmount(left > 0n ? left : 0n, 6)}</span> {route.send} left today
                </>
              )}
              .
            </>
          ))}
      </p>
      {over && <p className={s.problem}>That is above the demo cap of {fmtAmount(cap!, 14)} {route.send}. Lower it, or send from your own wallet.</p>}
      {error && (
        <p className={s.fail} role="alert">
          <StruckCircle size={12} />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}

/* ---------- the visitor's own wallet, straight to the gateway ---------- */

interface WalletState {
  eth: Eip1193 | null;
  account: string | null;
  chainId: number | null;
  connect: () => Promise<void>;
  error: string | null;
}

function useWallet(): WalletState {
  const [eth, setEth] = useState<Eip1193 | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const e = injected();
    setEth(e);
    if (!e) return;
    const onAccounts = (a: unknown) => setAccount(((a as string[]) ?? [])[0] ?? null);
    const onChain = (c: unknown) => setChainId(parseInt(String(c), 16));
    e.request({ method: "eth_accounts" }).then(onAccounts, () => {});
    e.request({ method: "eth_chainId" }).then(onChain, () => {});
    e.on?.("accountsChanged", onAccounts);
    e.on?.("chainChanged", onChain);
    return () => {
      e.removeListener?.("accountsChanged", onAccounts);
      e.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    if (!eth) return;
    setError(null);
    try {
      const a = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(a[0] ?? null);
      setChainId(parseInt(String(await eth.request({ method: "eth_chainId" })), 16));
    } catch (e) {
      setError(walletMessage(e));
    }
  }, [eth]);

  return { eth, account, chainId, connect, error };
}

function WalletSend({ route, wei, recipient, ready, wallet, onSent }: { route: Route; wei: bigint | null; recipient: string; ready: boolean; wallet: WalletState; onSent: (id: string) => void }) {
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string; tx?: string } | null>(null);
  const gateway = gatewayFor(route);
  const chain: ChainName = route.from;
  const onChain = wallet.chainId === CHAINS[chain].id;

  useEffect(() => setError(null), [route, wei, recipient]);

  const send = async () => {
    const eth = wallet.eth;
    if (!eth || !wallet.account || wei == null) return;
    setError(null);
    let hash: string | undefined;
    try {
      if (route.kind === "BNBB_TO_BSC") {
        setPhase("Checking the BNB.b allowance…");
        const have = await allowance(wallet.account);
        if (have == null || have < wei) {
          setPhase("Approve BNB.b in your wallet…");
          const ap = approveCall(wei);
          const apHash = (await eth.request({ method: "eth_sendTransaction", params: [{ from: wallet.account, to: ap.to, data: ap.data }] })) as string;
          setPhase("Waiting for the approval to land…");
          const r = await waitReceipt(chain, apHash);
          if (r.status !== "0x1") throw Object.assign(new Error("The approval reverted on chain."), { tx: apHash });
        }
      }
      const call = gatewayCall(route, wei, getAddress(recipient));
      setPhase(`Confirm the ${route.verb.toLowerCase()} in your wallet…`);
      hash = (await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.account, to: call.to, data: call.data, ...(call.value ? { value: "0x" + call.value.toString(16) } : {}) }],
      })) as string;
      setPhase(`Waiting for the ${route.verb.toLowerCase()} to land on ${chainLabel(chain)}…`);
      const r = await waitReceipt(chain, hash);
      if (r.status !== "0x1") throw Object.assign(new Error(`The ${route.verb.toLowerCase()} reverted on chain.`), { tx: hash });
      const nonce = lockedNonce(route, r);
      onSent(nonce ? `${chain}:${nonce}` : hash);
    } catch (e) {
      setPhase(null);
      setError({ msg: walletMessage(e), tx: (e as { tx?: string }).tx ?? hash });
    }
  };

  const switchChain = async () => {
    if (!wallet.eth) return;
    setError(null);
    try {
      setPhase(`Switch to ${CHAINS[chain].full} in your wallet…`);
      await switchTo(wallet.eth, chain);
    } catch (e) {
      setError({ msg: walletMessage(e) });
    } finally {
      setPhase(null);
    }
  };

  let body: React.ReactNode;
  if (!gateway) {
    body = (
      <p className={s.pathNote}>
        The gateway on {chainLabel(chain)} is not deployed in this build yet, so wallet sends are closed. They open as soon as its address is synced in.
      </p>
    );
  } else if (!wallet.eth) {
    body = <p className={s.pathNote}>No browser wallet found. Install MetaMask, or use the demo wallet above.</p>;
  } else if (!wallet.account) {
    body = (
      <>
        <button type="button" className={`btn btn-ghost ${s.wide}`} onClick={wallet.connect}>
          Connect wallet
        </button>
        <p className={s.pathNote}>Sends straight to the gateway on {chainLabel(chain)}. You pay the gas in {CHAINS[chain].native}.</p>
      </>
    );
  } else if (!onChain) {
    body = (
      <>
        <button type="button" className={`btn btn-ghost ${s.wide}`} onClick={switchChain} disabled={!!phase}>
          Switch to {CHAINS[chain].full}
        </button>
        <p className={s.pathNote}>
          Connected as <Hex chain={chain} kind="address" value={wallet.account} />. The network is added to your wallet if it does not know it.
        </p>
      </>
    );
  } else {
    body = (
      <>
        <button type="button" className={`btn btn-ghost ${s.wide}`} onClick={send} disabled={!ready || !!phase}>
          {phase ?? `${route.verb} ${route.send} from your wallet`}
        </button>
        <p className={s.pathNote}>
          Connected as <Hex chain={chain} kind="address" value={wallet.account} /> on {CHAINS[chain].full}. Gateway <Hex chain={chain} kind="address" value={gateway} />.
          {route.kind === "BNBB_TO_BSC" && " BNB.b needs an approval first if the gateway has no allowance."}
        </p>
      </>
    );
  }

  return (
    <section className={s.path} aria-label="Send from your own wallet">
      <p className={s.or}>
        <span>or from your own wallet</span>
      </p>
      {body}
      {(error || wallet.error) && (
        <p className={s.fail} role="alert">
          <StruckCircle size={12} />
          <span>
            {error?.msg ?? wallet.error}
            {error?.tx && (
              <>
                {" "}
                <Hex chain={chain} kind="tx" value={error.tx} />
              </>
            )}
          </span>
        </p>
      )}
    </section>
  );
}
