import { describe, expect, it } from "vitest";
import { decodeAbiParameters } from "viem";
import { authoritiesAt, buildRotation, fetchCheckpoint, uncompressKey, validatorSetIdAt } from "../src/portaldot/beefy";
import { connectPortaldot, disconnectPortaldot, finalizedNumber } from "../src/portaldot/client";
import { buildCommitmentProof, trieIdOf } from "../src/portaldot/storage";

const LIVE = process.env.PORTALDOT_LIVE === "1";

describe.skipIf(!LIVE)("Portaldot proof builders (live)", () => {
  it(
    "builds a checkpoint, a rotation and a storage proof from the live chain",
    async () => {
      const c = await connectPortaldot();
      try {
        const cp = await fetchCheckpoint(c.api);
        expect(await validatorSetIdAt(c.api, cp.checkpointBlock)).toBe(cp.setId);
        expect(await validatorSetIdAt(c.api, cp.checkpointBlock - 1)).toBe(cp.setId - 1n);
        const authorities = await authoritiesAt(c.api, cp.checkpointBlock);
        expect(cp.signers).toEqual(authorities.map((a) => uncompressKey(a).address));

        const head = await finalizedNumber(c.api);
        const rot = await buildRotation(c.api, head);
        expect(rot.proof.length).toBeGreaterThan(0);
        expect(rot.uncompressedKeys.length).toBeGreaterThan(0);

        // A live ERC-20 whose balances mapping sits at slot 0, like the Outbox.
        const contract = "0x1d0c17a0ee1dcf15bd05a45ae789058a0586aa68" as const;
        expect(await trieIdOf(c.api, contract, head)).toMatch(/^0x[0-9a-f]{64}$/);
        const key = `0x${"00".repeat(12)}c3439de80429265793325a6b662232043ced04b6` as const;
        const proof = await buildCommitmentProof(c.api, contract, key, head);
        const [n, main, child] = decodeAbiParameters(
          [{ type: "uint32" }, { type: "bytes[]" }, { type: "bytes[]" }],
          proof,
        );
        expect(n).toBe(head);
        expect(main.length).toBeGreaterThan(0);
        expect(child.length).toBeGreaterThan(0);
      } finally {
        await disconnectPortaldot(c);
      }
    },
    5 * 60_000,
  );
});
