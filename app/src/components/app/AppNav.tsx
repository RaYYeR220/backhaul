"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { links } from "@/lib/links";
import { Mark } from "../Chrome";
import s from "./AppNav.module.css";

const VIEWS = [
  { href: links.app, label: "Bridge" },
  { href: links.transfers, label: "Transfers" },
  { href: links.status, label: "Proof" },
  { href: links.attacks, label: "Attack lab" },
];

/** The app's header: the same chassis as the landing, with the app's views as tabs. */
export function AppNav() {
  const path = usePathname() ?? "";
  const current = (href: string) => path === href || path.startsWith(href + "/");
  const tabs = VIEWS.map((v) => (
    <Link key={v.href} href={v.href} aria-current={current(v.href) ? "page" : undefined}>
      {v.label}
    </Link>
  ));
  return (
    <>
      <header className={s.nav}>
        <Link className={s.brand} href="/" aria-label="Backhaul home">
          <Mark />
          Backhaul
        </Link>
        <nav className={s.links} aria-label="App">
          {tabs}
        </nav>
        <a className={`btn btn-ghost btn-sm ${s.docs}`} href={links.docs}>
          Docs
        </a>
      </header>
      <nav className={s.tabs} aria-label="App views">
        {tabs}
      </nav>
    </>
  );
}
