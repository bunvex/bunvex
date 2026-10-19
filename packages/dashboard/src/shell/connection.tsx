// The connection to the deployment (STUDY-149 PR 6), as Convex's dashboard follows it (`deploymentContext.tsx`:
// the sync client's state polled every 2.5 s, disconnected at two checks in a row): while the source says it is
// disconnected, the screens are covered by "Connection issue" (Convex's `DisconnectedOverlay`, the self-hosted
// wording) and the polled reads stop (Convex's SWR keys go null while disconnected: the shapes, every app
// metric). Once it is back, what failed meanwhile is read again; the live reads resume by themselves. A source
// without `watchConnection` (the mock) is always connected.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Unplug } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { deploymentQuery } from "../data/queries.ts";
import type { ConnectionStatus, DashboardDataSource } from "../data-source.ts";

export const ConnectionContext = createContext<{ status: ConnectionStatus; deploymentUrl?: string }>({
  status: "connected",
});

/**
 * The reads polled over HTTP (their key's third part): the metrics, the inferred types (`/api/shapes2`), the
 * subscriptions inspector's live queries and query cache (`/api/debug/*`, STUDY-131 AD-25), the topology
 * (`/api/debug/topology`, STUDY-131 §11), and the rooms with their members (`/api/debug/rooms*`, AD-43).
 */
const POLLED = new Set(["metrics", "inferred", "subscriptions", "query-cache", "topology", "rooms"]);

/** True while the deployment is disconnected: polled reads wait (`enabled: !disconnected`). */
export const useDisconnected = () => useContext(ConnectionContext).status === "disconnected";

/**
 * The source's connection status, followed for the component's life. When it comes back after a disconnection,
 * the queries that failed meanwhile are fetched again.
 */
export function useConnectionStatus(source: DashboardDataSource): ConnectionStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("connected");
  useEffect(() => {
    let wasDown = false;
    return (
      source.watchConnection?.((s) => {
        if (s === "disconnected") wasDown = true;
        else if (s === "connected" && wasDown) {
          wasDown = false;
          // as Convex's SWR keys coming back: the polled reads ask again now, and what failed meanwhile too
          void queryClient.invalidateQueries({ predicate: (q) => POLLED.has(q.queryKey[2] as string) });
          void queryClient.refetchQueries({ predicate: (q) => q.state.status === "error" });
        }
        // as Convex's: only `disconnected` covers the screens (`unknown`, not settled yet, does not)
        setStatus(s);
      }) ?? (() => {})
    );
  }, [source, queryClient]);
  return status;
}

/** Gives the screens the source's connection status (`useDisconnected`). Inside the dashboard's QueryClient. */
export function ConnectionProvider(props: {
  source: DashboardDataSource;
  deploymentUrl?: string;
  children: ReactNode;
}) {
  const status = useConnectionStatus(props.source);
  const value = useMemo(() => ({ status, deploymentUrl: props.deploymentUrl }), [status, props.deploymentUrl]);
  return <ConnectionContext.Provider value={value}>{props.children}</ConnectionContext.Provider>;
}

/** Covers the screens while disconnected, below the header (Convex's overlay keeps the header usable). */
export function DisconnectedOverlay() {
  const { status, deploymentUrl } = useContext(ConnectionContext);
  const { data } = useQuery(deploymentQuery(useQueryScope()));
  if (status !== "disconnected") return null;
  const url = deploymentUrl ?? data?.url;
  return (
    <div className="fixed inset-x-0 top-12 bottom-0 z-40 flex items-center justify-center bg-background/60 p-4 backdrop-blur-xs">
      <section
        role="alert"
        aria-labelledby="connection-issue"
        className="flex max-h-[80vh] max-w-md flex-col gap-2 overflow-y-auto border bg-background p-6 text-sm shadow-lg"
      >
        <h2 id="connection-issue" className="mb-2 flex items-center gap-3 text-base font-semibold">
          <Unplug aria-hidden="true" className="size-5 text-muted-foreground" />
          Connection issue
        </h2>
        <p>
          Check that your bunvex server is running and accessible
          {url ? (
            <>
              {" "}
              at <code className="font-mono text-xs">{url}</code>
            </>
          ) : null}
          .
        </p>
        <p className="text-muted-foreground">If you continue to have issues, try restarting your bunvex server.</p>
      </section>
    </div>
  );
}
