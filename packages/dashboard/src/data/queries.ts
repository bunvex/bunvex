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

/** UI-01 §17.2: running or paused; only for a source that offers pausing. */
export const deploymentStateQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "deployment-state"] as const,
    queryFn: ({ signal }) => source.getDeploymentState!({ signal }),
    enabled: typeof source.getDeploymentState === "function",
    staleTime: 10_000,
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
    // while a schema is being checked, its progress is asked again every 2 s (as Convex's query updates it)
    refetchInterval: (q) => (q.state.data?.validation?.state === "validating" ? 2_000 : false),
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

/** A table's inferred document type (the "Generated" schema); refreshed when asked again. */
export const inferredTypeQuery = ({ source, scope }: QueryScope, table: string) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "inferred", table] as const,
    queryFn: ({ signal }) => source.inferDocumentType?.(table, { signal }) ?? Promise.resolve(null),
    staleTime: 0,
  });

/** The table an id refers to (null: none); for "Go to reference". Ids do not move between tables. */
export const referenceQuery = ({ source, scope }: QueryScope, id: string) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "reference", id] as const,
    queryFn: ({ signal }) => source.tableOfId?.(id, { signal }) ?? Promise.resolve(null),
    staleTime: Number.POSITIVE_INFINITY,
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

/** The system tables (STUDY-131 AD-24); only for a source that offers them. */
export const systemTablesQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...dashboardKeys.all(scope), "system-tables"] as const,
    queryFn: ({ signal }) => source.listSystemTables!({ signal }),
    enabled: typeof source.listSystemTables === "function",
  });

/** One system table's documents, page by page, read-only. */
export const systemDocumentsQuery = (
  { source, scope }: QueryScope,
  table: string,
  order: "asc" | "desc",
  numItems = 100,
) =>
  infiniteQueryOptions({
    queryKey: [...dashboardKeys.all(scope), "system-documents", table, order] as const,
    queryFn: ({ pageParam, signal }) =>
      source.listSystemDocuments!({ table, order, numItems, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<Document>) => (last.isDone ? undefined : last.continueCursor),
    enabled: typeof source.listSystemDocuments === "function",
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
