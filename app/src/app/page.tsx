import { Footer, Nav } from "@/components/Chrome";
import { Hero } from "@/components/Hero";
import { AttackTeaser, HowItCrosses, Liquidity, Losses, NativeAsset, Trust } from "@/components/Sections";
import s from "@/components/Sections.module.css";

export default function Home() {
  return (
    <>
      <Nav />
      <Hero />
      <div className={s.below}>
        <Losses />
        <HowItCrosses />
        <Liquidity />
        <NativeAsset />
        <AttackTeaser />
        <Trust />
      </div>
      <Footer />
    </>
  );
}
