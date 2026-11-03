import Link from "next/link";
import { Footer, Nav } from "./Chrome";
import { links } from "@/lib/links";
import s from "./LiveView.module.css";

/** The frame of an app view that reads from the live deployment. */
export function LiveView({ kicker, title, body }: { kicker: string; title: string; body: string }) {
  return (
    <>
      <Nav />
      <main id="main" className={s.main}>
        <section className={`${s.panel} reveal`} aria-labelledby="view-h">
          <p className={s.kicker}>{kicker}</p>
          <h1 id="view-h" className={s.h1}>
            {title}
          </h1>
          <p className={s.body}>{body}</p>
          <p className={s.state}>
            <i aria-hidden="true" />
            This view connects to the live deployment.
          </p>
          <div className={s.actions}>
            <Link className="btn btn-primary btn-sm" href="/">
              Watch the rail
            </Link>
            <a className="btn btn-ghost btn-sm" href={links.repo}>
              Source on GitHub
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
