// Turn k6's summary export into the HTTP table the earlier Mac and VPS reports printed.

export type Point = { scenario: string; vus: number; rate: number; errors: number };

/** k6 `--summary-export`: counters and rates live under `metrics.<name>.values`. */
export type SummaryExport = {
  metrics?: {
    http_reqs?: { values?: { rate?: number } };
    bench_errors?: { values?: { rate?: number } };
  };
};

export const SCENARIOS: readonly (readonly [id: string, label: string])[] = [
  ["cached", "query, cached"],
  ["uncached", "query, uncached"],
  ["insert", "insert, durable"],
  ["increment1000", "increment, 1 000 keys"],
  ["increment1", "increment, 1 key"],
  ["action", "action"],
  ["mix", "mix 90/10"],
];

const LABELS = new Map(SCENARIOS.map(([id, label]) => [id, label]));

export function scenarioLabel(id: string): string {
  const label = LABELS.get(id);
  if (label === undefined) throw new Error(`unknown scenario ${id}`);
  return label;
}

/** More than 1% of calls failed: the mark the published tables use. */
export const ERROR_MARK = 0.01;

export function pointFromSummary(summary: SummaryExport, scenario: string, vus: number): Point {
  const rate = summary.metrics?.http_reqs?.values?.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate)) throw new Error("k6 summary has no http_reqs rate");
  const errors = summary.metrics?.bench_errors?.values?.rate ?? 0;
  if (typeof errors !== "number" || !Number.isFinite(errors)) throw new Error("k6 summary has no bench_errors rate");
  return { scenario, vus, rate, errors };
}

/** The fastest of the VU levels. Ties keep the earlier point. */
export function bestPoint(points: readonly Point[]): Point | undefined {
  return points.reduce<Point | undefined>(
    (best, point) => (best === undefined || point.rate > best.rate ? point : best),
    undefined,
  );
}

/** Grouped thousands, as the published tables write them (`36 495`). */
export function formatReq(rate: number): string {
  return Math.round(rate)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatCell(point: Point | undefined): string {
  if (point === undefined) return "—";
  return point.errors > ERROR_MARK ? `${formatReq(point.rate)} ⚠` : formatReq(point.rate);
}

export function markdownTable(
  stores: readonly string[],
  rows: readonly { label: string; cells: readonly (Point | undefined)[] }[],
): string {
  const head = `| scenario | ${stores.join(" | ")} |`;
  const rule = `|---|${stores.map(() => "--:").join("|")}|`;
  const body = rows.map((row) => `| ${row.label} | ${row.cells.map((cell) => formatCell(cell)).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}
