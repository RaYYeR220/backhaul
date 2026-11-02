/**
 * Records every BEEFY justification the Portaldot node streams into a JSONL archive, and backfills
 * the justifications the node still keeps for the current session.
 *
 *   npx tsx packages/sdk/scripts/archive-portaldot-justifications.ts [archivePath] [--until-set N]
 *
 * With `--until-set N` it exits once a justification signed by set N has been archived.
 */
import { resolve } from "node:path";
import { JustificationArchive } from "../src/portaldot/beefy";
import { connectPortaldot, disconnectPortaldot, finalizedNumber } from "../src/portaldot/client";

const args = process.argv.slice(2);
const untilIdx = args.indexOf("--until-set");
const untilSet = untilIdx >= 0 ? BigInt(args[untilIdx + 1]) : undefined;
const positional = args.filter((_, i) => i !== untilIdx && i !== untilIdx + 1);
const path = resolve(positional[0] ?? "packages/sdk/.cache/portaldot-justifications.jsonl");

const client = await connectPortaldot();
const { api } = client;
const archive = JustificationArchive.open(path);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

// Backfill what the node still holds for this session: every block from the session start up to
// the finalized head that carries a BEEFY justification.
const head = await finalizedNumber(api);
let lo = Math.max(1, head - 1300);
let hi = head;
const sessionAt = async (n: number) =>
  ((await (await api.at(await api.rpc.chain.getBlockHash(n))).query.session.currentIndex()) as any).toNumber();
const current = await sessionAt(hi);
while (hi - lo > 1) {
  const mid = (lo + hi) >> 1;
  if ((await sessionAt(mid)) === current) hi = mid;
  else lo = mid;
}
log(`session ${current} started at block ${hi}; backfilling to ${head}`);
let backfilled = 0;
for (let n = hi; n <= head; n++) {
  const e = await archive.recordFromBlock(api, n);
  if (e) backfilled++;
}
log(`backfilled ${backfilled} justifications, archive holds ${archive.entries().length}`);

const done = () => untilSet !== undefined && archive.entries().some((e) => BigInt(e.validatorSetId) >= untilSet);

if (done()) {
  await disconnectPortaldot(client);
  process.exit(0);
}

const stop = await archive.subscribe(client.provider, (e) => {
  log(`block ${e.blockNumber} set ${e.validatorSetId}`);
  if (done()) {
    void stop().then(() => disconnectPortaldot(client)).then(() => process.exit(0));
  }
});
log(`subscribed, writing to ${path}`);
