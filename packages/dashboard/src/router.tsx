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
  useRouter,
  type ValidateLinkOptions,
} from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import {
  documentQuery,
  documentsQuery,
  functionsQuery,
  logsQuery,
  type QueryScope,
  tablesQuery,
} from "./data/queries.ts";
import { type DataSourceError, LOG_LEVELS, type LogLevel, toDataSourceError } from "./data-source.ts";
import { NotBuiltYet } from "./screens/not-built-yet.tsx";
import { Overview } from "./screens/overview.tsx";
import { ErrorState } from "./shell/error-state.tsx";
import { Shell } from "./shell/shell.tsx";

export type DashboardRouterContext = { queryClient: QueryClient; scope: QueryScope };

// ------------------------------------------------------------------ search params

export type DocumentsSearch = { index?: string; order?: "asc" | "desc" };
export type LogsSearch = { function?: string; level?: LogLevel };

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Invalid options are dropped, not rejected: a hand-edited URL still opens the screen. */
export function validateDocumentsSearch(input: Record<string, unknown>): DocumentsSearch {
  const out: DocumentsSearch = {};
  const index = str(input.index);
  if (index) out.index = index;
  if (input.order === "asc" || input.order === "desc") out.order = input.order;
  return out;
}

export function validateLogsSearch(input: Record<string, unknown>): LogsSearch {
  const out: LogsSearch = {};
  const fn = str(input.function);
  if (fn) out.function = fn;
  if (LOG_LEVELS.includes(input.level as LogLevel)) out.level = input.level as LogLevel;
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

export const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Overview,
});

export const tablesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "tables",
  loader: ({ context: { queryClient, scope } }) => queryClient.ensureQueryData(tablesQuery(scope)),
  component: () => <NotBuiltYet title="Tables" />,
});

export const documentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "tables/$table",
  validateSearch: validateDocumentsSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, scope }, params, deps }) =>
    queryClient.ensureInfiniteQueryData(documentsQuery(scope, { table: params.table, ...deps })),
  component: () => <NotBuiltYet title="Documents" />,
});

export const documentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "tables/$table/$id",
  loader: ({ context: { queryClient, scope }, params }) =>
    queryClient.ensureQueryData(documentQuery(scope, params.table, params.id)),
  component: () => <NotBuiltYet title="Document" />,
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
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, scope }, deps }) =>
    queryClient.ensureInfiniteQueryData(
      logsQuery(scope, { function: deps.function, levels: deps.level ? [deps.level] : undefined }),
    ),
  component: () => <NotBuiltYet title="Logs" />,
});

export const routeTree = rootRoute.addChildren([
  overviewRoute,
  tablesRoute,
  documentsRoute,
  documentRoute,
  functionsRoute,
  logsRoute,
]);

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
