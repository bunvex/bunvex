// Reads for the Analytics extension (UI-01 §26), in the dashboard's query cache.
import { infiniteQueryOptions } from "@tanstack/react-query";
import { dashboardKeys, type QueryScope } from "../../data/queries.ts";
import type { Page } from "../../data-source.ts";
import type { AnalyticsEvent, AnalyticsProfile, AnalyticsSession } from "./data-source.ts";

type AnyRow = AnalyticsEvent | AnalyticsSession | AnalyticsProfile;

export const ANALYTICS_PAGE = 100;
export type AnalyticsList = "events" | "sessions" | "profiles";

export const analyticsKeys = { all: (scope: string) => [...dashboardKeys.all(scope), "analytics"] as const };

export const analyticsListQuery = ({ source, scope }: QueryScope, list: AnalyticsList, q: string, name?: string) =>
  infiniteQueryOptions({
    queryKey: [...analyticsKeys.all(scope), list, q, name ?? null] as const,
    queryFn: ({ pageParam, signal }): Promise<Page<AnyRow>> => {
      const query = { cursor: pageParam, numItems: ANALYTICS_PAGE, q: q || undefined, name };
      return list === "events"
        ? source.listAnalyticsEvents!(query, { signal })
        : list === "sessions"
          ? source.listAnalyticsSessions!(query, { signal })
          : source.listAnalyticsProfiles!(query, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
  });
