// Reads for the Schedules screens (UI-01 §14.2), in the dashboard's query cache like every read; a
// `watchScheduledFunctions` signal refreshes them (STUDY-12 S1, as D3 does for documents).
import { infiniteQueryOptions, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { dashboardKeys, type QueryScope } from "../data/queries.ts";
import type { DataSourceError } from "../data-source.ts";

export const SCHEDULED_PAGE = 50;

export const scheduleKeys = {
  all: (scope: string) => [...dashboardKeys.all(scope), "schedules"] as const,
  scheduled: (scope: string, fn: string | undefined) => [...scheduleKeys.all(scope), "scheduled", fn ?? null] as const,
  crons: (scope: string) => [...scheduleKeys.all(scope), "crons"] as const,
  cronRuns: (scope: string, name: string) => [...scheduleKeys.all(scope), "cron-runs", name] as const,
};

const offered = (method: unknown, what: string) => {
  if (typeof method !== "function") throw new Error(`this source has no ${what}`);
};

export const scheduledQuery = ({ source, scope }: QueryScope, fn: string | undefined) =>
  infiniteQueryOptions({
    queryKey: scheduleKeys.scheduled(scope, fn),
    queryFn: ({ pageParam, signal }) => {
      offered(source.listScheduledFunctions, "scheduled functions");
      return source.listScheduledFunctions!({ numItems: SCHEDULED_PAGE, cursor: pageParam, function: fn }, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
  });

export const cronJobsQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: scheduleKeys.crons(scope),
    queryFn: ({ signal }) => {
      offered(source.listCronJobs, "cron jobs");
      return source.listCronJobs!({ signal });
    },
  });

export const cronRunsQuery = ({ source, scope }: QueryScope, name: string) =>
  queryOptions({
    queryKey: scheduleKeys.cronRuns(scope, name),
    queryFn: ({ signal }) => {
      offered(source.listCronRuns, "cron runs");
      return source.listCronRuns!(name, { signal });
    },
  });

/** While mounted: refreshes the schedules' queries when the source says they changed. */
export function useSchedulesLive(): DataSourceError | undefined {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  return useWatch<void>(
    (onChange, onError) => scope.source.watchScheduledFunctions?.(onChange, onError) ?? (() => {}),
    () => void queryClient.invalidateQueries({ queryKey: scheduleKeys.all(scope.scope) }),
    [scope.source, scope.scope],
  );
}
