// The Logs histogram (UI-01 §22.4): the loaded lines' volume over time, one column per bucket, stacked by
// outcome — success in a neutral ink, warnings amber, failures red, each named in the legend with an icon, so
// colour is never the only signal. Hover (or focus and the arrows) tells a bucket's counts; dragging across
// the strip — or Shift+arrows, then Enter — picks a time window, which filters the list and goes into the
// URL; "Clear selection" (or Escape) puts every time back. The time range preset is drawn as a band. A table
// with the same numbers is there for assistive tech. Counted on the client, over the loaded lines (STUDY-12 L2).
import { Button } from "@bunvex/ui/components/button";
import { cn } from "@bunvex/ui/lib/utils";
import { CircleCheck, CircleX, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";
import {
  type Bucket,
  bucketize,
  fractionOf,
  histogramDomain,
  OUTCOME_LABEL,
  OUTCOMES,
  type Outcome,
  windowFromDrag,
} from "./histogram-data.ts";
import { RANGE_LABEL, RANGES, type RangePreset, type TimeWindow } from "./log-filter.ts";

// Warnings and failures stacked side by side must be told apart by every reader: these steps pass the
// dataviz palette checks (colour-vision separation ΔE ≥ 8, the normal-vision floor, the lightness band) on
// each theme's surface, which the text tokens (--color-warning, --color-destructive) alone do not. Success is
// neutral ink, so failures stand out; the legend, the tooltip and the table name every outcome in words.
const FILL: Record<Outcome, string> = {
  ok: "bg-muted-foreground/45",
  warn: "bg-[#d99a00] dark:bg-[#c7850f]",
  error: "bg-[#b00c15] dark:bg-[#d9363e]",
};

const ICON: Record<Outcome, ReactNode> = {
  ok: <CircleCheck className="size-3.5 text-muted-foreground" aria-hidden="true" />,
  warn: <TriangleAlert className="size-3.5 text-warning" aria-hidden="true" />,
  error: <CircleX className="size-3.5 text-destructive" aria-hidden="true" />,
};

const pad = (n: number) => String(n).padStart(2, "0");
/** "12:04:05" in the viewer's zone. */
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const describeWindow = (w: TimeWindow) => `${clock(w.from)} – ${clock(w.to)}`;

function bucketText(b: Bucket) {
  const parts = OUTCOMES.filter((o) => b[o] > 0).map((o) => `${formatCount(b[o])} ${OUTCOME_LABEL[o].toLowerCase()}`);
  return `${describeWindow(b)}: ${parts.length ? parts.join(", ") : "no lines"}`;
}

export function LogHistogram(props: {
  /** The lines to count: the loaded ones, under every filter but time. */
  lines: LogEntry[];
  now: number;
  range: RangePreset | "all";
  window?: TimeWindow;
  onWindow: (w: TimeWindow | undefined) => void;
}) {
  const { now, range } = props;
  const presetStart = range === "all" ? undefined : now - RANGES[range];
  const span = histogramDomain(props.lines, now, presetStart ?? props.window?.from);
  const from = span?.from;
  const to = span?.to;
  // the same buckets until the lines or the span change (`now` moves only every few seconds)
  const [domain, buckets] = useMemo(() => {
    const d = from !== undefined && to !== undefined ? { from, to } : null;
    return [d, d ? bucketize(props.lines, d) : []] as const;
  }, [props.lines, from, to]);
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const totals = useMemo(() => {
    const t: Record<Outcome, number> = { ok: 0, warn: 0, error: 0 };
    for (const b of buckets) for (const o of OUTCOMES) t[o] += b[o];
    return t;
  }, [buckets]);

  const plot = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // the keyboard's place: a bucket, and where a Shift+arrow selection started
  const [cursor, setCursor] = useState<{ at: number; anchor: number | null } | null>(null);
  const tableId = useId();
  const helpId = useId();

  const fractionAt = (clientX: number) => {
    const r = plot.current?.getBoundingClientRect();
    return r && r.width > 0 ? (clientX - r.left) / r.width : 0;
  };
  const bucketAt = (f: number) => Math.min(buckets.length - 1, Math.max(0, Math.floor(f * buckets.length)));

  const shown = drag && domain ? windowFromDrag(domain, drag.a, drag.b) : props.window;
  const keyRange =
    cursor && cursor.anchor !== null ? [Math.min(cursor.at, cursor.anchor), Math.max(cursor.at, cursor.anchor)] : null;
  const tip = hover ?? cursor?.at ?? null;

  if (!domain) {
    return (
      <div className="flex min-h-24 items-center border-b px-4 text-sm text-muted-foreground md:px-6">
        No lines loaded to chart yet.
      </div>
    );
  }

  return (
    <section aria-label="Log volume over time" className="border-b px-4 pt-2 pb-1.5 md:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {OUTCOMES.map((o) => (
            <li key={o} className="flex items-center gap-1">
              {ICON[o]}
              <span>{OUTCOME_LABEL[o]}</span>
              <span className="text-muted-foreground tabular-nums">{formatCount(totals[o])}</span>
            </li>
          ))}
        </ul>
        <span className="ml-auto flex min-h-7 items-center gap-2 text-muted-foreground">
          {props.window ? (
            <>
              <span>
                Window <span className="font-mono text-foreground tabular-nums">{describeWindow(props.window)}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => props.onWindow(undefined)}>
                <X aria-hidden="true" />
                Clear selection
              </Button>
            </>
          ) : range !== "all" ? (
            <span>{RANGE_LABEL[range]}</span>
          ) : (
            <span className="hidden sm:inline">Drag across the chart to pick a time window</span>
          )}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a chart with keyboard brushing has no HTML element; the table below carries the data */}
      <div
        ref={plot}
        role="application"
        aria-roledescription="histogram"
        aria-label="Log lines per time bucket"
        aria-describedby={`${helpId} ${tableId}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" takes the arrows (keyboard brushing)
        tabIndex={0}
        data-slot="log-histogram"
        className="relative mt-1.5 h-14 cursor-crosshair touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const f = fractionAt(e.clientX);
          setDrag({ a: f, b: f });
        }}
        onPointerMove={(e) => {
          const f = fractionAt(e.clientX);
          if (drag) setDrag({ ...drag, b: f });
          setHover(bucketAt(f));
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          if (!drag) return;
          const w = windowFromDrag(domain, drag.a, fractionAt(e.clientX));
          setDrag(null);
          // a click without a drag picks its bucket
          const b = buckets[bucketAt(drag.a)];
          props.onWindow(w ?? (b && b.total > 0 ? { from: Math.floor(b.from), to: Math.ceil(b.to) } : props.window));
        }}
        onKeyDown={(e) => {
          const at = cursor?.at ?? buckets.length - 1;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
            e.preventDefault();
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? buckets.length - 1
                  : Math.min(buckets.length - 1, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)));
            setCursor({ at: next, anchor: e.shiftKey ? (cursor?.anchor ?? at) : null });
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const [lo, hi] = keyRange ?? [at, at];
            props.onWindow({ from: Math.floor(buckets[lo]!.from), to: Math.ceil(buckets[hi]!.to) });
            setCursor({ at, anchor: null });
          } else if (e.key === "Escape" && (props.window || keyRange)) {
            e.preventDefault();
            setCursor(cursor && { at: cursor.at, anchor: null });
            props.onWindow(undefined);
          }
        }}
        onBlur={() => setCursor(null)}
      >
        {presetStart !== undefined && !props.window && (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 right-0 border-l border-dashed border-foreground/30 bg-foreground/[0.04]"
            style={{ left: `${fractionOf(domain, presetStart) * 100}%` }}
          />
        )}
        <div aria-hidden="true" className="absolute inset-0 flex items-end gap-[2px] border-b border-border">
          {buckets.map((b, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positions
              key={i}
              data-bucket={i}
              className={cn(
                "flex h-full min-w-0 flex-1 flex-col-reverse gap-[2px]",
                (tip === i || (keyRange && i >= keyRange[0] && i <= keyRange[1])) && "bg-foreground/[0.06]",
              )}
            >
              {OUTCOMES.map((o) =>
                b[o] > 0 ? (
                  <div
                    key={o}
                    data-outcome={o}
                    className={cn("w-full shrink-0 first:rounded-none last:rounded-t-[2px]", FILL[o])}
                    style={{ height: `max(2px, calc(${(b[o] / max) * 100}% - 2px))` }}
                  />
                ) : null,
              )}
            </div>
          ))}
        </div>
        {shown && (
          <div
            aria-hidden="true"
            data-slot="log-histogram-window"
            className="absolute inset-y-0 border-x-2 border-ring bg-ring/15"
            style={{
              left: `${fractionOf(domain, shown.from) * 100}%`,
              right: `${(1 - fractionOf(domain, shown.to)) * 100}%`,
            }}
          />
        )}
        {tip !== null && buckets[tip] && !drag && (
          <div
            role="tooltip"
            className={cn(
              "pointer-events-none absolute top-full z-20 mt-1 border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md",
              tip > buckets.length / 2 ? "-translate-x-full" : "",
            )}
            style={{ left: `${((tip + 0.5) / buckets.length) * 100}%` }}
          >
            <div className="font-mono tabular-nums">{describeWindow(buckets[tip])}</div>
            {buckets[tip].total === 0 ? (
              <div className="text-muted-foreground">No lines</div>
            ) : (
              OUTCOMES.filter((o) => buckets[tip]![o] > 0).map((o) => (
                <div key={o} className="flex items-center gap-1">
                  {ICON[o]}
                  {OUTCOME_LABEL[o]}
                  <span className="ml-auto pl-3 tabular-nums">{formatCount(buckets[tip]![o])}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div
        aria-hidden="true"
        className="mt-0.5 flex justify-between font-mono text-[10px] text-muted-foreground tabular-nums"
      >
        <span>{clock(domain.from)}</span>
        <span className="hidden sm:inline">{clock((domain.from + domain.to) / 2)}</span>
        <span>{clock(domain.to)}</span>
      </div>
      <p id={helpId} className="sr-only">
        Left and Right move between buckets, Shift extends a selection, Enter filters the list to it, Escape clears it.
      </p>
      {/* in a box: a table is never shorter than its rows, so `sr-only` on it would still stretch the page */}
      <div className="sr-only">
        <table id={tableId}>
          <caption>Log lines per time bucket (buckets with lines)</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {OUTCOMES.map((o) => (
                <th key={o} scope="col">
                  {OUTCOME_LABEL[o]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets
              .filter((b) => b.total > 0)
              .map((b) => (
                <tr key={b.from}>
                  <th scope="row">{describeWindow(b)}</th>
                  {OUTCOMES.map((o) => (
                    <td key={o}>{b[o]}</td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <span className="sr-only" aria-live="polite">
        {cursor ? bucketText(buckets[cursor.at]!) : ""}
      </span>
    </section>
  );
}
