// Reads for the Schedules screens (UI-01 §14.2), in the dashboard's query cache like every read; a
// `watchScheduledFunctions` signal refreshes them (STUDY-12 S1, as D3 does for documents).
import { infiniteQueryOptions, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { dashboardKeys, type QueryScope } from "../data/queries.ts";
import type { LiveChange } from "../data-source.ts";
import type { LivePause } from "../shell/live-pause.tsx";

export const SCHEDULED_PAGE = 50;

export const scheduleKeys = {
  all: (scope: string) => [...dashboardKeys.all(scope), "schedules"] as const,
  scheduled: (scope: string, fn: string | undefined) => [...scheduleKeys.all(scope), "scheduled", fn ?? null] as const,
  /** The cron jobs and their runs (live even while the scheduled list is paused, as Convex's crons). */
  cronsAll: (scope: string) => [...scheduleKeys.all(scope), "cron"] as const,
  crons: (scope: string) => [...scheduleKeys.cronsAll(scope), "jobs"] as const,
  cronRuns: (scope: string, name: string) => [...scheduleKeys.cronsAll(scope), "runs", name] as const,
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

/**
 * While mounted: refreshes the schedules' queries when the source says they changed. With `pause` (the scheduled
 * functions' list, `useLivePause`): while paused, only the cron jobs follow (the list waits for a refresh); a
 * change saying the source paused the list pauses it; each "Go live" subscribes again, which resumes the source.
 */
export function useSchedulesLive(pause?: Pick<LivePause, "paused" | "generation" | "onSourcePaused">) {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  return useWatch<LiveChange | undefined>(
    (onChange, onError) => scope.source.watchScheduledFunctions?.(onChange, onError) ?? (() => {}),
    (change) => {
      if (pause && change?.paused) pause.onSourcePaused();
      const listPaused = pause && (pause.paused || change?.paused);
      void queryClient.invalidateQueries({
        queryKey: listPaused ? scheduleKeys.cronsAll(scope.scope) : scheduleKeys.all(scope.scope),
      });
    },
    [scope.source, scope.scope, pause?.generation],
  );
}
