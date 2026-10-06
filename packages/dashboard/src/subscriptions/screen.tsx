// The Subscriptions screen (STUDY-131 AD-25, a bunvex addition: Convex has no such view). Which queries are
// live, per session; what each one read (its index ranges, read back to values); why it ran again (its last
// invalidations — the commit, the mutation, the key it wrote — or the reason it ran without one). A second tab
// shows the query cache. "Follow" lists new invalidations as they land while the screen is open. Everything
// that says what is shown lives in the URL: the path filter, the tab, the open query or cache entry. A log
// entry's "why it ran" link (STUDY-131 AD-27) opens a query by its function and arguments' digest, with the
// invalidation that caused the run marked in its history.
import { Button } from "@bunvex/ui/components/button";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Input } from "@bunvex/ui/components/input";
import { cn } from "@bunvex/ui/lib/utils";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { capabilitiesQuery, dashboardKeys, type QueryScope } from "../data/queries.ts";
import {
  type InvalidationEvent,
  type LiveQuery,
  type QueryCacheEntry,
  type QueryHistoryEntry,
  type ReadRange,
  toDataSourceError,
} from "../data-source.ts";
import { formatTime } from "../database/values.ts";
import { type SubscriptionsSearch, subscriptionsRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { BAR_TITLE, BAR1, BAR2, SCREEN } from "../shell/bars.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { Panel } from "../shell/panel.tsx";

/** How many followed invalidations stay listed. */
const FOLLOWED = 50;

const subscriptionsQuery = ({ source, scope }: QueryScope, path: string | undefined) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "subscriptions", path ?? null] as const,
    queryFn: ({ signal }) => source.getSubscriptions!(path ? { path } : {}, { signal }),
    refetchInterval: 5_000,
  });
const queryCacheQuery = ({ source, scope }: QueryScope, path: string | undefined) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "query-cache", path ?? null] as const,
    queryFn: ({ signal }) => source.getQueryCache!(path ? { path } : {}, { signal }),
    refetchInterval: 5_000,
  });

export function SubscriptionsScreen() {
  const { source } = useQueryScope();
  if (typeof source.getSubscriptions !== "function")
    return <NotOffered title="Subscriptions" what="a view of its live queries" />;
  return <Subscriptions />;
}

type Row = LiveQuery & { id: string; session: number; identity: string };
const col = dataTableColumns<Row>();
const cacheCol = dataTableColumns<QueryCacheEntry & { id: string }>();

const REASONS: Record<Extract<QueryHistoryEntry, { kind: "rerun" }>["reason"], string> = {
  newSubscriber: "New subscriber",
  identityChange: "Identity changed",
  codeChange: "New code pushed",
  retry: "Retried (index rebuilding)",
};

/** One line on the newest history entry. */
function lastEvent(h: QueryHistoryEntry | undefined): string {
  if (!h) return "—";
  if (h.kind === "rerun") return REASONS[h.reason];
  return `${h.source ?? "a write"} → ${h.table ?? h.index}`;
}

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function Subscriptions() {
  const scope = useQueryScope();
  const search = subscriptionsRoute.useSearch();
  const navigate = subscriptionsRoute.useNavigate();
  const setSearch = (patch: Partial<SubscriptionsSearch>, replace = false) =>
    navigate({ search: (s: SubscriptionsSearch): SubscriptionsSearch => ({ ...s, ...patch }), replace });
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const allowed = caps?.operations.includes("viewMetrics") ?? true;
  const cacheTab = search.tab === "cache";
  const live = useQuery({
    ...subscriptionsQuery(scope, search.path),
    enabled: allowed && !cacheTab,
    placeholderData: keepPreviousData,
  });
  const cache = useQuery({
    ...queryCacheQuery(scope, search.path),
    enabled: allowed && cacheTab && typeof scope.source.getQueryCache === "function",
    placeholderData: keepPreviousData,
  });
  const [following, setFollowing] = useState(false);
  const [followed, setFollowed] = useState<InvalidationEvent[]>([]);
  const canFollow = typeof scope.source.watchInvalidations === "function";
  const followError = useWatch<InvalidationEvent[]>(
    (onEvents, onError) =>
      following && canFollow && allowed
        ? scope.source.watchInvalidations!({ ...(search.path ? { path: search.path } : {}) }, onEvents, onError)
        : () => {},
    (events) => setFollowed((f) => [...[...events].reverse(), ...f].slice(0, FOLLOWED)),
    [scope.source, following, search.path, allowed],
  );
  const filterId = useId();

  const rows: Row[] =
    live.data?.sessions.flatMap((s, i) =>
      s.queries.map((q) => ({ ...q, id: `${i}:${q.queryId}`, session: i + 1, identity: s.identity })),
    ) ?? [];
  // by its row, or (from a log entry's link) by function and arguments: the session that ran it first
  const byArgs = (r: Row) => r.path === search.path && r.argsDigest === search.args;
  const open =
    search.query !== undefined
      ? (rows.find((r) => r.id === search.query) ?? null)
      : search.args !== undefined
        ? (rows.find((r) => byArgs(r) && !r.cached) ?? rows.find(byArgs) ?? null)
        : undefined;
  const cacheRows = (cache.data?.biggest ?? []).map((e, i) => ({ ...e, id: String(i) }));
  const openEntry = search.entry === undefined ? undefined : (cacheRows.find((r) => r.id === search.entry) ?? null);

  const columns: DataTableColumn<Row>[] = [
    col.accessor((r) => r.path, {
      id: "path",
      header: "Function",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    col.accessor((r) => r.argsDigest, {
      id: "args",
      header: "Args",
      cell: (c) => <span className="font-mono text-xs text-muted-foreground">{c.getValue()}</span>,
    }),
    col.accessor((r) => r.session, { id: "session", header: "Session" }),
    col.accessor((r) => (r.cached ? "cached" : "ran"), {
      id: "cached",
      header: "Result",
      cell: (c) => <span className="text-xs">{c.getValue()}</span>,
    }),
    col.accessor((r) => r.documentsRead, {
      id: "docs",
      header: "Docs read",
      cell: (c) => <span className="block text-right tabular-nums">{formatCount(c.getValue())}</span>,
    }),
    col.accessor((r) => r.bytesRead, {
      id: "bytes",
      header: "Bytes read",
      cell: (c) => <span className="block text-right tabular-nums">{bytes(c.getValue())}</span>,
    }),
    col.accessor((r) => lastEvent(r.history[0]), {
      id: "last",
      header: "Last ran because",
      cell: (c) => <span className="text-xs">{c.getValue()}</span>,
    }),
  ];
  const cacheColumns: DataTableColumn<QueryCacheEntry & { id: string }>[] = [
    cacheCol.accessor((e) => e.path, {
      id: "path",
      header: "Function",
      cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span>,
    }),
    cacheCol.accessor((e) => e.argsDigest, {
      id: "args",
      header: "Args",
      cell: (c) => <span className="font-mono text-xs text-muted-foreground">{c.getValue()}</span>,
    }),
    cacheCol.accessor((e) => (e.shared ? "everyone" : "one caller"), { id: "who", header: "For" }),
    cacheCol.accessor((e) => e.size, {
      id: "size",
      header: "Size",
      cell: (c) => <span className="block text-right tabular-nums">{bytes(c.getValue())}</span>,
    }),
    cacheCol.accessor((e) => e.state, { id: "state", header: "State" }),
  ];

  const error = cacheTab ? cache.error : live.error;
  return (
    <div className={SCREEN}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>Subscriptions</h1>
          {allowed && live.data && !cacheTab && (
            <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
              {`${formatCount(live.data.totals.queries)} live ${live.data.totals.queries === 1 ? "query" : "queries"} in ${formatCount(live.data.totals.sessions)} ${live.data.totals.sessions === 1 ? "session" : "sessions"}`}
            </span>
          )}
          {allowed && canFollow && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              aria-pressed={following}
              onClick={() => setFollowing((f) => !f)}
            >
              {following ? "Following invalidations" : "Follow invalidations"}
            </Button>
          )}
        </div>
        {!allowed ? (
          <p className="p-4 text-sm text-muted-foreground md:p-6">This credential cannot view metrics.</p>
        ) : (
          <>
            <div className={BAR2}>
              <label htmlFor={filterId} className="sr-only">
                Filter by function
              </label>
              <Input
                id={filterId}
                type="search"
                className="h-7 w-64"
                placeholder="Filter by function path"
                defaultValue={search.path ?? ""}
                onChange={(e) =>
                  setSearch(
                    {
                      path: e.target.value || undefined,
                      query: undefined,
                      entry: undefined,
                      args: undefined,
                      seq: undefined,
                    },
                    true,
                  )
                }
              />
              <fieldset className="flex gap-1" aria-label="View">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={!cacheTab}
                  onClick={() => setSearch({ tab: undefined, entry: undefined })}
                >
                  Live queries
                </Button>
                {typeof scope.source.getQueryCache === "function" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={cacheTab}
                    onClick={() => setSearch({ tab: "cache", query: undefined, args: undefined, seq: undefined })}
                  >
                    Query cache
                  </Button>
                )}
              </fieldset>
              {live.data && !cacheTab && (
                <span className="text-xs text-muted-foreground">
                  {live.data.historySize === 0
                    ? "Invalidation history is off on this deployment."
                    : `The last ${live.data.historySize} runs are kept per query.`}
                </span>
              )}
            </div>
            {following && (
              <section
                aria-label="Followed invalidations"
                className="max-h-48 overflow-y-auto border-b px-4 py-2 md:px-6"
              >
                {followError && <ErrorState error={followError} />}
                {followed.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Waiting for an invalidation…</p>
                ) : (
                  <ul className="flex flex-col gap-1 font-mono text-xs">
                    {followed.map((e) => (
                      <li key={e.seq}>
                        <span className="text-muted-foreground">{formatTime(e.at)}</span> ts {e.commitTs} ·{" "}
                        {e.source ?? "a write"} wrote {e.index} {e.key.text} → {e.path}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {error ? (
              <ErrorState error={toDataSourceError(error)} />
            ) : cacheTab ? (
              <>
                {cache.data && <CacheCounters c={cache.data} />}
                <DataTable
                  label="Query cache entries"
                  fill
                  columns={cacheColumns}
                  data={cacheRows}
                  getRowId={(e) => e.id}
                  grid={{ activateOnClick: true, onCellActivate: (e) => setSearch({ entry: e.id }) }}
                  empty={cache.isPending ? "Loading…" : "The query cache is empty."}
                />
              </>
            ) : (
              <DataTable
                label="Live queries"
                fill
                className={cn(live.isPlaceholderData && "opacity-60")}
                columns={columns}
                data={rows}
                getRowId={(r) => r.id}
                defaultColumnWidth={(id) => ({ path: 200, last: 240 })[id] ?? 110}
                grid={{
                  activateOnClick: true,
                  onCellActivate: (r) => setSearch({ query: r.id, args: undefined, seq: undefined }),
                }}
                empty={
                  live.isPending
                    ? "Loading…"
                    : search.path
                      ? "No live query matches."
                      : "No client is subscribed to a query."
                }
              />
            )}
          </>
        )}
      </div>
      {open !== undefined && (
        <Panel
          kind="subscription"
          title="Live query"
          focusOnOpen={false}
          onClose={() => setSearch({ query: undefined, args: undefined, seq: undefined })}
        >
          {open === null ? (
            <p className="text-sm text-muted-foreground">
              {live.isPending ? "Loading…" : "This query is no longer live."}
            </p>
          ) : (
            <QueryDetails q={open} mark={search.query === undefined ? search.seq : undefined} />
          )}
        </Panel>
      )}
      {openEntry !== undefined && (
        <Panel
          kind="subscription"
          title="Cache entry"
          focusOnOpen={false}
          onClose={() => setSearch({ entry: undefined })}
        >
          {openEntry === null ? (
            <p className="text-sm text-muted-foreground">This entry is no longer cached.</p>
          ) : (
            <div className="flex flex-col gap-4 text-sm">
              <p className="font-mono text-xs">{openEntry.path}</p>
              <ReadSet ranges={openEntry.readSet ?? []} />
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function CacheCounters({
  c,
}: {
  c: NonNullable<ReturnType<typeof useQuery<import("../data-source.ts").QueryCacheSnapshot>>["data"]>;
}) {
  const items: [string, string][] = [
    ["Entries", formatCount(c.entries)],
    ["Size", `${bytes(c.bytes)} of ${bytes(c.maxBytes)}`],
    ["Hits", formatCount(c.hits)],
    ["Misses", formatCount(c.misses)],
    ["Evictions", formatCount(c.evictions)],
    [
      "Misses by reason",
      Object.entries(c.missReasons)
        .filter(([, n]) => n > 0)
        .map(([r, n]) => `${r} ${formatCount(n)}`)
        .join(", ") || "none",
    ],
  ];
  return (
    <dl
      aria-label="Query cache counters"
      className="grid grid-cols-2 gap-x-6 gap-y-1 border-b px-4 py-2 text-sm md:grid-cols-6 md:px-6"
    >
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReadSet({ ranges }: { ranges: ReadRange[] }) {
  return (
    <section aria-label="Read set">
      <h3 className="mb-1 font-medium">Read set</h3>
      {ranges.length === 0 ? (
        <p className="text-muted-foreground">Nothing read.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ranges.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a read set's ranges have no identity of their own
            <li key={i} className="border p-2">
              <p className="font-mono text-xs font-medium">{r.index}</p>
              <p className="font-mono text-xs text-muted-foreground">({r.fields.join(", ")})</p>
              <p className="font-mono text-xs">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `mark`: the invalidation (by `seq`) a log entry's link came for, marked in the history. */
function QueryDetails({ q, mark }: { q: Row; mark?: number }) {
  const marked = mark !== undefined && q.history.some((h) => h.kind === "invalidation" && h.seq === mark);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">Function</dt>
        <dd className="font-mono text-xs">{q.path}</dd>
        <dt className="text-muted-foreground">Args digest</dt>
        <dd className="font-mono text-xs">{q.argsDigest}</dd>
        <dt className="text-muted-foreground">Session</dt>
        <dd>
          {q.session} ({q.identity === "none" ? "no identity" : q.identity})
        </dd>
        <dt className="text-muted-foreground">At ts</dt>
        <dd className="tabular-nums">{q.ts ?? "not run yet"}</dd>
        <dt className="text-muted-foreground">Result</dt>
        <dd>{q.cached ? "From another session's run" : "Its own run"}</dd>
        <dt className="text-muted-foreground">Read</dt>
        <dd className="tabular-nums">
          {formatCount(q.documentsRead)} documents, {bytes(q.bytesRead)}
        </dd>
      </dl>
      <ReadSet ranges={q.readSet} />
      <section aria-label="Why it ran">
        <h3 className="mb-1 font-medium">Why it ran</h3>
        {mark !== undefined && !marked && (
          <p className="mb-2 text-xs text-muted-foreground">
            The invalidation the log entry names (#{mark}) is no longer in this query's history.
          </p>
        )}
        {q.history.length === 0 ? (
          <p className="text-muted-foreground">Nothing recorded.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {q.history.map((h, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: entries are listed newest first and never reordered
                key={i}
                aria-current={(h.kind === "invalidation" && h.seq !== undefined && h.seq === mark) || undefined}
                className="border p-2 text-xs aria-[current=true]:border-primary aria-[current=true]:bg-muted"
              >
                <time className="text-muted-foreground" dateTime={new Date(h.at).toISOString()}>
                  {formatTime(h.at)}
                </time>
                {h.kind === "invalidation" && h.seq !== undefined && h.seq === mark && (
                  <p className="font-medium">The run the log entry is for</p>
                )}
                {h.kind === "rerun" ? (
                  <p>{REASONS[h.reason]}</p>
                ) : (
                  <>
                    <p>
                      Commit ts <span className="tabular-nums">{h.commitTs}</span> by{" "}
                      <span className="font-mono">{h.source ?? "a write"}</span> into{" "}
                      <span className="font-mono">{h.index}</span>
                    </p>
                    <p className="font-mono">wrote {h.key.text}</p>
                    <p className="text-muted-foreground">
                      {h.sentAfterMs === null ? "New result not sent yet" : `New result sent after ${h.sentAfterMs} ms`}
                    </p>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
