import { Benchmarks } from "./benchmarks.tsx";
import { CodeSample } from "./code-sample.tsx";
import { Hero } from "./hero.tsx";
import { HowItWorks } from "./how-it-works.tsx";
import { SiteFooter } from "./site-footer.tsx";
import { SiteHeader } from "./site-header.tsx";
import { Status } from "./status.tsx";

/** The whole landing page. No router dependency, so tests render it directly. */
export function Landing() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <Benchmarks />
        <HowItWorks />
        <CodeSample />
        <Status />
      </main>
      <SiteFooter />
    </>
  );
}
