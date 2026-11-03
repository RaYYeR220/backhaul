import type { Metadata } from "next";
import { LiveView } from "@/components/LiveView";

export const metadata: Metadata = { title: "Proof" };

export default function StatusPage() {
  return (
    <LiveView
      kicker="Proof"
      title="Each chain, as the other sees it."
      body="The latest BNB Chain header proven on Portaldot and the latest Portaldot block proven on BNB Chain, with the signers behind each, the set id and epoch, and how far each side lags."
    />
  );
}
