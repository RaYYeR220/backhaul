import type { Metadata } from "next";
import { Deck } from "@/components/deck/Deck";

export const metadata: Metadata = {
  title: "Pitch deck",
  description: "Backhaul in eleven slides: the problem, why Portaldot is essential, proof that it works, and what comes next.",
};

export default function DeckPage() {
  return <Deck />;
}
