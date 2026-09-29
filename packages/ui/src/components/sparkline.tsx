// A single-series line over time, for a live metric. The line scales from zero (a rate is a magnitude), is
// drawn in one token colour, and has a hover crosshair with the exact value. Screen readers get `summary`
// (the chart is an image); the numbers it shows must also be available as text next to it.
import { cn } from "@bunvex/ui/lib/utils";
import { type PointerEvent, useState } from "react";

type SparklineProps = {
  values: number[];
  /** The accessible description: what is plotted and its current and peak values. */
  summary: string;
  /** How a value reads in the tooltip, e.g. `(v) => \`${v} commits/s\``. */
  formatValue?: (value: number) => string;
  /** Per-point caption in the tooltip, e.g. "12 s ago". */
  pointLabel?: (index: number) => string;
  className?: string;
};

function Sparkline({ values, summary, formatValue = String, pointLabel, className }: SparklineProps) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const max = Math.max(1e-9, ...values) * 1.1;
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 100 - (v / max) * 100;
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(3)},${y(v).toFixed(3)}`).join("");

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
    setHover(Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))));
  };

  const h = hover !== null && hover < n ? hover : null;
  return (
    <div
      data-slot="sparkline"
      className={cn("relative h-16 w-full touch-none select-none", className)}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full overflow-visible" role="img">
        <title>{summary}</title>
        <line x1="0" x2="100" y1="100" y2="100" className="stroke-border" vectorEffect="non-scaling-stroke" />
        {n > 1 && (
          <path
            d={path}
            fill="none"
            className="stroke-info"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {h !== null && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/40"
            style={{ left: `${x(h)}%` }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-info"
            style={{ left: `${x(h)}%`, top: `${y(values[h]!)}%` }}
          />
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute -top-2 z-10 -translate-y-full border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground tabular-nums shadow-sm",
              x(h) > 50 ? "-translate-x-full" : "",
            )}
            style={{ left: `${x(h)}%` }}
          >
            <span className="font-medium">{formatValue(values[h]!)}</span>
            {pointLabel && <span className="ml-2 text-muted-foreground">{pointLabel(h)}</span>}
          </div>
        </>
      )}
    </div>
  );
}

export { Sparkline };
