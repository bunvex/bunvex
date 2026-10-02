// The registered apps (UI-01 §33), as one query the screens share: Topology names its client groups by them,
// Logs and Auth name a line's or a session's client, Settings → Apps edits them. Disabled when the source does
// not offer the registry or the admin may not view metrics; an empty list then.
import { useQuery } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys } from "../data/queries.ts";

export const clientAppsKey = (scope: string) => [...dashboardKeys.all(scope), "client-apps"] as const;

export function useClientApps() {
  const scope = useQueryScope();
  const { source } = scope;
  const caps = useQuery(capabilitiesQuery(scope));
  const canView = caps.data?.operations.includes("viewMetrics") ?? false;
  return useQuery({
    queryKey: clientAppsKey(scope.scope),
    queryFn: ({ signal }) => source.listClientApps!({ signal }),
    enabled: typeof source.listClientApps === "function" && canView,
  });
}
