// Reads for the Files screen (UI-01 §14.3), in the dashboard's query cache; `watchFiles` refreshes them.
import { infiniteQueryOptions, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { dashboardKeys, type QueryScope } from "../data/queries.ts";
import type { FileQuery, LiveChange, FileFilter as StatsFilter } from "../data-source.ts";
import type { LivePause } from "../shell/live-pause.tsx";

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

/**
 * While mounted: refreshes the file queries when the source says the files changed. With `pause` (`useLivePause`):
 * while paused, only the count and the open file follow, as Convex keeps `numFiles` and `getFile` live; the list
 * waits for a refresh. A change saying the source paused the list pauses it; "Go live" subscribes again.
 */
export function useFilesLive(pause?: Pick<LivePause, "paused" | "generation" | "onSourcePaused">) {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  return useWatch<LiveChange | undefined>(
    (onChange, onError) => scope.source.watchFiles?.(onChange, onError) ?? (() => {}),
    (change) => {
      if (pause && change?.paused) pause.onSourcePaused();
      if (pause && (pause.paused || change?.paused)) {
        void queryClient.invalidateQueries({ queryKey: fileKeys.count(scope.scope) });
        void queryClient.invalidateQueries({ queryKey: [...fileKeys.all(scope.scope), "file"] });
      } else void queryClient.invalidateQueries({ queryKey: fileKeys.all(scope.scope) });
    },
    [scope.source, scope.scope, pause?.generation],
  );
}
