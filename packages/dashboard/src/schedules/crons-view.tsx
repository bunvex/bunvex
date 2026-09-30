// Cron jobs (UI-01 §14.2, STUDY-12 §8): each job with its schedule, function, last and next run; a job's
// details beside the list, with its arguments and its recent runs (the source keeps a few, Convex 5).
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { type CronJob, type CronRun, toDataSourceError } from "../data-source.ts";
import { formatLiteral } from "../database/literal.ts";
import { formatTime } from "../database/values.ts";
import { formatDuration } from "../logs/log-list.tsx";
import { type CronsSearch, cronsRoute } from "../router.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { Panel } from "../shell/panel.tsx";
import { describeSchedule } from "./cron.ts";
import { formatRelative } from "./format.ts";
import { cronJobsQuery, cronRunsQuery, useSchedulesLive } from "./queries.ts";

const col = dataTableColumns<CronJob>();

const STATUS: Record<CronRun["status"], string> = { success: "Success", failure: "Failure", skipped: "Skipped" };

function RunStatus({ run }: { run: CronRun }) {
  return <span className={cn(run.status === "failure" && "text-destructive")}>{STATUS[run.status]}</span>;
}

export function CronsView() {
  const scope = useQueryScope();
  const search = cronsRoute.useSearch();
  const navigate = cronsRoute.useNavigate();
  const setCron = (cron: string | undefined) => navigate({ search: (s: CronsSearch): CronsSearch => ({ ...s, cron }) });
  const jobs = useQuery(cronJobsQuery(scope));
  const liveError = useSchedulesLive();
  const now = Date.now();
  const list = jobs.data ?? [];
  const open = search.cron === undefined ? undefined : (list.find((j) => j.name === search.cron) ?? null);

  const columns: DataTableColumn<CronJob>[] = [
    col.accessor((j) => j.name, {
      id: "name",
      header: "Name",
      cell: (c) => <span className="text-sm">{c.getValue()}</span>,
    }),
    col.accessor((j) => describeSchedule(j.schedule), {
      id: "schedule",
      header: "Schedule",
      cell: (c) => <span className="text-xs">{c.getValue()}</span>,
    }),
    col.accessor((j) => j.function, {
      id: "function",
      header: "Function",
      cell: (c) => <span className="truncate font-mono text-xs">{c.getValue()}</span>,
    }),
    col.accessor((j) => j.lastRun, {
      id: "last",
      header: "Last run",
      cell: (c) => {
        const run = c.getValue() as CronRun | null;
        if (c.row.original.running) return <span className="text-xs text-info">Running</span>;
        if (!run) return <span className="text-xs text-muted-foreground">Not yet</span>;
        return (
          <span className="flex gap-2 text-xs">
            <RunStatus run={run} />
            <span className="text-muted-foreground">{formatRelative(run.time, now)}</span>
          </span>
        );
      },
    }),
    col.accessor((j) => j.nextRun, {
      id: "next",
      header: "Next run",
      cell: (c) => (
        <span className="text-xs" title={formatTime(c.getValue())}>
          {formatRelative(c.getValue(), now)}
        </span>
      ),
    }),
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {liveError && <ErrorState error={liveError} />}
        {jobs.error ? (
          <ErrorState error={toDataSourceError(jobs.error)} />
        ) : (
          <DataTable
            label="Cron jobs"
            className="max-h-[calc(100svh-14rem)]"
            columns={columns}
            data={list}
            getRowId={(j) => j.name}
            defaultColumnWidth={(id) => ({ name: 200, schedule: 240, function: 220, last: 180, next: 120 })[id] ?? 160}
            grid={{ activateOnClick: true, onCellActivate: (j) => setCron(j.name) }}
            empty={
              jobs.isPending
                ? "Loading…"
                : "No cron jobs. Jobs defined with cronJobs() appear here once they are deployed."
            }
            footer={<span>{`${list.length} cron ${list.length === 1 ? "job" : "jobs"}`}</span>}
          />
        )}
      </div>
      {open !== undefined && <CronDetails job={open} name={search.cron!} onClose={() => setCron(undefined)} />}
    </div>
  );
}

function CronDetails(props: { job: CronJob | null; name: string; onClose: () => void }) {
  const scope = useQueryScope();
  const runs = useQuery({ ...cronRunsQuery(scope, props.name), enabled: props.job !== null });
  const { job } = props;
  return (
    <Panel title={props.name} onClose={props.onClose}>
      {job === null ? (
        <p className="text-sm text-muted-foreground">There is no cron job named “{props.name}”.</p>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Schedule</dt>
            <dd>{describeSchedule(job.schedule)}</dd>
            <dt className="text-muted-foreground">Function</dt>
            <dd className="font-mono text-xs">{job.function}</dd>
            <dt className="text-muted-foreground">Next run</dt>
            <dd>
              <time dateTime={new Date(job.nextRun).toISOString()}>{formatTime(job.nextRun)}</time>{" "}
              <span className="text-muted-foreground">({formatRelative(job.nextRun, Date.now())})</span>
            </dd>
          </dl>
          <section aria-label="Arguments">
            <h3 className="mb-1 font-medium">Arguments</h3>
            <pre className="overflow-x-auto border bg-muted/40 p-2 font-mono text-xs">
              {formatLiteral(job.args, "  ")}
            </pre>
          </section>
          <section aria-label="Recent runs">
            <h3 className="mb-1 font-medium">Recent runs</h3>
            {runs.error ? (
              <ErrorState error={toDataSourceError(runs.error)} />
            ) : !runs.data ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : runs.data.length === 0 ? (
              <p className="text-muted-foreground">It has not run yet.</p>
            ) : (
              <ol className="flex flex-col gap-3">
                {runs.data.map((r) => (
                  <li key={r.time} className="border p-2">
                    <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
                      <RunStatus run={r} />
                      <time dateTime={new Date(r.time).toISOString()}>{formatTime(r.time)}</time>
                      <span className="text-muted-foreground tabular-nums">{formatDuration(r.durationMs)}</span>
                    </div>
                    {r.error && <p className="mt-1 font-mono text-xs text-destructive">{r.error}</p>}
                    {r.logLines.length > 0 && (
                      <pre className="mt-1 overflow-x-auto bg-muted/40 p-1 font-mono text-xs">
                        {r.logLines.join("\n")}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
