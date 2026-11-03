import type { Metadata } from "next";
import { TransferView } from "@/components/app/TransferView";

export const metadata: Metadata = { title: "Transfer" };

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TransferView id={decodeURIComponent(id)} />;
}
