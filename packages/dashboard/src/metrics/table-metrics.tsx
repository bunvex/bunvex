// A table's metrics (UI-01 §18.3, STUDY-12 §12), as Convex's `TableMetrics.tsx`: the rows its functions read
// and wrote per minute over the last hour, one chart (same unit, one axis), with the side panel's width.
import { useQueryScope } from "../context.tsx";
import { ChartCard } from "./chart-card.tsx";
import { formatCalls, NO_METRICS, useMetric, useMetricsAccess } from "./metrics.ts";

export function TableMetrics({ table }: { table: string }) {
  const access = useMetricsAccess("tableRate");
  const { source } = useQueryScope();
  const ok = access === "ok";
  const reads = useMetric(["table", table, "rowsRead"], ok, (w, signal) =>
    source.tableRate!(table, "rowsRead", w, { signal }),
  );
  const writes = useMetric(["table", table, "rowsWritten"], ok, (w, signal) =>
    source.tableRate!(table, "rowsWritten", w, { signal }),
  );
  if (access === undefined) return null;
  if (!ok) return <p className="text-sm text-muted-foreground">{NO_METRICS[access]}</p>;
  return (
    <ChartCard
      title="Rows read and written"
      description="Per minute, last hour"
      series={
        reads.data &&
        writes.data && [
          { id: "reads", label: "Reads", points: reads.data, color: "series-1" },
          { id: "writes", label: "Writes", points: writes.data, color: "series-2" },
        ]
      }
      error={reads.error ?? writes.error}
      formatValue={formatCalls}
      empty="No function read or wrote this table in the last hour."
    />
  );
}
