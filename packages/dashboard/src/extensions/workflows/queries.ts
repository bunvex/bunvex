// Reads for the Workflows extension (UI-01 §26.3), in the dashboard's query cache. Runs refresh every few
// seconds while the screen is open (a running run moves on); a write refreshes them all.
import { infiniteQueryOptions, queryOptions, useQueryClient } from "@tanstack/react-query";
import { dashboardKeys, type QueryScope } from "../../data/queries.ts";
import type { RunStatus } from "./data-source.ts";

export const RUNS_PAGE = 50;
const LIVE_MS = 5_000;
export const workflowKeys = { all: (scope: string) => [...dashboardKeys.all(scope), "workflows"] as const };

export const runsQuery = ({ source, scope }: QueryScope, f: { status?: RunStatus; workflow?: string }) =>
  infiniteQueryOptions({
    queryKey: [...workflowKeys.all(scope), "runs", f.status ?? null, f.workflow ?? null] as const,
    queryFn: ({ pageParam, signal }) =>
      source.listWorkflowRuns!({ ...f, cursor: pageParam, numItems: RUNS_PAGE }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
    refetchInterval: LIVE_MS,
  });

export const runQuery = ({ source, scope }: QueryScope, id: string) =>
  queryOptions({
    queryKey: [...workflowKeys.all(scope), "run", id] as const,
    queryFn: ({ signal }) => source.getWorkflowRun!(id, { signal }),
    refetchInterval: LIVE_MS,
  });

export const namesQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...workflowKeys.all(scope), "names"] as const,
    queryFn: ({ signal }) => source.listWorkflowNames!({ signal }),
  });

export const poolsQuery = ({ source, scope }: QueryScope) =>
  queryOptions({
    queryKey: [...workflowKeys.all(scope), "pools"] as const,
    queryFn: ({ signal }) => source.listWorkpools!({ signal }),
    refetchInterval: LIVE_MS,
  });

export function useRefreshWorkflows() {
  const client = useQueryClient();
  return (scope: string) => client.invalidateQueries({ queryKey: workflowKeys.all(scope) });
}
