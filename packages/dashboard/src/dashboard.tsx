// <Dashboard>: the whole dashboard over an injected data source (UI-01). It creates its router over the
// history the host chooses and uses the host's QueryClient when given one.
import { TooltipProvider } from "@bunvex/ui/components/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserHistory, type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { QueryScopeContext } from "./context.tsx";
import { type DashboardDataSource, toDataSourceError } from "./data-source.ts";
import { createDashboardRouter } from "./router.tsx";
import { HeaderActionsContext } from "./shell/shell.tsx";

export type DashboardProps = {
  /** Read once, when the dashboard mounts; give the component a new `key` to switch sources. */
  dataSource: DashboardDataSource;
  /** Default: the browser history (plain paths). `createMemoryHistory()` in tests. */
  history?: RouterHistory;
  /** Where the dashboard lives in the host's URL space, e.g. "/projects/abc/dashboard". */
  basepath?: string;
  /** The host's client, to share its cache. Default: a client of the dashboard's own. */
  queryClient?: QueryClient;
  /** Namespaces the query keys when several dashboards share one QueryClient. Default "default". */
  scope?: string;
  /** Rendered at the end of the header, e.g. a theme toggle or the host's account menu. */
  headerActions?: ReactNode;
  /** Shows the TanStack Router and Query devtools (loaded on demand). */
  devtools?: boolean;
};

const Devtools = lazy(() => import("./devtools.tsx"));

/** Retries only what may succeed on a second try: an unavailable deployment, once. */
export const createDashboardQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (failures, error) => failures < 1 && toDataSourceError(error).code === "unavailable",
      },
    },
  });

export function Dashboard({
  dataSource,
  history,
  basepath,
  queryClient: hostClient,
  scope = "default",
  headerActions,
  devtools = false,
}: DashboardProps) {
  const [queryClient] = useState(() => hostClient ?? createDashboardQueryClient());
  const [queryScope] = useState(() => ({ source: dataSource, scope }));
  const [router] = useState(() =>
    createDashboardRouter({
      context: { queryClient, scope: queryScope },
      history: history ?? createBrowserHistory(),
      basepath,
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <QueryScopeContext.Provider value={queryScope}>
        <HeaderActionsContext.Provider value={headerActions}>
          <TooltipProvider>
            <RouterProvider router={router} />
            {devtools && (
              <Suspense>
                <Devtools router={router} />
              </Suspense>
            )}
          </TooltipProvider>
        </HeaderActionsContext.Provider>
      </QueryScopeContext.Provider>
    </QueryClientProvider>
  );
}
