// Scheduled functions (UI-01 §14.2, STUDY-12 §9): the runs waiting in the scheduler, nearest first, for
// every function or one; a run's details beside the list, where it can be canceled; Cancel all.

import { CopyButton } from "@bunvex/ui/components/copy-button";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { StatusBadge } from "@bunvex/ui/components/status-badge";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, functionsQuery } from "../data/queries.ts";
import { type FunctionKind, type ScheduledFunction, toDataSourceError } from "../data-source.ts";
import { formatLiteral } from "../database/literal.ts";
import { formatTime } from "../database/values.ts";
import { KIND_LETTER } from "../logs/log-list.tsx";
import { type ScheduledSearch, scheduledRoute } from "../router.tsx";
import { ConfirmButton } from "../shell/confirm.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { Panel } from "../shell/panel.tsx";
import { formatRelative } from "./format.ts";
import { scheduledQuery, scheduleKeys, useSchedulesLive } from "./queries.ts";

const col = dataTableColumns<ScheduledFunction>();
const ALL = "*";

function FunctionName({ path, kind }: { path: string; kind?: FunctionKind }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {kind && (
        <abbr
          title={kind}
          className="shrink-0 border px-1 font-mono text-[10px] leading-4 text-muted-foreground no-underline"
        >
          {KIND_LETTER[kind]}
        </abbr>
      )}
      <span className="truncate font-mono text-xs">{path}</span>
    </span>
  );
}

export function ScheduledView() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const search = scheduledRoute.useSearch();
  const navigate = scheduledRoute.useNavigate();
  const setSearch = (patch: Partial<ScheduledSearch>, replace = false) =>
    navigate({ search: (s: ScheduledSearch): ScheduledSearch => ({ ...s, ...patch }), replace });
  const { data: functions = [] } = useQuery(functionsQuery(scope));
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canCancel =
    caps !== undefined &&
    !caps.readOnly &&
    caps.operations.includes("writeData") &&
    typeof source.cancelScheduledFunction === "function";
  const list = useInfiniteQuery(scheduledQuery(scope, search.function));
  const liveError = useSchedulesLive();
  const [outcome, setOutcome] = useState<string>();
  const runs = list.data?.pages.flatMap((p) => p.page) ?? [];
  const kindOf = (path: string) => functions.find((f) => f.path === path)?.kind;
  const now = Date.now();
  const open = search.run === undefined ? undefined : (runs.find((r) => r.id === search.run) ?? null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: scheduleKeys.all(scope.scope) });
  const pickerId = useId();

  const columns: DataTableColumn<ScheduledFunction>[] = [
    col.accessor((r) => r.scheduledTime, {
      id: "scheduled",
      header: "Scheduled for",
      cell: (c) => (
        <span className="flex gap-2 font-mono text-xs tabular-nums">
          {formatTime(c.getValue())}
          <span className="text-muted-foreground">{formatRelative(c.getValue(), now)}</span>
        </span>
      ),
    }),
    col.accessor((r) => r.state, {
      id: "state",
      header: "State",
      cell: (c) => <StatusBadge status={c.getValue() === "inProgress" ? "running" : "pending"} />,
    }),
    col.accessor((r) => r.function, {
      id: "function",
      header: "Function",
      cell: (c) => <FunctionName path={c.getValue()} kind={kindOf(c.getValue())} />,
    }),
    col.accessor((r) => r.id, {
      id: "id",
      header: "ID",
      cell: (c) => (
        <span className="font-mono text-xs text-muted-foreground" title={c.getValue()}>
          {c.getValue().slice(0, 8)}
        </span>
      ),
    }),
  ];

  const cancelAll = async () => {
    const { canceled } = await source.cancelAllScheduledFunctions!(search.function);
    setOutcome(`Canceled ${canceled} scheduled ${canceled === 1 ? "run" : "runs"}.`);
    await refresh();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span id={pickerId} className="text-sm text-muted-foreground">
            Function
          </span>
          <Select
            items={[
              { value: ALL, label: "All functions" },
              ...functions.map((f) => ({ value: f.path, label: f.path })),
            ]}
            value={search.function ?? ALL}
            onValueChange={(v) => setSearch({ function: v === ALL ? undefined : (v as string), run: undefined })}
          >
            <SelectTrigger aria-labelledby={pickerId} className="min-w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All functions</SelectItem>
              {functions.map((f) => (
                <SelectItem key={f.path} value={f.path}>
                  {f.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto" />
          {typeof source.cancelAllScheduledFunctions === "function" && (
            <ConfirmButton
              label={search.function ? `Cancel all runs of ${search.function}` : "Cancel all"}
              disabled={!canCancel || !runs.some((r) => r.state === "pending")}
              title={search.function ? `Cancel every pending run of ${search.function}?` : "Cancel every pending run?"}
              description="Runs that have started finish. This cannot be undone."
              confirm="Cancel the runs"
              busy="Canceling…"
              keep="Keep them"
              action={cancelAll}
            />
          )}
        </div>
        {/* the count before the list, as on the other list screens (UX-14) */}
        {!list.isPending && !list.error && (
          <p className="text-sm text-muted-foreground tabular-nums">{`${runs.length}${list.hasNextPage ? "+" : ""} scheduled ${runs.length === 1 && !list.hasNextPage ? "run" : "runs"}`}</p>
        )}
        <p role="status" className="text-sm text-muted-foreground empty:-mt-3">
          {outcome}
        </p>
        {liveError && <ErrorState error={liveError} />}
        {list.error ? (
          <ErrorState error={toDataSourceError(list.error)} />
        ) : (
          <DataTable
            label="Scheduled functions"
            className="max-h-[calc(100svh-16rem)]"
            columns={columns}
            data={runs}
            getRowId={(r) => r.id}
            defaultColumnWidth={(id) => ({ scheduled: 250, state: 100, function: 240, id: 110 })[id] ?? 160}
            onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
            grid={{ activateOnClick: true, onCellActivate: (r) => setSearch({ run: r.id }) }}
            empty={
              list.isPending
                ? "Loading…"
                : search.function
                  ? `No run of ${search.function} is scheduled.`
                  : "Nothing is scheduled. Functions scheduled with ctx.scheduler.runAfter or runAt wait here until they run."
            }
            footer={list.hasNextPage ? <span>{`${runs.length} loaded`}</span> : undefined}
          />
        )}
      </div>
      {open !== undefined && (
        <RunDetails
          run={open}
          kind={open ? kindOf(open.function) : undefined}
          canCancel={canCancel}
          onCanceled={async () => {
            setOutcome("Canceled the scheduled run.");
            setSearch({ run: undefined }, true);
            await refresh();
          }}
          onClose={() => setSearch({ run: undefined })}
        />
      )}
    </div>
  );
}

function RunDetails(props: {
  run: ScheduledFunction | null;
  kind?: FunctionKind;
  canCancel: boolean;
  onCanceled: () => Promise<void>;
  onClose: () => void;
}) {
  const { source } = useQueryScope();
  const { run } = props;
  return (
    <Panel title="Scheduled run" onClose={props.onClose}>
      {run === null ? (
        <p className="text-sm text-muted-foreground">This run is no longer scheduled: it ran, or it was canceled.</p>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Function</dt>
            <dd>
              <FunctionName path={run.function} kind={props.kind} />
            </dd>
            <dt className="text-muted-foreground">ID</dt>
            <dd className="flex items-center gap-2">
              <code className="truncate font-mono text-xs">{run.id}</code>
              <CopyButton text={run.id} label="Copy run ID" iconOnly />
            </dd>
            <dt className="text-muted-foreground">Scheduled for</dt>
            <dd>
              <time dateTime={new Date(run.scheduledTime).toISOString()}>{formatTime(run.scheduledTime)}</time>{" "}
              <span className="text-muted-foreground">({formatRelative(run.scheduledTime, Date.now())})</span>
            </dd>
            <dt className="text-muted-foreground">Scheduled at</dt>
            <dd>
              <time dateTime={new Date(run.creationTime).toISOString()}>{formatTime(run.creationTime)}</time>
            </dd>
            <dt className="text-muted-foreground">State</dt>
            <dd>
              <StatusBadge status={run.state === "inProgress" ? "running" : "pending"} />
            </dd>
          </dl>
          <section aria-label="Arguments">
            <h3 className="mb-1 font-medium">Arguments</h3>
            <pre className="overflow-x-auto border bg-muted/40 p-2 font-mono text-xs">
              {formatLiteral(run.args, "  ")}
            </pre>
          </section>
          {typeof source.cancelScheduledFunction === "function" && (
            <div>
              <ConfirmButton
                label="Cancel run"
                variant="destructive"
                disabled={!props.canCancel || run.state !== "pending"}
                title="Cancel this run?"
                description={`The run of ${run.function} scheduled for ${formatTime(run.scheduledTime)} will not happen. This cannot be undone.`}
                confirm="Cancel run"
                busy="Canceling…"
                keep="Keep it"
                action={async () => {
                  await source.cancelScheduledFunction!(run.id);
                  await props.onCanceled();
                }}
              />
              {run.state !== "pending" && (
                <p className="mt-2 text-xs text-muted-foreground">It has started: it can no longer be canceled.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
