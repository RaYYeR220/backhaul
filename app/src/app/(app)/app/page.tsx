import type { Metadata } from "next";
import { LiveView } from "@/components/LiveView";

export const metadata: Metadata = { title: "Bridge" };

export default function BridgePage() {
  return (
    <LiveView
      kicker="Bridge"
      title="Bridge both ways."
      body="Send tBNB to Portaldot and BNB.b or tPOT back to BNB Chain, then follow every proof step as it lands, each with its transaction."
    />
  );
}
