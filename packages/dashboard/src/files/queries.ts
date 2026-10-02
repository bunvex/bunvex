// Reads for the Files screen (UI-01 §14.3), in the dashboard's query cache; `watchFiles` refreshes them.
import { infiniteQueryOptions, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { dashboardKeys, type QueryScope } from "../data/queries.ts";
import type { DataSourceError, FileQuery, FileFilter as StatsFilter } from "../data-source.ts";

export const FILES_PAGE = 50;

type FileFilter = Omit<FileQuery, "numItems" | "cursor">;

export const fileKeys = {
  all: (scope: string) => [...dashboardKeys.all(scope), "files"] as const,
  list: (scope: string, f: FileFilter) =>
    [
      ...fileKeys.all(scope),
      "list",
      f.order ?? "desc",
      f.from ?? null,
      f.to ?? null,
      f.kind ?? null,
      f.minSize ?? null,
      f.maxSize ?? null,
    ] as const,
  stats: (scope: string, f: StatsFilter) =>
    [
      ...fileKeys.all(scope),
      "stats",
      f.from ?? null,
      f.to ?? null,
      f.kind ?? null,
      f.minSize ?? null,
      f.maxSize ?? null,
    ] as const,
  count: (scope: string) => [...fileKeys.all(scope), "count"] as const,
  file: (scope: string, id: string) => [...fileKeys.all(scope), "file", id] as const,
};

export const filesQuery = ({ source, scope }: QueryScope, f: FileFilter) =>
  infiniteQueryOptions({
    queryKey: fileKeys.list(scope, f),
    queryFn: ({ pageParam, signal }) =>
      source.listFiles!({ ...f, numItems: FILES_PAGE, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
  });

export const fileCountQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: fileKeys.count(scope),
    queryFn: ({ signal }) => source.countFiles!({ signal }),
    enabled: typeof source.countFiles === "function",
  });

/** Counts and bytes of the files matching `f`, per kind (`fileStats`, optional). */
export const fileStatsQuery = ({ source, scope }: QueryScope, f: StatsFilter) =>
  queryOptions({
    queryKey: fileKeys.stats(scope, f),
    queryFn: ({ signal }) => source.fileStats!(f, { signal }),
    enabled: typeof source.fileStats === "function",
  });

export const fileQuery = ({ source, scope }: QueryScope, id: string) =>
  queryOptions({
    queryKey: fileKeys.file(scope, id),
    queryFn: ({ signal }) => source.getFile!(id, { signal }),
    enabled: typeof source.getFile === "function",
  });

/** While mounted: refreshes the file queries when the source says the files changed. */
export function useFilesLive(): DataSourceError | undefined {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  return useWatch<void>(
    (onChange, onError) => scope.source.watchFiles?.(onChange, onError) ?? (() => {}),
    () => void queryClient.invalidateQueries({ queryKey: fileKeys.all(scope.scope) }),
    [scope.source, scope.scope],
  );
}
