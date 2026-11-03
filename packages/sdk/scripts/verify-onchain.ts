/**
 * Re-checks a Backhaul transfer yourself, without trusting the relayer, the app or us.
 *
 *   npx tsx packages/sdk/scripts/verify-onchain.ts <tx hash> [--header <portaldot block>] [--env <file>] [--deployments <dir>]
 *
 * Give it any transaction that wrote a cross-chain message: a lock or burn on either gateway, an
 * order `open`, or a solver `fill`. It finds the transaction on Portaldot or on BNB Chain, reads
 * the Outbox `Committed(key, value)` events in it, rebuilds the proof from the source chain itself
 * and asks the light client on the other chain, with `eth_call`, whether the proof holds:
 *
 *   Portaldot → BNB Chain: a Substrate main-trie + child-trie proof of the Outbox slot, at a
 *     Portaldot header the BEEFY light client has imported, checked by PortaldotVerifier.
 *   BNB Chain → Portaldot: a receipt proof of the Committed log against the receiptsRoot of a
 *     header the Parlia light client finalized, checked by BscVerifier.
 *
 * As a negative control it then sends the same proof with a different value, which must fail.
 * Nothing is signed or sent. Exit code 0 = every commitment verified.
 */
import { decodeEventLog, getAddress, keccak256, parseAbiItem, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { portaldotVerifierAbi, bscVerifierAbi, portaldotLightClientAbi } from '../src/abi.js';
import { BscClient, BSC_TESTNET_RPCS } from '../src/bsc/client.js';
import { buildCommitmentProof as bscCommitmentProof } from '../src/bsc/verifier.js';
import { BSC_RPC, PORTALDOT_EVM_RPC, PORTALDOT_SUBSTRATE_WS, type ChainName } from '../src/chains.js';
import { loadDeployment } from '../src/deployments.js';
import { loadEnvFromArgs } from '../src/env.js';
import { publicClientFor, revertReason } from '../src/evm.js';
import { connectPortaldot, disconnectPortaldot } from '../src/portaldot/client.js';
import { buildCommitmentProof as portaldotCommitmentProof } from '../src/portaldot/storage.js';

const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
loadEnvFromArgs(process.argv);

const txHash = argv.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a)) as Hex | undefined;
const NAME: Record<ChainName, string> = { portaldot: 'Portaldot V3 testnet', bsc: 'BNB Chain testnet' };
const COMMITTED = parseAbiItem('event Committed(bytes32 indexed key, bytes32 value)');
const HEADER_IMPORTED = parseAbiItem('event HeaderImported(uint32 number, bytes32 hash, bytes32 stateRoot)');

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

async function main() {
  if (!txHash) fail('usage: verify-onchain.ts <0x… tx hash> [--header <portaldot block>] [--env <file>]', 64);

  const dir = opt('deployments');
  const dep = { portaldot: loadDeployment('portaldot', dir), bsc: loadDeployment('bsc', dir) };
  const need = (c: ChainName, name: string): Address | undefined => {
    const a = dep[c].contracts[name]?.address;
    return a ? getAddress(a) : undefined;
  };
  if (!need('portaldot', 'Outbox') || !need('bsc', 'Outbox')) {
    fail(
      'Backhaul is not deployed yet: deployments/portaldot.json and deployments/bsc.json hold no contracts, so there is no\n' +
        'light client to check a proof against. Run this again once the deploy has written them (npm run deploy).',
      2,
    );
  }

  const pub: Record<ChainName, PublicClient> = {
    portaldot: publicClientFor('portaldot', process.env.PORTALDOT_EVM_RPC || PORTALDOT_EVM_RPC),
    bsc: publicClientFor('bsc', process.env.BSC_RPC || BSC_RPC),
  };

  // 1. Which chain is the transaction on?
  const found = await Promise.all(
    (['portaldot', 'bsc'] as const).map(async (c) => {
      try {
        return { c, r: await pub[c].getTransactionReceipt({ hash: txHash }) };
      } catch {
        return undefined;
      }
    }),
  );
  const hit = found.find(Boolean);
  if (!hit) fail(`${txHash} is not a transaction on either testnet (or the RPC nodes do not have it).`);
  const src: ChainName = hit.c;
  const dst: ChainName = src === 'portaldot' ? 'bsc' : 'portaldot';
  const receipt = hit.r;
  console.log(`${txHash}: ${NAME[src]}, block ${receipt.blockNumber}, status ${receipt.status}`);

  // 2. The messages it committed to the source Outbox.
  const outbox = need(src, 'Outbox')!;
  const commits: { key: Hex; value: Hex }[] = [];
  for (const l of receipt.logs) {
    if (getAddress(l.address) !== outbox) continue;
    try {
      const ev = decodeEventLog({ abi: [COMMITTED], data: l.data, topics: l.topics });
      commits.push({ key: ev.args.key as Hex, value: ev.args.value as Hex });
    } catch {
      /* another event */
    }
  }
  if (!commits.length) {
    fail(
      `This transaction wrote nothing to the Backhaul Outbox on ${NAME[src]} (${outbox}).\n` +
        'Pass the transaction that started the transfer: the lock or burn, an order open, or a solver fill.',
      3,
    );
  }

  let ok = true;
  if (src === 'portaldot') {
    // 3a. Portaldot → BNB Chain: storage proof at a header the BEEFY client has imported.
    const lc = need('bsc', 'PortaldotLightClient');
    const verifier = need('bsc', 'PortaldotVerifier');
    if (!lc || !verifier) fail('deployments/bsc.json has no PortaldotLightClient / PortaldotVerifier.', 2);
    const header = opt('header') ? Number(opt('header')) : await importedHeaderAtOrAfter(pub.bsc, lc, Number(receipt.blockNumber));
    if (header === undefined) {
      fail(
        `No Portaldot header at or after block ${receipt.blockNumber} is in the BEEFY light client on BNB Chain yet.\n` +
          'The relayer imports one when a transfer needs it; anyone can (see packages/sdk/src/relay/beefy.ts).',
        4,
      );
    }
    const root = await pub.bsc.readContract({ address: lc, abi: portaldotLightClientAbi, functionName: 'stateRootOf', args: [header] });
    console.log(`BEEFY light client ${lc}: Portaldot header ${header} imported, state root ${root}`);
    const pd = await connectPortaldot(process.env.PORTALDOT_WS || PORTALDOT_SUBSTRATE_WS);
    try {
      for (const c of commits) {
        const proof = await portaldotCommitmentProof(pd.api, outbox, c.key, header);
        ok = (await check(pub.bsc, verifier, portaldotVerifierAbi, c, proof, `${(proof.length - 2) / 2} B main + child trie proof`)) && ok;
      }
    } finally {
      await disconnectPortaldot(pd);
    }
  } else {
    // 3b. BNB Chain → Portaldot: receipt proof against a header the Parlia client finalized.
    const verifier = need('portaldot', 'BscVerifier');
    if (!verifier) fail('deployments/portaldot.json has no BscVerifier.', 2);
    const bsc = new BscClient({ urls: process.env.BSC_RPC ? [process.env.BSC_RPC, ...BSC_TESTNET_RPCS] : BSC_TESTNET_RPCS });
    for (const c of commits) {
      const p = await bscCommitmentProof(bsc, txHash, outbox, c.key);
      ok = (await check(pub.portaldot, verifier, bscVerifierAbi, c, p.proof, `receipt proof in BSC block ${p.blockNumber}`)) && ok;
    }
  }
  console.log(ok ? `\nverified: every message in this transaction is proven on ${NAME[dst]}.` : '\nNOT verified (see above).');
  process.exit(ok ? 0 : 1);
}

/** eth_call verifyCommitment with the real proof (must be true) and with a changed value (must be false). */
async function check(pub: PublicClient, verifier: Address, abi: typeof portaldotVerifierAbi | typeof bscVerifierAbi, c: { key: Hex; value: Hex }, proof: Hex, what: string) {
  const call = (value: Hex) =>
    pub.readContract({ address: verifier, abi: abi as any, functionName: 'verifyCommitment', args: [c.key, value, proof] }).then(
      (r) => ({ ok: r === true, why: String(r) }),
      (e) => ({ ok: false, why: revertReason(e) }),
    );
  const real = await call(c.value);
  const forged = await call(keccak256(toHex(`not ${c.value}`)));
  console.log(`\ncommitment ${c.key}`);
  console.log(`  value ${c.value}, ${what}`);
  console.log(`  ${verifier}.verifyCommitment → ${real.ok ? 'true' : `NOT accepted: ${real.why}`}`);
  console.log(`  negative control, same proof with another value → ${forged.ok ? 'ACCEPTED (this must not happen)' : `rejected (${forged.why})`}`);
  if (!real.ok && /NotFinalized/.test(real.why)) {
    console.log('  The Parlia client keeps the last 256 finalized BSC headers; this block is not among them (not yet, or overwritten).');
    console.log('  A storage proof of the same Outbox slot at any later finalized block proves it too (BscVerifier proof type 0x02).');
  }
  return real.ok && !forged.ok;
}

/** Newest Portaldot header ≥ `min` that the BEEFY client imported, from its HeaderImported events. */
async function importedHeaderAtOrAfter(pub: PublicClient, lc: Address, min: number): Promise<number | undefined> {
  const latest = await pub.getBlockNumber();
  const chunk = 5_000n;
  for (let to = latest, i = 0; to > 0n && i < 60; to -= chunk, i++) {
    const from = to > chunk ? to - chunk + 1n : 0n;
    const logs = await pub.getLogs({ address: lc, event: HEADER_IMPORTED, fromBlock: from, toBlock: to }).catch(() => []);
    const ok = logs.map((l) => Number(l.args.number)).filter((n) => n >= min);
    if (ok.length) return Math.max(...ok);
  }
  return undefined;
}

main().catch((e) => fail(revertReason(e)));
