import { BENCH, type BenchRow } from "../content.ts";
import { Section } from "./section.tsx";

const COLUMNS = [
  { key: "convex", label: "Convex · Postgres", bar: "bg-muted-foreground/40" },
  { key: "postgres", label: "bunvex · Postgres", bar: "bg-info" },
  { key: "sqlite", label: "bunvex · SQLite", bar: "bg-info/60" },
] as const satisfies { key: keyof BenchRow; label: string; bar: string }[];

/** The leading number of a cell ("2 119" → 2119, "5 % · 3.2 s" → 5); 0 when it has none ("OOM (6.7 GB)"). */
const leading = (cell: string) => {
  const n = Number(cell.split(/[%·]/)[0]!.replaceAll(" ", ""));
  return Number.isFinite(n) ? n : 0;
};

export function Benchmarks() {
  return (
    <Section id="benchmarks" title="Measured against Convex">
      <p className="max-w-2xl text-muted-foreground">
        {BENCH.caption} <span>{BENCH.reading}</span>
      </p>
      {/* One table for every width: below md each row stacks into a block whose cells carry their column's
          label (data-label), so the bunvex columns never scroll out of view on a phone. */}
      <div className="mt-8">
        <table className="w-full border-collapse text-sm max-md:block">
          <thead className="max-md:sr-only">
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-3 pr-4 font-medium">
                Workload
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" className="px-4 py-3 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-md:block">
            {BENCH.rows.map((row) => {
              const max = Math.max(...COLUMNS.map((c) => leading(row[c.key])));
              return (
                <tr key={row.metric} className="border-b border-border max-md:block max-md:py-4">
                  <th
                    scope="row"
                    className="py-4 pr-4 text-left font-normal text-muted-foreground max-md:block max-md:py-0 max-md:pb-2"
                  >
                    {row.metric}
                  </th>
                  {COLUMNS.map((c) => (
                    <td
                      key={c.key}
                      data-label={c.label}
                      className="px-4 py-4 text-right align-top max-md:grid max-md:grid-cols-[1fr_auto] max-md:gap-x-4 max-md:px-0 max-md:py-1.5 max-md:before:text-left max-md:before:text-xs max-md:before:content-[attr(data-label)]"
                    >
                      <span className="font-mono tabular-nums">{row[c.key]}</span>
                      <span aria-hidden="true" className="mt-2 block h-1.5 bg-muted max-md:col-span-2 max-md:mt-1">
                        <span
                          className={`ml-auto block h-full ${c.bar}`}
                          style={{ width: `${Math.max(2, (leading(row[c.key]) / max) * 100)}%` }}
                        />
                      </span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-6 text-sm">
        <a href={BENCH.report} className="underline underline-offset-4">
          Read the full report
        </a>{" "}
        <span className="text-muted-foreground">— hardware, harness and every run.</span>
      </p>
    </Section>
  );
}
