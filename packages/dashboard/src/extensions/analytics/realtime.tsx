// Analytics → Realtime (UI-01 §26.1): who is here now. The open WebSocket sessions on a world map (bubbles per
// city), the distinct visitors of the last 30 minutes with a per-minute sparkline and their devices, the live
// event feed, and four breakdowns of the last 30 minutes — pages, referrers, countries, browsers — as bars with
// their counts. Live: `watchAnalyticsRealtime`.
import { Sparkline } from "@bunvex/ui/components/sparkline";
import { cn } from "@bunvex/ui/lib/utils";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useQueryScope } from "../../context.tsx";
import { useWatch } from "../../data/live.ts";
import { formatCount, formatPercent } from "../../screens/stats.ts";
import { BAR1 } from "../../shell/bars.ts";
import { ErrorState } from "../../shell/error-state.tsx";
import { type AnalyticsRealtime, type BreakdownRow, DEVICES } from "./data-source.ts";

const WorldMap = lazy(() => import("./world-map.tsx"));

/** MapLibre needs WebGL 2; without it (tests, some VMs) the page lists countries instead of drawing the map. */
const canDrawMap = () => typeof window !== "undefined" && typeof window.WebGL2RenderingContext === "function";

const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 10 ? "just now" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

const CARD = "flex min-w-0 flex-col border bg-background";

/** A breakdown as bars: the bar's length is the share of the top row; numbers in text, never only the bar. */
export function Breakdown(props: { title: string; column: string; rows: BreakdownRow[]; empty?: string }) {
  const max = props.rows[0]?.visitors ?? 1;
  return (
    <section aria-label={props.title} className={CARD}>
      <h2 className="px-4 pt-3 pb-2 text-sm font-medium">{props.title}</h2>
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="px-4 pb-1 text-left font-medium">
              {props.column}
            </th>
            <th scope="col" className="w-20 pb-1 text-right font-medium">
              Visitors
            </th>
            <th scope="col" className="w-20 px-4 pb-1 text-right font-medium">
              Events
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-3 text-muted-foreground">
                {props.empty ?? "Nothing in the last 30 minutes."}
              </td>
            </tr>
          )}
          {props.rows.map((r) => (
            <tr key={r.name}>
              <td className="relative px-4 py-1">
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0.5 left-2 rounded-sm bg-muted"
                  style={{ width: `calc(${(r.visitors / max) * 100}% - 0.5rem)` }}
                />
                <span className="relative block truncate">{r.name}</span>
              </td>
              <td className="text-right font-mono text-xs tabular-nums">{formatCount(r.visitors)}</td>
              <td className="px-4 text-right font-mono text-xs tabular-nums">{formatCount(r.events)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function VisitorsTile({ r }: { r: AnalyticsRealtime }) {
  const total = DEVICES.reduce((n, d) => n + r.devices[d], 0);
  return (
    <section aria-label="Visitors" className="border bg-background/95 p-4 backdrop-blur-sm">
      <h2 className="text-xs text-muted-foreground">Visitors, last 30 minutes</h2>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{formatCount(r.visitorsLast30Min)}</p>
      <Sparkline
        className="mt-2 h-10"
        values={r.perMinute}
        summary={`Visitors per minute over the last 30 minutes: now ${r.perMinute.at(-1) ?? 0}, peak ${Math.max(0, ...r.perMinute)}.`}
        formatValue={(v) => `${v} visitors`}
        pointLabel={(i) => (i === 29 ? "this minute" : `${29 - i} min ago`)}
      />
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {formatCount(r.live.length)} live now (an open connection)
      </p>
      <h3 className="mt-3 text-xs text-muted-foreground">Devices</h3>
      <div aria-hidden="true" className="mt-1 flex h-2 gap-0.5 overflow-hidden rounded-sm">
        {DEVICES.map((d, i) =>
          r.devices[d] > 0 ? (
            <span
              key={d}
              className={cn("h-full", ["bg-foreground", "bg-muted-foreground", "bg-border"][i])}
              style={{ flexGrow: r.devices[d] }}
            />
          ) : null,
        )}
      </div>
      <dl className="mt-1.5 grid grid-cols-3 gap-2 text-xs">
        {DEVICES.map((d) => (
          <div key={d}>
            <dt className="text-muted-foreground capitalize">{d}</dt>
            <dd className="font-medium tabular-nums">{total ? formatPercent(r.devices[d] / total) : "—"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Feed({ r }: { r: AnalyticsRealtime }) {
  return (
    <section aria-label="Live events" className="flex h-full min-h-0 flex-col border bg-background/95 backdrop-blur-sm">
      <h2 className="border-b px-4 py-2 text-xs text-muted-foreground">Live events</h2>
      <ol
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard
        tabIndex={0}
        aria-label="Newest events"
        className="min-h-0 flex-1 divide-y overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {r.recent.slice(0, 12).map((e) => (
          <li key={e.id} className="px-4 py-2">
            <p className="truncate font-mono text-xs">{e.name === "page_view" ? e.path : e.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {ago(r.time, e.time)} · {e.city ?? e.country} · {e.browser}, {e.device}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MapArea({ r }: { r: AnalyticsRealtime }) {
  return (
    <div className="relative min-h-80 min-w-0 flex-1 bg-muted/40">
      {canDrawMap() ? (
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading the map…</p>}>
          <WorldMap live={r.live} />
        </Suspense>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">The map needs WebGL. Visitors by country are listed below.</p>
      )}
    </div>
  );
}

export function RealtimePage({ heading }: { heading: ReactNode }) {
  const { source } = useQueryScope();
  const [r, setR] = useState<AnalyticsRealtime>();
  const error = useWatch<AnalyticsRealtime>((on, onErr) => source.watchAnalyticsRealtime!(on, onErr), setR, [source]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        {heading}
        {r && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatCount(r.live.length)} live · {formatCount(r.visitorsLast30Min)} in 30 min
          </span>
        )}
      </div>
      {error ? (
        <ErrorState error={error} />
      ) : !r ? (
        <p className="p-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* the visitors and the live feed beside the map (above it on a phone) */}
          <div className="flex border-b max-md:flex-col md:h-[min(62svh,580px)]">
            <div className="flex min-h-0 shrink-0 flex-col gap-3 p-3 md:w-80 md:border-r">
              <VisitorsTile r={r} />
              <div className="min-h-0 flex-1 max-md:max-h-72">
                <Feed r={r} />
              </div>
            </div>
            <MapArea r={r} />
          </div>
          <div className="grid gap-3 p-3 md:grid-cols-2 2xl:grid-cols-4">
            <Breakdown title="Pages" column="Path" rows={r.pages} />
            <Breakdown title="Referrers" column="Referrer" rows={r.referrers} />
            <Breakdown title="Countries" column="Country" rows={r.countries} />
            <Breakdown title="Browsers" column="Browser" rows={r.browsers} />
          </div>
        </div>
      )}
    </div>
  );
}
