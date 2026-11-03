import type { Metadata } from "next";
import { LiveView } from "@/components/LiveView";

export const metadata: Metadata = { title: "Attack lab" };

export default function AttacksPage() {
  return (
    <LiveView
      kicker="Attack lab"
      title="Break a proof."
      body="Forge a BEEFY signature, seal a header with a non-validator or tamper one byte of a receipt, fire it at the light clients on both testnets, and read the revert reason."
    />
  );
}
