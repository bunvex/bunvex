import { CONFORMANCE, DRIVERS, FEATURES } from "../content.ts";
import { Section } from "./section.tsx";

export function HowItWorks() {
  return (
    <Section id="how-it-works" title="How it works">
      <div className="grid gap-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-border">
        {FEATURES.map((f) => (
          <div key={f.title} className="md:px-6 md:first:pl-0 md:last:pr-0">
            <h3 className="font-mono text-base font-semibold">{f.title}</h3>
            <p className="mt-3 leading-relaxed text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-14 border border-border p-6">
        <h3 className="font-mono text-base font-semibold">Runs on the database you already have</h3>
        <ul className="mt-4 flex flex-wrap gap-2">
          {DRIVERS.map((d) => (
            <li key={d.name} className="border border-border px-3 py-1.5 font-mono text-sm">
              {d.name}
              {"note" in d && <span className="text-muted-foreground"> ({d.note})</span>}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted-foreground">
          {CONFORMANCE.text}{" "}
          <a href={CONFORMANCE.link} className="text-foreground underline underline-offset-4">
            Read the contract
          </a>
        </p>
      </div>
    </Section>
  );
}
