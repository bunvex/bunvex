// Live data for the Database screen (UI-01 §12.4): `watchTable` says a table changed; the loaded pages of
// its documents, the open document and the table list (its counts) are refreshed through the query cache.
import { useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { dashboardKeys } from "../data/queries.ts";
import type { DataSourceError } from "../data-source.ts";

export function useLiveTable(table: string): DataSourceError | undefined {
  const { source, scope } = useQueryScope();
  const queryClient = useQueryClient();
  return useWatch<{ count?: number }>((onChange, onError) => source.watchTable(table, onChange, onError), () => {
    const all = dashboardKeys.all(scope);
    void queryClient.invalidateQueries({ queryKey: [...all, "documents", table] });
    void queryClient.invalidateQueries({ queryKey: [...all, "document", table] });
    void queryClient.invalidateQueries({ queryKey: dashboardKeys.tables(scope) });
  }, [source, scope, table, queryClient]);
}
