// The dashboard's routes (UI-01 §4.3), code-based so they ship inside the package and any host can mount
// them: the host picks the history (hash, browser under a basepath, memory in tests). The package does
// NOT declare TanStack Router's global `Register` — a host with its own router would collide with it —
// so links are typed against `DashboardRouter` explicitly (`DashLink`).
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Link,
  type LinkComponentProps,
  type RouterHistory,
  redirect,
  useRouter,
  type ValidateLinkOptions,
} from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { documentsQuery, functionsQuery, logsQuery, type QueryScope, tablesQuery } from "./data/queries.ts";
import { type DataSourceError, toDataSourceError } from "./data-source.ts";
import { decodeFilter } from "./database/filter-url.ts";
import { DatabaseScreen } from "./database/screen.tsx";
import { validateLogsSearch } from "./logs/log-filter.ts";
import { LogsScreen } from "./logs/screen.tsx";
import { LOG_PAGE } from "./logs/use-logs.ts";
import { NotBuiltYet } from "./screens/not-built-yet.tsx";
import { Overview } from "./screens/overview.tsx";
import { ErrorState } from "./shell/error-state.tsx";
import { Shell } from "./shell/shell.tsx";

export type DashboardRouterContext = { queryClient: QueryClient; scope: QueryScope };

// ------------------------------------------------------------------ search params

/** The Database screen's URL state (UI-01 §12.3): the applied filter, the open document, the open panel. */
export type TableSearch = { filter?: string; doc?: string; panel?: "schema" | "indexes" | "add" | "columns" };

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Invalid options are dropped, not rejected: a hand-edited URL still opens the screen. */
export function validateTableSearch(input: Record<string, unknown>): TableSearch {
  const out: TableSearch = {};
  const filter = str(input.filter);
  const doc = str(input.doc);
  if (filter) out.filter = filter;
  if (doc) out.doc = doc;
  if (input.panel === "schema" || input.panel === "indexes" || input.panel === "add" || input.panel === "columns")
    out.panel = input.panel;
  return out;
}

// ------------------------------------------------------------------ routes

export const rootRoute = createRootRouteWithContext<DashboardRouterContext>()({
  component: Shell,
  errorComponent: RouteError,
  notFoundComponent: () => (
    <NotBuiltYet title="Page not found" message="Nothing lives at this address. Pick a screen on the left." />
  ),
});

export const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Overview,
});

/** `/database` opens the first table, alphabetically; with no table yet, it says so. */
export const databaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "database",
  loader: async ({ context: { queryClient, scope } }) => {
    const tables = await queryClient.ensureQueryData(tablesQuery(scope));
    const first = tables.map((t) => t.name).sort()[0];
    if (first !== undefined) throw redirect({ to: "/database/$table", params: { table: first }, replace: true });
  },
  component: () => (
    <NotBuiltYet title="Database" message="This deployment has no tables yet. They appear once data is written." />
  ),
});

export const tableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "database/$table",
  validateSearch: validateTableSearch,
  loaderDeps: ({ search }) => ({ filter: search.filter }),
  loader: async ({ context: { queryClient, scope }, params, deps }) => {
    const tables = await queryClient.ensureQueryData(tablesQuery(scope));
    if (!tables.some((t) => t.name === params.table)) return;
    const filter = decodeFilter(deps.filter) ?? undefined;
    // a filter the source rejects is shown on the filter bar, not as a failed screen
    await queryClient.ensureInfiniteQueryData(documentsQuery(scope, params.table, filter)).catch(() => {});
  },
  component: DatabaseScreen,
});

export const functionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "functions",
  loader: ({ context: { queryClient, scope } }) => queryClient.ensureQueryData(functionsQuery(scope)),
  component: () => <NotBuiltYet title="Functions" />,
});

export const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "logs",
  validateSearch: validateLogsSearch,
  // the newest page of every function's lines; filters apply on the client (STUDY-12 §7)
  loader: ({ context: { queryClient, scope } }) => queryClient.ensureInfiniteQueryData(logsQuery(scope, {}, LOG_PAGE)),
  component: LogsScreen,
});

export const routeTree = rootRoute.addChildren([healthRoute, databaseRoute, tableRoute, functionsRoute, logsRoute]);

// ------------------------------------------------------------------ the router

export type DashboardRouterOptions = {
  context: DashboardRouterContext;
  history: RouterHistory;
  /** Where the dashboard is mounted in the host's URL space, e.g. "/projects/abc/dashboard". */
  basepath?: string;
};

export function createDashboardRouter({ context, history, basepath }: DashboardRouterOptions) {
  return createRouter({
    routeTree,
    context,
    history,
    basepath,
    defaultPreload: "intent",
    // TanStack Query owns freshness: always run loaders, which return cached data when it is fresh
    defaultPreloadStaleTime: 0,
    defaultPendingMs: 300,
    // a failing screen renders its error inside the shell, not instead of it
    defaultErrorComponent: RouteError,
  });
}

export type DashboardRouter = ReturnType<typeof createDashboardRouter>;

// ------------------------------------------------------------------ typed links and errors

type AnchorProps = Omit<ComponentProps<"a">, "href" | "children"> &
  Pick<LinkComponentProps<"a">, "activeProps" | "inactiveProps">;

/** A `Link` whose destination is type-checked against the dashboard's routes (no global Register). */
export function DashLink<TOptions>(
  props: { link: ValidateLinkOptions<DashboardRouter, TOptions>; children?: ReactNode } & AnchorProps,
): ReactNode;
export function DashLink({ link, ...rest }: { link: object; children?: ReactNode } & AnchorProps) {
  // the overload above did the checking; `Link` itself is typed against the (unregistered) default router
  return <Link {...(link as LinkComponentProps<"a">)} {...rest} />;
}

function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const e: DataSourceError = toDataSourceError(error);
  return (
    <ErrorState
      error={e}
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
}
