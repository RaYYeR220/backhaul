import type { Metadata } from "next";
import { AttackLab } from "@/components/app/AttackLab";

export const metadata: Metadata = { title: "Attack lab" };

export default function AttacksPage() {
  return <AttackLab />;
}
