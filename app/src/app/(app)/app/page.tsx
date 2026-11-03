import type { Metadata } from "next";
import { Bridge } from "@/components/app/Bridge";

export const metadata: Metadata = { title: "Bridge" };

export default function BridgePage() {
  return <Bridge />;
}
