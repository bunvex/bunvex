import { EXAMPLES, SITE, STATUS } from "../content.ts";
import { CtaLink, Section } from "./section.tsx";

export function Status() {
  return (
    <Section
      id="status"
      alt
      kicker="Where it stands"
      title="Pre-alpha, and honest about it."
      lede="The core is built and benchmarked. It is not ready for production yet."
    >
      <ol className="m-0 grid list-none gap-3 p-0 lg:grid-cols-5">
        {STATUS.phases.map((p) => (
          <li
            key={p.name}
            className={`flex flex-col gap-1.5 border-t-[3px] pt-3.5 ${p.done ? "border-honey" : "border-line"}`}
          >
            <span className="font-mono text-xs text-dim">{p.name}</span>
            <span className="font-semibold">{p.summary}</span>
            <span
              className={`self-start rounded-full px-2.5 py-px font-mono text-[11.5px] ${p.done ? "bg-good/15 text-good" : "bg-honey/15 text-honey"}`}
            >
              {p.done ? "done" : p.left}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-sm">
        <a href={STATUS.parity} className="text-soft underline underline-offset-4 hover:text-ink">
          See the Convex parity tables
        </a>
      </p>
    </Section>
  );
}

export function FinalCta() {
  return (
    <section
      aria-labelledby="start-title"
      className="border-t border-line bg-[radial-gradient(60%_80%_at_50%_100%,color-mix(in_oklab,var(--color-honey)_14%,transparent),transparent)] py-24 text-center"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 id="start-title" className="font-display text-3xl font-extrabold tracking-tight text-balance sm:text-5xl">
          Build something live this afternoon.
        </h2>
        <p className="mx-auto mt-4 max-w-[58ch] text-lg text-soft">Clone an example, run one command, open two tabs.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <CtaLink href={EXAMPLES} primary>
            Try an example →
          </CtaLink>
          <CtaLink href={SITE.repo}>★ Star on GitHub</CtaLink>
        </div>
      </div>
    </section>
  );
}
