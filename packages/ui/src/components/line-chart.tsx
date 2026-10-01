// Lines over time, for metrics (UI-01 §18). One y-axis from zero (these are magnitudes), thin 2 px lines
// that break where a bucket has no value, a recessive grid, and a crosshair with every series' value at the
// hovered bucket — by pointer, or by keyboard (the chart is focusable: Left / Right / Home / End). Identity
// is never colour alone: two or more series get a legend, and with `directLabels` each line is labelled at
// its end. The numbers are always available as a table ("Show as table"). Colours are tokens
// (`--series-1…5`, `--series-other`, `--series-p50…p99`), stepped for each theme.
import { cn } from "@bunvex/ui/lib/utils";
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from "react";

export type ChartPoint = { time: number; value: number | null };
export type ChartSeries = {
  id: string;
  label: string;
  points: ChartPoint[];
  /** A token: "series-1" … "series-5", "series-other", "series-p50" … "series-p99". */
  color: string;
};

type LineChartProps = {
  /** The accessible name, e.g. "Function calls per minute, last hour". */
  label: string;
  series: ChartSeries[];
  formatValue?: (v: number) => string;
  formatTime?: (t: number) => string;
  /** The axis' top, e.g. 100 for percentages; otherwise from the data. */
  max?: number;
  /** Label each line at its end (short labels, at most four series). */
  directLabels?: boolean;
  /** Said instead of a chart when no series has a value. */
  empty?: string;
  height?: number;
  className?: string;
};

const PAD = { top: 8, right: 12, bottom: 22, left: 44 };
const LABEL_WIDTH = 44;

const defaultTime = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** Round tick steps for 0…max: the smallest 1, 2 or 5 × 10ⁿ giving at most four intervals. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toPrecision(12));
}

/** Each line's path, broken where a value is missing. */
function pathOf(points: ChartPoint[], x: (i: number) => number, y: (v: number) => number): string {
  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    if (p.value === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function LineChart(props: LineChartProps) {
  const { series, formatValue = (v) => v.toLocaleString(), formatTime = defaultTime } = props;
  const height = props.height ?? 180;
  const box = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(480);
  const [at, setAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setWidth(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const times = series[0]?.points.map((p) => p.time) ?? [];
  const n = times.length;
  const values = series.flatMap((s) => s.points.flatMap((p) => (p.value === null ? [] : [p.value])));
  if (n === 0 || values.length === 0)
    return (
      <p className={cn("flex items-center text-sm text-muted-foreground", props.className)} style={{ height }}>
        {props.empty ?? "No data in this window."}
      </p>
    );

  const ticks = niceTicks(props.max ?? Math.max(...values));
  const top = ticks.at(-1)!;
  const right = PAD.right + (props.directLabels ? LABEL_WIDTH : 0);
  const plotW = Math.max(1, width - PAD.left - right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const xTicks = n <= 1 ? [0] : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];

  // direct labels at each line's last value, nudged apart so they never overlap
  const ends = props.directLabels
    ? series
        .map((s) => {
          const last = [...s.points].reverse().find((p) => p.value !== null);
          return { s, y: last ? y(last.value!) : null };
        })
        .filter((e): e is { s: ChartSeries; y: number } => e.y !== null)
        .sort((a, b) => a.y - b.y)
        // each at least a line below the one above it, as already moved
        .reduce<{ s: ChartSeries; y: number }[]>(
          (placed, e) => [...placed, { ...e, y: Math.max(e.y, (placed.at(-1)?.y ?? -Infinity) + 12) }],
          [],
        )
    : [];

  const move = (e: PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left - PAD.left) / plotW;
    setAt(Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))));
  };
  const key = (e: KeyboardEvent<HTMLElement>) => {
    const next =
      e.key === "ArrowRight"
        ? Math.min(n - 1, (at ?? -1) + 1)
        : e.key === "ArrowLeft"
          ? Math.max(0, (at ?? n) - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : e.key === "Escape"
                ? null
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setAt(next);
  };
  const readout =
    at === null
      ? ""
      : `${formatTime(times[at]!)}: ${series
          .map((s) => `${s.label} ${s.points[at]?.value == null ? "no data" : formatValue(s.points[at]!.value!)}`)
          .join(", ")}`;

  return (
    <div className={cn("flex flex-col gap-2", props.className)}>
      <figure
        ref={box}
        aria-label={props.label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is explored with the arrow keys
        tabIndex={0}
        className="relative m-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ height }}
        onPointerMove={move}
        onPointerLeave={() => setAt(null)}
        onKeyDown={key}
        onBlur={() => setAt(null)}
        data-slot="line-chart"
      >
        <svg width={width} height={height} aria-hidden="true" className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="stroke-border" />
              <text
                x={PAD.left - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {formatValue(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 6}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[10px]"
            >
              {formatTime(times[i]!)}
            </text>
          ))}
          {series.map((s) => (
            <path
              key={s.id}
              d={pathOf(s.points, x, y)}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ stroke: `var(--${s.color})` }}
            />
          ))}
          {ends.map((e) => (
            <text key={e.s.id} x={PAD.left + plotW + 6} y={e.y} dy="0.32em" className="fill-foreground text-[10px]">
              {e.s.label}
            </text>
          ))}
          {at !== null && (
            <g>
              <line x1={x(at)} x2={x(at)} y1={PAD.top} y2={PAD.top + plotH} className="stroke-muted-foreground" />
              {series.map((s) =>
                s.points[at]?.value == null ? null : (
                  <circle
                    key={s.id}
                    cx={x(at)}
                    cy={y(s.points[at]!.value!)}
                    r={4}
                    strokeWidth={2}
                    className="stroke-card"
                    style={{ fill: `var(--${s.color})` }}
                  />
                ),
              )}
            </g>
          )}
        </svg>
        {at !== null && (
          <div
            className={cn(
              "pointer-events-none absolute top-1 z-10 min-w-36 border bg-popover px-2 py-1 text-xs shadow-sm",
              x(at) > width / 2 ? "-translate-x-full" : "",
            )}
            style={{ left: x(at) + (x(at) > width / 2 ? -8 : 8) }}
          >
            <p className="mb-1 font-medium">{formatTime(times[at]!)}</p>
            <ul>
              {series.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-2 shrink-0" style={{ background: `var(--${s.color})` }} />
                  <span className="truncate text-muted-foreground">{s.label}</span>
                  <span className="ml-auto pl-2 tabular-nums">
                    {s.points[at]?.value == null ? "—" : formatValue(s.points[at]!.value!)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {readout}
        </span>
      </figure>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={`${props.label}: legend`}>
          {series.map((s) => (
            <li key={s.id} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true" className="h-0.5 w-3 shrink-0" style={{ background: `var(--${s.color})` }} />
              <span className="truncate text-muted-foreground">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
      <details className="text-xs">
        <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full border-collapse tabular-nums">
            <caption className="sr-only">{props.label}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Time
                </th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="py-1 pr-3 font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((t, i) => (
                <tr key={t} className="border-b last:border-0">
                  <th scope="row" className="py-0.5 pr-3 text-left font-normal text-muted-foreground">
                    {formatTime(t)}
                  </th>
                  {series.map((s) => (
                    <td key={s.id} className="py-0.5 pr-3">
                      {s.points[i]?.value == null ? "—" : formatValue(s.points[i]!.value!)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export { LineChart };
