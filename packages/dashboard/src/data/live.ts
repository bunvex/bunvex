// The reactive half of the data layer: `watch*` subscriptions kept for a component's lifetime. Where a
// watcher's data should outlive the component, it is written into the TanStack Query cache.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type DependencyList, useEffect, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import type { DataSourceError, DeploymentStats, Unsubscribe } from "../data-source.ts";
import { appendSample } from "../screens/stats.ts";
import { statsHistoryQuery } from "./queries.ts";

/**
 * A `watch*` subscription for the component's lifetime (re-subscribed when `deps` change). Returns the
 * latest error, cleared by the next value. `onValue` may change between renders; the latest is called.
 */
export function useWatch<T>(
  subscribe: (onValue: (v: T) => void, onError: (e: DataSourceError) => void) => Unsubscribe,
  onValue: (v: T) => void,
  deps: DependencyList,
): DataSourceError | undefined {
  const [error, setError] = useState<DataSourceError>();
  const onValueRef = useRef(onValue);
  onValueRef.current = onValue;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` are the caller's inputs to `subscribe`
  useEffect(() => {
    setError(undefined);
    let live = true;
    const off = subscribe(
      (v) => {
        if (!live) return;
        setError(undefined);
        onValueRef.current(v);
      },
      (e) => live && setError(e),
    );
    return () => {
      live = false;
      off();
    };
  }, [...deps]);
  return error;
}

/** Samples kept: one per watchStats delivery (about a minute at the usual one per second). */
export const STATS_HISTORY = 61;

/** The live stats history, kept in the query cache while mounted watchers feed it. */
export function useStatsHistory(): { history: DeploymentStats[]; error: DataSourceError | undefined } {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const options = statsHistoryQuery(scope);
  const { data: history = [] } = useQuery(options);
  const error = useWatch<DeploymentStats>(
    (onStats, onError) => scope.source.watchStats(onStats, onError),
    (s) => queryClient.setQueryData(options.queryKey, (h = []) => appendSample(h, s, STATS_HISTORY)),
    [scope.source, scope.scope, queryClient],
  );
  return { history, error };
}
