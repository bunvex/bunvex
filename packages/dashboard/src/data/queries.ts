// TanStack Query over the injected source (UI-01 §4.4): every read the dashboard makes is one of these
// option factories, so route loaders (`ensureQueryData`) and components (`useQuery`) share the cache.
// Keys start with ["bunvex", scope] so a host can share its QueryClient between several dashboards.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  DashboardDataSource,
  DeploymentStats,
  Document,
  FilterExpression,
  LogEntry,
  LogFilter,
  Page,
} from "../data-source.ts";
import { canonicalFilter } from "../filters.ts";

export type QueryScope = { source: DashboardDataSource; scope: string };

export const dashboardKeys = {
  all: (scope: string) => ["bunvex", scope] as const,
  deployment: (scope: string) => [...dashboardKeys.all(scope), "deployment"] as const,
  statsHistory: (scope: string) => [...dashboardKeys.all(scope), "stats", "history"] as const,
  tables: (scope: string) => [...dashboardKeys.all(scope), "tables"] as const,
  documents: (scope: string, table: string, filter?: FilterExpression) =>
    [...dashboardKeys.all(scope), "documents", table, canonicalFilter(table, filter)] as const,
  capabilities: (scope: string) => [...dashboardKeys.all(scope), "capabilities"] as const,
  schema: (scope: string) => [...dashboardKeys.all(scope), "schema"] as const,
  document: (scope: string, table: string, id: string) => [...dashboardKeys.all(scope), "document", table, id] as const,
  functions: (scope: string) => [...dashboardKeys.all(scope), "functions"] as const,
  logs: (scope: string, f: LogFilter) =>
    [...dashboardKeys.all(scope), "logs", f.function ?? null, f.levels ? [...f.levels].sort() : null] as const,
};

export const deploymentQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: dashboardKeys.deployment(scope),
    queryFn: ({ signal }) => source.getDeployment({ signal }),
    staleTime: 60_000,
  });

export const capabilitiesQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: dashboardKeys.capabilities(scope),
    queryFn: ({ signal }) => source.getCapabilities({ signal }),
    staleTime: 60_000,
  });

export const schemaQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: dashboardKeys.schema(scope),
    queryFn: ({ signal }) => source.getSchema({ signal }),
  });

export const tablesQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: dashboardKeys.tables(scope),
    queryFn: ({ signal }) => source.listTables({ signal }),
  });

export const documentsQuery = (
  { source, scope }: QueryScope,
  table: string,
  filter?: FilterExpression,
  numItems = 100,
) =>
  infiniteQueryOptions({
    queryKey: dashboardKeys.documents(scope, table, filter),
    queryFn: ({ pageParam, signal }) =>
      source.listDocuments({ table, filter, numItems, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<Document>) => (last.isDone ? undefined : last.continueCursor),
  });

export const documentQuery = ({ source, scope }: QueryScope, table: string, id: string) =>
  queryOptions({
    queryKey: dashboardKeys.document(scope, table, id),
    queryFn: ({ signal }) => source.getDocument(table, id, { signal }),
  });

export const functionsQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: dashboardKeys.functions(scope),
    queryFn: ({ signal }) => source.listFunctions({ signal }),
  });

export const logsQuery = ({ source, scope }: QueryScope, filter: LogFilter, numItems = 100) =>
  infiniteQueryOptions({
    queryKey: dashboardKeys.logs(scope, filter),
    queryFn: ({ pageParam, signal }) => source.listLogs({ ...filter, numItems, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<LogEntry>) => (last.isDone ? undefined : last.continueCursor),
  });

/**
 * The overview's stats samples. Not fetched: `useStatsHistory` fills it from watchStats, so the history
 * survives leaving the overview and coming back (within the query's gcTime).
 */
export const statsHistoryQuery = ({ scope }: QueryScope) =>
  queryOptions({
    queryKey: dashboardKeys.statsHistory(scope),
    queryFn: () => [] as DeploymentStats[],
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
  });
