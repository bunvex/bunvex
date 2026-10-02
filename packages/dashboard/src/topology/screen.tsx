// The Topology screen (UI-01 §22, STUDY-12 §15) — a bunvex addition: who is running and how it connects (STUDY-24):
// the clients, the followers they connect to, the leader that feeds them the commit stream, and the store the
// leader holds the lease on, drawn as a diagram (diagram.tsx). A one-line summary above says the same in words;
// the events feed below lights a node when one is picked. A deployment of one node (bunvex today) shows that
// node and its store. Live from watchTopology.

import { Button } from "@bunvex/ui/components/button";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronUp } from "lucide-react";
import { lazy, Suspense, useId, useMemo, useState } from "react";
import { useClientApps } from "../clients/queries.ts";
import { type ClientsBy, groupClients } from "../clients/words.tsx";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { capabilitiesQuery, dashboardKeys } from "../data/queries.ts";
import { type Topology, toDataSourceError } from "../data-source.ts";
import { type TopologySearch, topologyRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { BAR_TITLE } from "../shell/bars.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { ClientsPanel } from "./clients-panel.tsx";
import { NodePanel } from "./node-panel.tsx";
import { eventText, summary } from "./words.ts";

// React Flow loads with the diagram, after the summary is on screen
const TopologyDiagram = lazy(() => import("./diagram.tsx").then((m) => ({ default: m.TopologyDiagram })));

export function TopologyScreen() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const caps = useQuery(capabilitiesQuery(scope));
  const canView = caps.data?.operations.includes("viewMetrics") ?? false;
  const offered = typeof source.getTopology === "function";
  const key = [...dashboardKeys.all(scope.scope), "topology"] as const;
  const topology = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => source.getTopology!({ signal }),
    enabled: offered && canView,
  });
  const liveError = useWatch<Topology>(
    (onValue, onError) => (offered && canView && source.watchTopology?.(onValue, onError)) || (() => {}),
    (t) => queryClient.setQueryData(key, t),
    [source, scope.scope, offered, canView],
  );
  const search = topologyRoute.useSearch();
  const navigate = topologyRoute.useNavigate();
  // a node or a client group: one panel at a time
  const open = (node: string | undefined) =>
    navigate({ search: (s: TopologySearch): TopologySearch => ({ ...s, node, clients: undefined }), replace: true });
  const openGroup = (clients: string | undefined) =>
    navigate({ search: (s: TopologySearch): TopologySearch => ({ ...s, clients, node: undefined }), replace: true });
  const by: ClientsBy = search.clientsBy === "app" ? "app" : "platform";
  const setBy = (b: ClientsBy) =>
    navigate({
      search: (s: TopologySearch): TopologySearch => ({
        ...s,
        clientsBy: b === "app" ? "app" : undefined,
        clients: undefined,
      }),
      replace: true,
    });
  // who the clients are (UI-01 §33), when the source says: the registry names them by app, the policy grades SDKs
  const apps = useClientApps();
  const summaryQuery = useQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "client-summary"],
    queryFn: ({ signal }) => source.getClientSummary!({ signal }),
    enabled: typeof source.getClientSummary === "function" && canView && search.clients !== undefined,
  });
  /** A node lit from the events feed. */
  const [highlight, setHighlight] = useState<string>();

  const t = topology.data;
  const groups = useMemo(
    () => (t?.nodes.some((n) => n.clients) ? groupClients(t.nodes, by, apps.data ?? []) : undefined),
    [t, by, apps.data],
  );
  if (!offered) return <NotOffered title="Topology" what="its topology" />;
  const opened = t?.nodes.find((n) => n.id === search.node);
  const openedGroup = groups?.find((g) => g.key === search.clients);

  return (
    // as the Schema screen: full-bleed inside <main>, a slim bar on top, the canvas taking the rest, the
    // events docked at the bottom (collapsed: they never steal the canvas's height), the panel at the edge
    <div className="-m-4 flex h-[calc(100svh-3rem)] min-h-[28rem] md:-m-6">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Bar 1 (UI-01 §22.5): 44 px, on the docked panel header's line */}
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1 md:px-6">
          <h1 className={BAR_TITLE}>Topology</h1>
          {t && (
            <span className="text-sm text-muted-foreground" data-testid="topology-summary">
              {summary(t)}
            </span>
          )}
          {t?.nodes.length === 1 && (
            <span className="text-xs text-muted-foreground">
              One node runs everything; followers appear when bunvex runs more than one.
            </span>
          )}
          {groups && (
            <fieldset className="ml-auto flex items-center gap-1 border-0 p-0 text-xs">
              <legend className="sr-only">Group clients by</legend>
              <span aria-hidden="true" className="text-muted-foreground">
                Clients by
              </span>
              {(["platform", "app"] as const).map((b) => (
                <Button
                  key={b}
                  variant={by === b ? "secondary" : "ghost"}
                  size="xs"
                  aria-pressed={by === b}
                  onClick={() => setBy(b)}
                >
                  {b === "platform" ? "Platform" : "App"}
                </Button>
              ))}
            </fieldset>
          )}
        </div>
        {caps.data && !canView ? (
          <p className="p-4 text-sm text-muted-foreground md:px-6">
            This credential cannot view the deployment's topology.
          </p>
        ) : topology.error ? (
          <div className="p-4 md:px-6">
            <ErrorState error={toDataSourceError(topology.error)} onRetry={() => void topology.refetch()} />
          </div>
        ) : !t ? (
          <p className="p-4 text-sm text-muted-foreground md:px-6">Loading…</p>
        ) : (
          <>
            {liveError && (
              <div className="px-4 pt-3 md:px-6">
                <ErrorState error={liveError} />
              </div>
            )}
            <Suspense
              fallback={<p className="flex-1 p-4 text-sm text-muted-foreground md:px-6">Loading the diagram…</p>}
            >
              <TopologyDiagram
                topology={t}
                opened={search.node}
                highlight={highlight}
                onOpen={open}
                groups={groups}
                openedGroup={search.clients}
                onOpenGroup={openGroup}
              />
            </Suspense>
            <Events t={t} highlight={highlight} onPick={(n) => setHighlight((h) => (h === n ? undefined : n))} />
          </>
        )}
      </div>
      {t && opened && <NodePanel node={opened} topology={t} onClose={() => open(undefined)} />}
      {openedGroup && (
        <ClientsPanel group={openedGroup} policy={summaryQuery.data?.policy} onClose={() => openGroup(undefined)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ events

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** The events, docked under the canvas: one line (the newest) until opened, then a short scrolling list. */
function Events({ t, highlight, onPick }: { t: Topology; highlight?: string; onPick: (node: string) => void }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const newest = t.events[0];
  return (
    <section aria-labelledby="topology-events" className="border-t">
      <h2 id="topology-events" className="text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-4 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-6"
        >
          <ChevronUp aria-hidden="true" className={cn("size-4 text-muted-foreground", !open && "rotate-180")} />
          <span className="font-medium">Events</span>
          <span className="text-muted-foreground tabular-nums">{formatCount(t.events.length)}</span>
          {!open && newest && <span className="min-w-0 truncate text-muted-foreground">· {eventText(newest)}</span>}
        </button>
      </h2>
      <div id={listId} hidden={!open} className="max-h-48 overflow-y-auto border-t">
        {t.events.length === 0 ? (
          <p className="px-4 py-2 text-sm text-muted-foreground md:px-6">Nothing has changed in the topology yet.</p>
        ) : (
          <ol className="divide-y">
            {t.events.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  disabled={!e.node}
                  aria-pressed={e.node !== undefined && highlight === e.node}
                  onClick={() => e.node && onPick(e.node)}
                  className={cn(
                    "flex w-full flex-wrap gap-x-4 gap-y-0.5 px-4 py-1.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:hover:bg-transparent md:px-6",
                    e.node !== undefined && highlight === e.node && "bg-info/10",
                  )}
                >
                  <time
                    dateTime={new Date(e.time).toISOString()}
                    className="font-mono text-xs text-muted-foreground tabular-nums"
                  >
                    {time.format(e.time)}
                  </time>
                  <span>{eventText(e)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
