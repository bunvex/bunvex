import { blob, MIGRATE, PARITY } from "../content.ts";

export function Migrate() {
  return (
    <section id="migrate" aria-labelledby="migrate-title" className="scroll-mt-16 border-t border-line">
      <div className="mx-auto grid max-w-6xl items-start gap-7 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="font-mono text-xs tracking-[0.08em] text-honey uppercase">Coming from Convex</p>
          <h2
            id="migrate-title"
            className="mt-3.5 font-display text-3xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-5xl"
          >
            Your app, unchanged. Your infrastructure.
          </h2>
          <p className="mt-3.5 max-w-[58ch] text-lg text-soft">
            bunvex matches Convex's behaviour by default: the same functions, validators, errors and limits. Where it
            differs, the difference is written down.
          </p>
          <ul className="m-0 mt-5 flex list-none flex-col gap-2.5 p-0 text-[15px] text-soft">
            {MIGRATE.facts.map((f) => (
              <li key={f.text}>
                <span aria-hidden="true" className="font-mono text-honey">
                  →{" "}
                </span>
                <a href={blob(f.source)} className="hover:text-ink">
                  {f.text}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <pre className="m-0 rounded-xl border border-line bg-surface px-[18px] py-4 font-mono text-[13.5px] leading-[1.8] whitespace-pre-wrap">
            {MIGRATE.diff.map((d) => (
              <span key={d.to} className="block">
                <span className="block text-bad">
                  <span className="sr-only">removed: </span>- {d.from}
                </span>
                <span className="block text-good">
                  <span className="sr-only">added: </span>+ {d.to}
                </span>
              </span>
            ))}
          </pre>
          <ul
            className="m-0 mt-5 flex list-none flex-col gap-4 p-0"
            aria-label="Convex's inventory, done rows per area"
          >
            {PARITY.areas.map((a) => {
              const all = a.done + a.partial + a.missing;
              return (
                <li key={a.name} className="flex flex-col gap-1.5 text-sm">
                  <span className="flex justify-between gap-3 text-soft">
                    <span>{a.name}</span>
                    <b className="font-mono font-medium text-ink tabular-nums">
                      {a.done} / {all}
                    </b>
                  </span>
                  <span aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-line">
                    <span className="bg-honey" style={{ width: `${(a.done / all) * 100}%` }} />
                    <span className="bg-honey/45" style={{ width: `${(a.partial / all) * 100}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[13.5px] text-dim">
            Rows of Convex's own inventory, read from its source; the faint part is partly done.{" "}
            <a href={PARITY.link} className="text-soft underline underline-offset-4 hover:text-ink">
              See every row
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
