import { Benchmarks, Proof } from "./benchmarks.tsx";
import { Databases, Features } from "./features.tsx";
import { Files } from "./files.tsx";
import { Hero } from "./hero.tsx";
import { Migrate } from "./migrate.tsx";
import { SiteFooter } from "./site-footer.tsx";
import { SiteHeader } from "./site-header.tsx";
import { FinalCta, Status } from "./status.tsx";

/** The whole landing page. No router dependency, so tests render it directly. */
export function Landing() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <Proof />
        <div className="h-18" />
        <Benchmarks />
        <Files />
        <Features />
        <Databases />
        <Migrate />
        <Status />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
