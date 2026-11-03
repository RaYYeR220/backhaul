import Link from "next/link";
import { links } from "@/lib/links";
import s from "./Chrome.module.css";

export function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M1 11h7.5M13.5 11H21" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.7" y="4.7" width="4.6" height="12.6" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function Nav() {
  return (
    <header className={s.nav}>
      <Link className={s.brand} href="/" aria-label="Backhaul home">
        <Mark />
        Backhaul
      </Link>
      <nav className={s.links} aria-label="Primary">
        <Link href="/#how">How it works</Link>
        <Link href={links.status}>Proof</Link>
        <Link href={links.attacks}>Attack lab</Link>
        <a href={links.docs}>Docs</a>
      </nav>
      <Link className="btn btn-ghost btn-sm" href={links.app}>
        Open app
      </Link>
    </header>
  );
}

export function Footer() {
  return (
    <footer className={s.footer}>
      <div className={s.footBrand}>
        <Mark />
        <span>Backhaul</span>
        <span className={s.footNote}>Portaldot V3 testnet ↔ BNB Chain testnet</span>
      </div>
      <nav className={s.footLinks} aria-label="Footer">
        <Link href="/#how">How it works</Link>
        <Link href={links.status}>Proof</Link>
        <Link href={links.attacks}>Attack lab</Link>
        <a href={links.trust}>Trust model</a>
        <a href={links.repo}>Source on GitHub</a>
      </nav>
      <span className={s.footNote}>MIT licensed</span>
    </footer>
  );
}
