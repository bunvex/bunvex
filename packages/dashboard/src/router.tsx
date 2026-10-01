// The dashboard's routes (UI-01 §4.3), code-based so they ship inside the package and any host can mount
// them: the host picks the history (the browser's, under a basepath, or memory in tests). The package does
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
  lazyRouteComponent,
  type RouterHistory,
  redirect,
  useRouter,
  type ValidateLinkOptions,
} from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { documentsQuery, functionsQuery, logsQuery, type QueryScope, tablesQuery } from "./data/queries.ts";
import { type DataSourceError, toDataSourceError } from "./data-source.ts";
import { decodeFilter } from "./database/filter-url.ts";
import { validateLogsSearch } from "./logs/log-filter.ts";
import { LOG_PAGE } from "./logs/use-logs.ts";
import { NotBuiltYet } from "./screens/not-built-yet.tsx";
import { ErrorState } from "./shell/error-state.tsx";
import { Shell } from "./shell/shell.tsx";

export type DashboardRouterContext = { queryClient: QueryClient; scope: QueryScope };

// ------------------------------------------------------------------ search params

/** The Database screen's URL state (UI-01 §12.3): the applied filter, the open document, the open panel. */
export type TableSearch = {
  filter?: string;
  doc?: string;
  panel?: "schema" | "indexes" | "add" | "columns" | "metrics";
};

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** The Functions screen's URL state: the open function (`module:name`), as in Convex. */
/** The open function, and its log filters (as the Logs screen's `type` and `q`). */
export type FunctionsSearch = { function?: string; type?: string; q?: string; tab?: "statistics" | "logs" };

export function validateFunctionsSearch(input: Record<string, unknown>): FunctionsSearch {
  const fn = str(input.function);
  const { type, q } = validateLogsSearch(input);
  // every key, `undefined` when invalid: the router keeps a raw param the validator leaves out
  const tab = input.tab === "statistics" || input.tab === "logs" ? input.tab : undefined;
  return { function: fn, type, q, tab };
}

/** Invalid options are dropped, not rejected: a hand-edited URL still opens the screen. */
export function validateTableSearch(input: Record<string, unknown>): TableSearch {
  // every key, `undefined` when invalid: the router keeps a raw param the validator leaves out
  const out: TableSearch = { filter: undefined, doc: undefined, panel: undefined };
  const filter = str(input.filter);
  const doc = str(input.doc);
  if (filter) out.filter = filter;
  if (doc) out.doc = doc;
  if (
    input.panel === "schema" ||
    input.panel === "indexes" ||
    input.panel === "add" ||
    input.panel === "columns" ||
    input.panel === "metrics"
  )
    out.panel = input.panel;
  return out;
}

/** Scheduled functions (UI-01 §14.2): the function they are narrowed to, and the run whose details are open. */
export type ScheduledSearch = { function?: string; run?: string };
export function validateScheduledSearch(input: Record<string, unknown>): ScheduledSearch {
  // every key, `undefined` when invalid: the router keeps a raw param the validator leaves out
  return { function: str(input.function), run: str(input.run) };
}

/** Files (UI-01 §14.3): the order, a day range (`YYYY-MM-DD`, the viewer's zone), the open file. */
/** The table open in the Schema screen's side panel (STUDY-12 §14). */
export type SchemaSearch = { table?: string };
export const validateSchemaSearch = (input: Record<string, unknown>): SchemaSearch => ({ table: str(input.table) });

export type FilesSearch = { order?: "asc"; from?: string; to?: string; file?: string };
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
export const validateFilesSearch = (input: Record<string, unknown>): FilesSearch => ({
  // every key, `undefined` when invalid: the router keeps a raw param the validator leaves out
  order: input.order === "asc" ? "asc" : undefined,
  from: day(input.from),
  to: day(input.to),
  file: str(input.file),
});

/** History (UI-01 §14.5): one action, a day range (`YYYY-MM-DD`, the viewer's zone), the open event. */
export type HistorySearch = { action?: string; from?: string; to?: string; event?: string };
export const validateHistorySearch = (input: Record<string, unknown>): HistorySearch => ({
  // every key, `undefined` when invalid: the router keeps a raw param the validator leaves out
  action: typeof input.action === "string" && /^[a-z_]+$/.test(input.action) ? input.action : undefined,
  from: day(input.from),
  to: day(input.to),
  event: str(input.event),
});

/** Cron jobs: the job whose details are open. */
export type CronsSearch = { cron?: string };
export const validateCronsSearch = (input: Record<string, unknown>): CronsSearch => ({ cron: str(input.cron) });

// ------------------------------------------------------------------ routes

// Each screen is its own chunk, fetched when its route is first matched (while its loader runs), so the
// first load carries the shell only (UI-01 §14.1). The screens import this module for their routes' hooks;
// loading them lazily also breaks that import cycle.
const Overview = lazyRouteComponent(() => import("./screens/overview.tsx"), "Overview");
const DatabaseScreen = lazyRouteComponent(() => import("./database/screen.tsx"), "DatabaseScreen");
const EmptyDatabase = lazyRouteComponent(() => import("./database/empty.tsx"), "EmptyDatabase");
const SchemaScreen = lazyRouteComponent(() => import("./schema/screen.tsx"), "SchemaScreen");
const FunctionsScreen = lazyRouteComponent(() => import("./functions/screen.tsx"), "FunctionsScreen");
const LogsScreen = lazyRouteComponent(() => import("./logs/screen.tsx"), "LogsScreen");
const ScheduledFunctionsScreen = lazyRouteComponent(() => import("./schedules/screen.tsx"), "ScheduledFunctionsScreen");
const CronJobsScreen = lazyRouteComponent(() => import("./schedules/screen.tsx"), "CronJobsScreen");
const FilesScreen = lazyRouteComponent(() => import("./files/screen.tsx"), "FilesScreen");
const HistoryScreen = lazyRouteComponent(() => import("./history/screen.tsx"), "HistoryScreen");
const GeneralSettingsScreen = lazyRouteComponent(() => import("./settings/general.tsx"), "GeneralSettingsScreen");
const SnapshotsSettingsScreen = lazyRouteComponent(() => import("./settings/snapshots.tsx"), "SnapshotsSettingsScreen");
const AuthenticationSettingsScreen = lazyRouteComponent(
  () => import("./settings/auth.tsx"),
  "AuthenticationSettingsScreen",
);
const EnvironmentVariablesScreen = lazyRouteComponent(
  () => import("./settings/screen.tsx"),
  "EnvironmentVariablesScreen",
);

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
  // reached only when there is no table to open
  component: EmptyDatabase,
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

export const schemaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "schema",
  validateSearch: validateSchemaSearch,
  component: SchemaScreen,
});

export const functionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "functions",
  validateSearch: validateFunctionsSearch,
  loader: ({ context: { queryClient, scope } }) => queryClient.ensureQueryData(functionsQuery(scope)),
  component: FunctionsScreen,
});

export const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "logs",
  validateSearch: validateLogsSearch,
  // the newest page of every function's lines; filters apply on the client (STUDY-12 §7)
  loader: ({ context: { queryClient, scope } }) => queryClient.ensureInfiniteQueryData(logsQuery(scope, {}, LOG_PAGE)),
  component: LogsScreen,
});

export const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "files",
  validateSearch: validateFilesSearch,
  component: FilesScreen,
});

export const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "history",
  validateSearch: validateHistorySearch,
  component: HistoryScreen,
});

/** `/settings` opens General, its first page, as Convex's (UI-01 §17.1). */
export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
});

export const generalSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/general",
  component: GeneralSettingsScreen,
});

export const envVarsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/environment-variables",
  component: EnvironmentVariablesScreen,
});

export const authSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/authentication",
  component: AuthenticationSettingsScreen,
});

export const snapshotsSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/snapshots",
  component: SnapshotsSettingsScreen,
});

/** `/schedules` opens the scheduled functions, as Convex's sidebar does. */
export const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "schedules",
  beforeLoad: () => {
    throw redirect({ to: "/schedules/functions", replace: true });
  },
});

export const scheduledRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "schedules/functions",
  validateSearch: validateScheduledSearch,
  component: ScheduledFunctionsScreen,
});

export const cronsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "schedules/crons",
  validateSearch: validateCronsSearch,
  component: CronJobsScreen,
});

export const routeTree = rootRoute.addChildren([
  healthRoute,
  databaseRoute,
  tableRoute,
  schemaRoute,
  functionsRoute,
  logsRoute,
  filesRoute,
  schedulesRoute,
  scheduledRoute,
  cronsRoute,
  historyRoute,
  settingsRoute,
  generalSettingsRoute,
  envVarsRoute,
  authSettingsRoute,
  snapshotsSettingsRoute,
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
