import type { Metadata } from "next";
import { StatusView } from "@/components/app/StatusView";

export const metadata: Metadata = { title: "Proof" };

export default function StatusPage() {
  return <StatusView />;
}
