import { Check, Circle } from "lucide-react";
import { STATUS } from "../content.ts";
import { Section } from "./section.tsx";

export function Status() {
  return (
    <Section id="status" title="Where it stands">
      <p className="max-w-2xl text-muted-foreground">
        bunvex is pre-alpha: the core works and is benchmarked, but it is not ready for production.
      </p>
      <div className="mt-10 grid gap-12 md:grid-cols-3">
        <div>
          <h3 className="font-mono text-base font-semibold">Works today</h3>
          <ul className="mt-4 space-y-2">
            {STATUS.works.map((w) => (
              <li key={w} className="flex items-center gap-2">
                <Check aria-hidden="true" className="size-4 text-success" />
                {w}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-mono text-base font-semibold">Still to come</h3>
          <ul className="mt-4 space-y-2">
            {STATUS.next.map((n) => (
              <li key={n} className="flex items-center gap-2 text-muted-foreground">
                <Circle aria-hidden="true" className="size-4" />
                {n}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-mono text-base font-semibold">Roadmap</h3>
          <ol className="mt-4 space-y-2">
            {STATUS.phases.map((p) => (
              <li key={p.name} className="grid grid-cols-[5rem_1fr] gap-2">
                <span className="font-mono text-sm text-muted-foreground">{p.name}</span>
                <span>{p.summary}</span>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-sm">
            <a href={STATUS.parity} className="underline underline-offset-4">
              See the Convex parity tables
            </a>
          </p>
        </div>
      </div>
    </Section>
  );
}
