// A heatmap of rates over time (UI-01 §18.4), as Convex's `CategoricalHeatmap.tsx`: a row per category (a
// function), a cell per time bucket, the colour saying how much — five steps of one hue (`--heat-1…5`, validated
// as an ordinal ramp in both themes: monotone, visibly stepped, the faintest still 2:1 on the surface), with the
// faintest for "little" and the darkest for "a lot" of whatever the caller measures. A bucket with no value is
// an empty, dashed cell — "no data" never reads as zero. It is a real table (rows, column headers by time, each
// cell's value in text for screen readers), and the hovered cell's value is said in a line under it; a legend
// names the steps' ranges.
import { cn } from "@bunvex/ui/lib/utils";
import { useState } from "react";

export type HeatmapRow = { id: string; label: string; cells: (number | null)[] };

type HeatmapProps = {
  /** The table's accessible name, e.g. "Failure rate per function, per minute, last hour". */
  label: string;
  rows: HeatmapRow[];
  /** Each column's start, ms. */
  times: number[];
  /** Maps a value to 0…1, how intense it is (e.g. a failure rate / 100, or 1 − hit rate / 100). */
  intensity: (v: number) => number;
  formatValue: (v: number) => string;
  /** What the darkest end means and the faintest, for the legend: e.g. ["0%", "100% failed"]. */
  legend: [string, string];
  formatTime?: (t: number) => string;
  empty?: string;
  className?: string;
};

const STEPS = 5;
/** The step (1…5) a value's intensity falls in. */
export const heatStep = (intensity: number) =>
  Math.min(STEPS, Math.max(1, Math.floor(Math.min(1, Math.max(0, intensity)) * STEPS) + 1));

const defaultTime = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function Heatmap(props: HeatmapProps) {
  const fmtTime = props.formatTime ?? defaultTime;
  const [hover, setHover] = useState<{ row: number; col: number }>();
  if (props.rows.length === 0)
    return <p className="py-6 text-center text-sm text-muted-foreground">{props.empty ?? "No data."}</p>;
  const h = hover && props.rows[hover.row];
  const hv = h?.cells[hover!.col];
  // every few columns gets a time label, so they never collide
  const every = Math.max(1, Math.ceil(props.times.length / 6));
  return (
    <div data-slot="heatmap" className={cn("flex min-w-0 flex-col gap-2", props.className)}>
      <div className="overflow-x-auto">
        <table
          aria-label={props.label}
          className="w-full table-fixed border-separate border-spacing-0.5 text-xs"
          onPointerLeave={() => setHover(undefined)}
        >
          <colgroup>
            <col className="w-36" />
            {props.times.map((t) => (
              <col key={t} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Function
              </th>
              {props.times.map((t, i) => (
                <th
                  key={t}
                  scope="col"
                  className="h-4 overflow-visible text-left font-normal whitespace-nowrap text-muted-foreground"
                >
                  <span className={i % every === 0 ? "" : "sr-only"}>{fmtTime(t)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, r) => (
              <tr key={row.id}>
                <th scope="row" className="truncate pr-2 text-left font-mono font-normal" title={row.label}>
                  {row.label}
                </th>
                {row.cells.map((v, c) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: a column is its position in time
                    key={c}
                    data-step={v === null ? undefined : heatStep(props.intensity(v))}
                    onPointerEnter={() => setHover({ row: r, col: c })}
                    style={v === null ? undefined : { background: `var(--heat-${heatStep(props.intensity(v))})` }}
                    className={cn(
                      "h-5 p-0",
                      v === null && "border border-dashed border-border",
                      hover?.row === r && hover.col === c && "outline-2 outline-foreground -outline-offset-1",
                    )}
                  >
                    <span className="sr-only">{v === null ? "no data" : props.formatValue(v)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {/* the hovered cell, said in text (the colour is never alone) */}
        <span className="min-h-4 tabular-nums" aria-hidden="true">
          {h
            ? `${h.label} at ${fmtTime(props.times[hover!.col]!)}: ${hv === null || hv === undefined ? "no data" : props.formatValue(hv)}`
            : ""}
        </span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          {props.legend[0]}
          {[1, 2, 3, 4, 5].map((s) => (
            <span key={s} className="inline-block size-3" style={{ background: `var(--heat-${s})` }} />
          ))}
          {props.legend[1]}
          <span className="ml-2 inline-block size-3 border border-dashed border-border" /> no data
        </span>
      </div>
    </div>
  );
}

export { Heatmap };
