// Workflows → Runs (UI-01 §26.3): every run, newest first — the workflow, its status (icon and word), the step
// it is on, how long, how many retries. Filters in the section column (status, workflow). A row opens the run.
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useQueryScope } from "../../context.tsx";
import { toDataSourceError } from "../../data-source.ts";
import { formatTime } from "../../database/values.ts";
import { formatCount } from "../../screens/stats.ts";
import { BAR1 } from "../../shell/bars.ts";
import { ErrorState } from "../../shell/error-state.tsx";
import type { RunStatus, WorkflowRun } from "./data-source.ts";
import { runsQuery } from "./queries.ts";
import { StatusWord } from "./run-view.tsx";
import { duration, elapsed } from "./words.ts";

const col = dataTableColumns<WorkflowRun>();
const mono = (v: string) => <span className="font-mono text-xs tabular-nums">{v}</span>;

export function RunsPage(props: {
  heading: ReactNode;
  status?: RunStatus;
  workflow?: string;
  onOpen: (id: string) => void;
}) {
  const scope = useQueryScope();
  const runs = useInfiniteQuery(runsQuery(scope, { status: props.status, workflow: props.workflow }));
  const rows = runs.data?.pages.flatMap((p) => p.page) ?? [];
  const now = runs.dataUpdatedAt || Date.now();
  const columns: DataTableColumn<WorkflowRun>[] = [
    col.accessor((r) => r.workflow, { id: "workflow", header: "Workflow", cell: (c) => mono(c.getValue()) }),
    col.accessor((r) => r.status, {
      id: "status",
      header: "Status",
      cell: (c) => <StatusWord status={c.getValue()} />,
    }),
    col.accessor((r) => r.currentStep ?? "", { id: "step", header: "Current step", cell: (c) => mono(c.getValue()) }),
    col.accessor((r) => r.startedAt, { id: "started", header: "Started", cell: (c) => mono(formatTime(c.getValue())) }),
    col.accessor((r) => elapsed(r.startedAt, r.finishedAt, now) ?? 0, {
      id: "duration",
      header: "Duration",
      cell: (c) => mono(duration(c.getValue())),
    }),
    col.accessor((r) => `${r.steps}`, { id: "steps", header: "Steps", cell: (c) => mono(c.getValue()) }),
    col.accessor((r) => r.retries, { id: "retries", header: "Retries", cell: (c) => mono(String(c.getValue())) }),
  ];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        {props.heading}
        {runs.data && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatCount(rows.length)} {rows.length === 1 ? "run" : "runs"}
            {runs.hasNextPage ? " loaded" : ""}
          </span>
        )}
      </div>
      {runs.error ? (
        <ErrorState error={toDataSourceError(runs.error)} />
      ) : (
        <DataTable
          label="Workflow runs"
          fill
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          grid={{ activateOnClick: true, onCellActivate: (r) => props.onOpen(r.id) }}
          onEndReached={() => runs.hasNextPage && !runs.isFetchingNextPage && void runs.fetchNextPage()}
          defaultColumnWidth={(id) =>
            ({ workflow: 220, status: 130, step: 200, started: 170, duration: 120, steps: 80, retries: 80 })[id] ?? 140
          }
          empty={
            runs.isPending
              ? "Loading…"
              : props.status || props.workflow
                ? "No run matches these filters."
                : "No workflow has run yet."
          }
        />
      )}
    </div>
  );
}
