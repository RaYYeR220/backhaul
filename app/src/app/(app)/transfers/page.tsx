import type { Metadata } from "next";
import { TransfersList } from "@/components/app/TransfersList";

export const metadata: Metadata = { title: "Transfers" };

export default function TransfersPage() {
  return <TransfersList />;
}
