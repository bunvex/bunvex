import { BENCH, type BenchRow } from "../content.ts";
import { Section } from "./section.tsx";
import { Tabs } from "./tabs.tsx";

/** The leading number of a cell ("2 119" → 2119, "5 % · 3.2 s" → 5); 0 when it has none ("OOM (6.7 GB)"). */
export const leading = (cell: string) => {
  const n = Number(cell.split(/[%·]/)[0]!.replaceAll(" ", ""));
  return Number.isFinite(n) ? n : 0;
};

/** How many times bunvex on Postgres beats Convex on the same Postgres, one decimal; "" without a number. */
export const speedup = (row: BenchRow) => {
  const convex = leading(row.convex);
  return convex ? `${(leading(row.postgres) / convex).toFixed(1)}×` : "";
};

const SERIES = [
  { key: "convex", who: "Convex", where: "self-hosted · Postgres", bar: "bg-line text-ink" },
  { key: "postgres", who: "bunvex", where: "Postgres", bar: "bg-honey text-honey-ink" },
  { key: "sqlite", who: "bunvex", where: "SQLite", bar: "bg-honey/55 text-ink" },
] as const satisfies { key: keyof BenchRow; who: string; where: string; bar: string }[];

/** The strip under the hero: the speed-ups, and the fan-out run Convex could not finish. */
export function Proof() {
  const [read, insert, action, , fanout] = BENCH.rows;
  const cells = [
    [speedup(read!), "uncached indexed reads"],
    [speedup(insert!), "durable inserts"],
    [speedup(action!), "actions (query + mutation)"],
    ["10 000", `subscribers served where Convex ran out of memory ${fanout!.convex.replace("OOM ", "")}`],
  ];
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <ul
        className="m-0 grid list-none grid-cols-2 border-y border-line p-0 lg:grid-cols-4"
        aria-label="bunvex against Convex self-hosted"
      >
        {cells.map(([big, small], i) => (
          <li
            key={small}
            className={`px-5 py-6 ${i % 2 ? "border-l border-line" : ""} ${i >= 2 ? "max-lg:border-t lg:border-l" : ""}`}
          >
            <b className="block font-display text-[40px] leading-none font-extrabold tracking-tight text-honey">
              {big}
            </b>
            <span className="mt-2 block text-sm text-soft">{small}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[13.5px] text-dim">
        Against Convex self-hosted on the same 2-vCPU VPS and the same Postgres, 5 Oct 2026.
      </p>
    </div>
  );
}

export function Benchmarks() {
  return (
    <Section
      id="benchmarks"
      kicker="Benchmarks"
      title="Same machine. Same database. Same harness."
      lede="Convex self-hosted and bunvex, both on one Postgres 17 instance, driven by the same load generator. bunvex on its built-in SQLite for reference."
    >
      <Tabs
        label="Workload"
        vertical
        className="grid gap-9 md:grid-cols-[250px_minmax(0,1fr)]"
        listClassName="flex gap-1 max-md:overflow-x-auto md:flex-col"
        tabClassName={(on) =>
          `rounded-[10px] border px-3.5 py-2.5 text-left text-[15px] whitespace-nowrap ${
            on ? "border-line bg-surface text-ink" : "border-transparent text-soft hover:text-ink"
          }`
        }
        tabs={BENCH.rows.map((row, i) => ({
          id: `w${i}`,
          label: (
            <>
              {BENCH.tabs[i]}
              <small className="block font-mono text-[11.5px] text-dim">
                {speedup(row) ? `${speedup(row)} faster` : "OOM vs 100 %"}
              </small>
            </>
          ),
          panel: <Workload row={row} />,
        }))}
      />
      <p className="mt-6 max-w-[70ch] text-[13.5px] text-dim">
        {BENCH.caption} {BENCH.reading}{" "}
        <a href={BENCH.report} className="text-soft underline underline-offset-4 hover:text-ink">
          Read the full report
        </a>{" "}
        — hardware, harness and every run.
      </p>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-soft hover:text-ink">Every number in one table</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-soft">
                <th scope="col" className="py-2 pr-4 font-normal">
                  Workload
                </th>
                {SERIES.map((s) => (
                  <th key={s.key} scope="col" className="px-3 py-2 text-right font-normal">
                    {s.who} · {s.where.replace("self-hosted · ", "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BENCH.rows.map((row) => (
                <tr key={row.metric} className="border-b border-line">
                  <th scope="row" className="py-2 pr-4 text-left font-normal text-soft">
                    {row.metric}
                  </th>
                  {SERIES.map((s) => (
                    <td key={s.key} className="px-3 py-2 text-right tabular-nums">
                      {row[s.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Section>
  );
}

function Workload({ row }: { row: BenchRow }) {
  const max = Math.max(...SERIES.map((s) => leading(row[s.key])));
  const up = speedup(row);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3.5">
        <span className="font-display text-[54px] leading-none font-extrabold text-honey">{up || "OOM → 100 %"}</span>
        <span className="text-[13.5px] text-dim">
          {up
            ? `bunvex on Postgres against Convex on the same Postgres, ${row.metric}`
            : "Convex ran out of memory; bunvex delivered every update"}
        </span>
      </div>
      {SERIES.map((s) => {
        const value = leading(row[s.key]);
        const oom = value === 0;
        return (
          <div
            key={s.key}
            className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-3.5 sm:grid-cols-[170px_minmax(0,1fr)]"
          >
            <div className="text-[14.5px]">
              {s.who}
              <small className="block font-mono text-[11.5px] text-dim">{s.where}</small>
            </div>
            <div className="h-[34px]">
              <div
                data-bar={s.key}
                style={{ width: oom ? "100%" : `${Math.max(14, (value / max) * 100)}%` }}
                className={`flex h-full origin-left animate-[site-grow_.6s_cubic-bezier(.2,.8,.2,1)] items-center rounded-md px-2.5 font-mono text-[13px] font-medium whitespace-nowrap ${
                  oom ? "border border-dashed border-bad text-bad" : `justify-end ${s.bar}`
                }`}
              >
                {oom ? "out of memory" : row[s.key]}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
