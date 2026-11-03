import { AppNav } from "@/components/app/AppNav";
import s from "@/components/app/app.module.css";
import { Footer } from "@/components/Chrome";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppNav />
      <main id="main" className={s.main} aria-labelledby="view-h">
        {children}
      </main>
      <Footer />
    </>
  );
}
