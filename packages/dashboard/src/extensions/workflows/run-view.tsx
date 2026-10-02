// One workflow run (UI-01 §26.3): its steps as a diagram, a timeline of when each ran (Gantt), and the journal —
// each step's arguments, result or error (literals), tries and timings. Actions, behind a confirmation and a
// write-capable credential: Cancel (a running run), Rerun (same arguments), Restart from a step (replays the
// journal before it). The selected step is in the URL (`?step=`), shared by the diagram, the timeline and the
// journal.
import { Button } from "@bunvex/ui/components/button";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { useQueryScope } from "../../context.tsx";
import { capabilitiesQuery } from "../../data/queries.ts";
import { toDataSourceError } from "../../data-source.ts";
import { LiteralView } from "../../database/literal-view.tsx";
import { formatTime } from "../../database/values.ts";
import { BAR_TITLE, BAR1 } from "../../shell/bars.ts";
import { ConfirmButton } from "../../shell/confirm.tsx";
import { ErrorState } from "../../shell/error-state.tsx";
import type { WorkflowRun, WorkflowStep } from "./data-source.ts";
import { runQuery, useRefreshWorkflows } from "./queries.ts";
import { duration, elapsed, KIND, STATUS } from "./words.ts";

const RunDiagram = lazy(() => import("./diagram.tsx"));

export function StatusWord({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", s.tone)}>
      <s.icon aria-hidden="true" className="size-3.5" />
      {s.word}
    </span>
  );
}

/** When each step ran, on one time axis from the run's start: a bar per step, the running one up to now. */
export function Timeline(props: {
  journal: WorkflowStep[];
  run: WorkflowRun;
  now: number;
  selected?: number;
  onSelect: (i: number) => void;
}) {
  const start = props.run.startedAt;
  const end = Math.max(props.run.finishedAt ?? props.now, ...props.journal.map((s) => s.finishedAt ?? 0), start + 1);
  const span = end - start;
  return (
    <section aria-label="Timeline" className="border-b px-4 py-3 md:px-6">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">
        Timeline · {formatTime(start)} → {props.run.finishedAt ? formatTime(props.run.finishedAt) : "now"} (
        {duration(span)})
      </h2>
      <ol className="flex flex-col gap-1">
        {props.journal.map((s) => {
          const from = s.startedAt === null ? null : (s.startedAt - start) / span;
          const to = s.startedAt === null ? null : ((s.finishedAt ?? props.now) - start) / span;
          return (
            <li key={s.index}>
              <button
                type="button"
                onClick={() => props.onSelect(s.index)}
                aria-current={props.selected === s.index ? "true" : undefined}
                className="grid w-full grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-center gap-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-muted"
              >
                <span className="truncate font-mono text-xs">
                  {s.index + 1}. {s.name}
                </span>
                <span className="relative h-4">
                  {from !== null && to !== null ? (
                    <span
                      className={cn(
                        "absolute inset-y-0.5 rounded-sm",
                        s.status === "failed"
                          ? "bg-destructive/70"
                          : s.status === "success"
                            ? "bg-foreground/60"
                            : s.status === "canceled"
                              ? "bg-muted-foreground/40"
                              : "bg-info/70",
                      )}
                      style={{ left: `${from * 100}%`, width: `max(2px, ${(to - from) * 100}%)` }}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">not started</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function JournalEntry(props: {
  step: WorkflowStep;
  now: number;
  open: boolean;
  onToggle: () => void;
  restart?: ReactNode;
}) {
  const { step } = props;
  const took = elapsed(step.startedAt, step.finishedAt, props.now);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (props.open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [props.open]);
  return (
    <li ref={ref} className="border-b">
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-6"
      >
        <span className="w-6 text-xs text-muted-foreground tabular-nums">{step.index + 1}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{step.name}</span>
        <span className="text-xs text-muted-foreground">{KIND[step.kind]}</span>
        <StatusWord status={step.status} />
        <span className="w-24 text-right font-mono text-xs text-muted-foreground tabular-nums">
          {took === null ? "—" : duration(took)}
        </span>
      </button>
      {props.open && (
        <div className="grid gap-3 px-4 pb-4 md:grid-cols-2 md:px-6">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs md:col-span-2">
            <dt className="text-muted-foreground">Started</dt>
            <dd className="font-mono">{step.startedAt === null ? "—" : formatTime(step.startedAt)}</dd>
            <dt className="text-muted-foreground">Finished</dt>
            <dd className="font-mono">{step.finishedAt === null ? "—" : formatTime(step.finishedAt)}</dd>
            <dt className="text-muted-foreground">Tries</dt>
            <dd className="font-mono">{step.attempts}</dd>
          </dl>
          <section aria-label={`Arguments of step ${step.index + 1}`}>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Arguments</h3>
            <LiteralView value={step.args} />
          </section>
          <section aria-label={`Outcome of step ${step.index + 1}`}>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{step.error ? "Error" : "Result"}</h3>
            {step.error ? (
              <p className="border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs text-destructive">
                {step.error}
              </p>
            ) : step.result !== undefined ? (
              <LiteralView value={step.result} />
            ) : (
              <p className="text-xs text-muted-foreground">Not finished.</p>
            )}
          </section>
          {props.restart && <div className="md:col-span-2">{props.restart}</div>}
        </div>
      )}
    </li>
  );
}

export function RunView(props: {
  id: string;
  step: number | undefined;
  onStep: (i: number | undefined) => void;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const scope = useQueryScope();
  const { source } = scope;
  const detail = useQuery(runQuery(scope, props.id));
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const canWrite = !!caps && !caps.readOnly && caps.operations.includes("writeData");
  const refresh = useRefreshWorkflows();
  const now = detail.dataUpdatedAt || Date.now();
  const run = detail.data?.run;
  const journal = detail.data?.journal ?? [];
  const select = (i: number) => props.onStep(props.step === i ? undefined : i);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        <Button variant="ghost" size="icon-sm" aria-label="Back to the runs" onClick={props.onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <h1 className={cn(BAR_TITLE, "font-mono")}>{run?.workflow ?? "Run"}</h1>
        {run && <StatusWord status={run.status} />}
        {run && <span className="font-mono text-xs text-muted-foreground">{run.id}</span>}
        <span className="flex-1" />
        {run && canWrite && run.status === "running" && source.cancelWorkflowRun && (
          <ConfirmButton
            label="Cancel run"
            size="sm"
            variant="destructive-outline"
            title="Cancel this run?"
            description="The running step is stopped and no further step starts. The journal is kept."
            confirm="Cancel run"
            busy="Canceling…"
            keep="Keep running"
            action={async () => {
              await source.cancelWorkflowRun!(run.id);
              await refresh(scope.scope);
            }}
          />
        )}
        {run && canWrite && source.rerunWorkflow && (
          <ConfirmButton
            label="Rerun"
            size="sm"
            variant="outline"
            confirmVariant="default"
            title="Run this workflow again?"
            description="A new run starts with the same arguments."
            confirm="Rerun"
            busy="Starting…"
            keep="Not now"
            action={async () => {
              const next = await source.rerunWorkflow!(run.id);
              await refresh(scope.scope);
              props.onOpen(next);
            }}
          />
        )}
      </div>
      {detail.error ? (
        <ErrorState error={toDataSourceError(detail.error)} />
      ) : detail.data === null ? (
        <p className="p-6 text-sm text-muted-foreground">There is no run {props.id}.</p>
      ) : !run ? (
        <p className="p-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {run.error && (
            <p
              role="status"
              className="border-b border-destructive/40 bg-destructive/5 px-4 py-2 font-mono text-xs text-destructive md:px-6"
            >
              {run.error}
            </p>
          )}
          <section aria-label="Steps" className="relative h-[min(46svh,420px)] min-h-64 border-b">
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading the diagram…</p>}>
              <RunDiagram journal={journal} now={now} selected={props.step} onSelect={select} />
            </Suspense>
          </section>
          <Timeline journal={journal} run={run} now={now} selected={props.step} onSelect={select} />
          <section aria-label="Journal">
            <h2 className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground md:px-6">Journal</h2>
            <ol>
              {journal.map((s) => (
                <JournalEntry
                  key={s.index}
                  step={s}
                  now={now}
                  open={props.step === s.index}
                  onToggle={() => select(s.index)}
                  restart={
                    canWrite && source.restartWorkflowFrom && run.status !== "running" ? (
                      <ConfirmButton
                        label={`Restart from step ${s.index + 1}`}
                        size="sm"
                        variant="outline"
                        confirmVariant="default"
                        title={`Restart from step ${s.index + 1}?`}
                        description={`A new run replays steps 1–${s.index} from this journal and runs again from ${s.name}.`}
                        confirm="Restart"
                        busy="Starting…"
                        keep="Not now"
                        action={async () => {
                          const next = await source.restartWorkflowFrom!(run.id, s.index);
                          await refresh(scope.scope);
                          props.onOpen(next);
                        }}
                      />
                    ) : undefined
                  }
                />
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
