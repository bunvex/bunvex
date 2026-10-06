// A log line's details (STUDY-12 §7, UI-01 §22.4): when it was (ISO, local and relative), its level, its
// function, the client that made the request (UI-01 §33), its execution's outcome and duration, the resources it used and who started it, the message,
// every loaded line of the same request, oldest first, and — when the request ran more than one function —
// the functions it called, as a tree (Convex's "Functions Called"; STUDY-12 L6); last, the line as raw JSON.
// "Filter by this request" puts the request id in the text filter. "Why it ran" (STUDY-131 AD-27, a bunvex
// addition) links a live query's run to its entry in Subscriptions, with the invalidation that caused it, and
// a traced run to its trace in the host's trace UI (`DashboardProps.traceUrl`).

import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { JsonView } from "@bunvex/ui/components/json-view";
import { cn } from "@bunvex/ui/lib/utils";
import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { useContext, useId } from "react";
import { clientLine, PlatformIcon } from "../clients/words.tsx";
import { TraceUrlContext, traceHref } from "../context.tsx";
import type { ClientApp, ExecutionLinks, ExecutionRunReason, LogEntry } from "../data-source.ts";
import { DashLink } from "../router.tsx";
import { formatBytes, timeAgo } from "../screens/stats.ts";
import { Panel } from "../shell/panel.tsx";
import { formatTime } from "../shell/time.tsx";
import { type CallNode, callTree, countCalls } from "./call-tree.ts";
import { formatDuration, formatLogTime, isFailure, KIND_LETTER } from "./log-list.tsx";
import { IDENTITY_TEXT, sumUsage } from "./usage.ts";

function CallItem({ node, current }: { node: CallNode; current?: string }) {
  const mine = node.executionId === current;
  return (
    <li>
      <div
        aria-current={mine || undefined}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 aria-[current=true]:bg-muted",
          node.status === "failure" && "text-destructive",
        )}
      >
        {node.status === "running" ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        ) : node.status === "failure" ? (
          <CircleX className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
        )}
        <span className="sr-only">
          {node.status === "running" ? "Running:" : node.status === "failure" ? "Failed:" : "Succeeded:"}
        </span>
        <span className="min-w-0 truncate">{node.function?.path ?? "unknown function"}</span>
        {node.durationMs !== undefined && (
          <span className="text-muted-foreground">({formatDuration(node.durationMs)})</span>
        )}
        {mine && <span className="ml-auto text-muted-foreground">this line</span>}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-3 border-l pl-1">
          {node.children.map((c) => (
            <CallItem key={c.executionId} node={c} current={current} />
          ))}
        </ul>
      )}
    </li>
  );
}

export { timeAgo };

const WHY: Record<ExecutionRunReason, string> = {
  invalidation: "A commit changed what it read",
  newSubscriber: "A new subscriber",
  identityChange: "The client's identity changed",
  codeChange: "New code was pushed",
  retry: "Retried (an index was rebuilding)",
};

/** Why an execution ran and its trace (STUDY-131 AD-27). */
function WhyItRan({ links, path }: { links: ExecutionLinks; path: string | undefined }) {
  const id = useId();
  const template = useContext(TraceUrlContext);
  const sub = links.subscription;
  const trace = links.trace;
  const href = trace && traceHref(template, trace);
  return (
    <section aria-labelledby={id} className="mt-5">
      <h3 id={id} className="mb-2 text-sm font-medium">
        Why it ran
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {sub && (
          <>
            <dt className="text-muted-foreground">Cause</dt>
            <dd className="min-w-0" data-testid="log-why">
              <span>
                {WHY[sub.reason]}
                {sub.invalidation && ` (commit ts ${sub.invalidation.commitTs})`}
              </span>
              {path && (
                <DashLink
                  link={{
                    to: "/subscriptions",
                    search: { path, args: sub.argsDigest, seq: sub.invalidation?.seq },
                  }}
                  className="ml-2 text-primary underline-offset-2 hover:underline"
                >
                  {sub.invalidation ? "Open the invalidation" : "Open in Subscriptions"}
                </DashLink>
              )}
            </dd>
          </>
        )}
        {trace && (
          <>
            <dt className="text-muted-foreground">Trace</dt>
            <dd className="flex min-w-0 items-center gap-1" data-testid="log-trace">
              <span className="truncate font-mono">{trace.traceId}</span>
              <CopyButton text={trace.traceId} label="Copy trace ID" iconOnly />
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 shrink-0 text-primary underline-offset-2 hover:underline"
                >
                  Open trace
                </a>
              )}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

export function LogDetails(props: {
  line: LogEntry;
  /** The loaded lines, to find the rest of the request. */
  lines: LogEntry[];
  onFilterByRequest?: (requestId: string) => void;
  /** The registered apps, to name the line's client (UI-01 §33). */
  apps?: ClientApp[];
  onClose: () => void;
  /** For "58 seconds ago" (tests pin it). */
  now?: number;
}) {
  const { line } = props;
  const callsId = useId();
  const request = line.requestId
    ? props.lines.filter((e) => e.requestId === line.requestId).sort((a, b) => (a.id < b.id ? -1 : 1))
    : [line];
  // this line's execution ends on the line that carries its outcome (not another call's, in the same request)
  const end = request.find((e) => e.execution && (e.executionId === undefined || e.executionId === line.executionId));
  const calls = callTree(request);
  const usage = sumUsage(request);
  const startedBy = end?.execution?.identity;
  const usageId = useId();
  return (
    <Panel
      kind="logs-details"
      focusOnOpen={false}
      title={<span className="font-mono text-sm">{formatLogTime(line.time)}</span>}
      onClose={props.onClose}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Time</dt>
        <dd className="min-w-0">
          <time dateTime={new Date(line.time).toISOString()} className="block font-mono text-xs break-all">
            {new Date(line.time).toISOString()}
          </time>
          <span className="block text-xs text-muted-foreground">
            {formatTime(line.time)} · {timeAgo(line.time, props.now ?? Date.now())}
          </span>
        </dd>
        <dt className="text-muted-foreground">Level</dt>
        <dd
          className={cn(
            "font-mono text-xs leading-5 uppercase",
            line.level === "error" ? "text-destructive" : line.level === "warn" && "text-warning",
          )}
        >
          {line.level}
        </dd>
        {line.function && (
          <>
            <dt className="text-muted-foreground">Function</dt>
            <dd className="flex min-w-0 items-center gap-2 leading-5">
              <abbr
                title={line.function.kind}
                className="shrink-0 border px-1 font-mono text-[10px] leading-4 text-muted-foreground no-underline"
              >
                {KIND_LETTER[line.function.kind]}
              </abbr>
              <span className="truncate font-mono text-xs">{line.function.path}</span>
            </dd>
          </>
        )}
        {line.requestId && (
          <>
            <dt className="text-muted-foreground">Request</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-xs">{line.requestId}</span>
              <CopyButton text={line.requestId} label="Copy request ID" iconOnly />
            </dd>
          </>
        )}
        {line.client && (
          <>
            <dt className="text-muted-foreground">Client</dt>
            <dd className="min-w-0 leading-5" data-testid="log-client">
              <span className="flex min-w-0 items-center gap-1.5">
                <PlatformIcon platform={line.client.platform} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{clientLine(line.client, props.apps)}</span>
              </span>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {line.client.sdk.name} {line.client.sdk.version}
                {line.client.app?.build && ` · build ${line.client.app.build}`}
                {line.client.environment === "development" && " · development"}
              </span>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Outcome</dt>
        <dd className={cn(end?.execution?.status === "failure" && "text-destructive")}>
          {end?.execution
            ? `${end.execution.status === "success" ? "Succeeded" : "Failed"} in ${formatDuration(end.execution.durationMs)}`
            : "Not in the loaded lines"}
        </dd>
        {startedBy && (
          <>
            <dt className="text-muted-foreground">Started by</dt>
            {/* the explanation as a tooltip, not a second line saying the same (UX-24) */}
            <dd title={IDENTITY_TEXT[startedBy][1]}>{IDENTITY_TEXT[startedBy][0]}</dd>
          </>
        )}
      </dl>
      {end?.execution?.links && (end.execution.links.subscription || end.execution.links.trace) && (
        <WhyItRan links={end.execution.links} path={end.function?.path} />
      )}
      {usage && (
        <section aria-labelledby={usageId} className="mt-5">
          <h3 id={usageId} className="mb-2 text-sm font-medium">
            Resources used
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {usage.memoryMb !== undefined && (
              <>
                <dt className="text-muted-foreground">Compute</dt>
                <dd>
                  {usage.memoryMb} MB for {(usage.runtimeMs / 1000).toFixed(2)} s
                </dd>
              </>
            )}
            {(usage.databaseReadBytes !== undefined || usage.databaseWriteBytes !== undefined) && (
              <>
                <dt className="text-muted-foreground">Database</dt>
                <dd>
                  {formatBytes(usage.databaseReadBytes ?? 0)} read, {formatBytes(usage.databaseWriteBytes ?? 0)} written
                </dd>
              </>
            )}
            {(usage.fileReadBytes !== undefined || usage.fileWriteBytes !== undefined) && (
              <>
                <dt className="text-muted-foreground">Files</dt>
                <dd>
                  {formatBytes(usage.fileReadBytes ?? 0)} read, {formatBytes(usage.fileWriteBytes ?? 0)} written
                </dd>
              </>
            )}
            {usage.returnBytes !== undefined && (
              <>
                <dt className="text-muted-foreground">Returned</dt>
                <dd>{formatBytes(usage.returnBytes)}</dd>
              </>
            )}
          </dl>
          {usage.executions > 1 && (
            <p className="mt-1 text-xs text-muted-foreground">
              In total, across the {usage.executions} executions of this request that are loaded.
            </p>
          )}
        </section>
      )}
      <h3 className="mt-5 mb-2 text-sm font-medium">Message</h3>
      <pre
        className={cn(
          "overflow-x-auto border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap",
          isFailure(line) && "text-destructive",
        )}
      >
        {line.message}
      </pre>
      {line.requestId && (
        <>
          <div className="mt-5 mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              This request ({request.length} line{request.length === 1 ? "" : "s"})
            </h3>
            {props.onFilterByRequest && (
              <Button variant="outline" size="sm" onClick={() => props.onFilterByRequest?.(line.requestId!)}>
                Filter by this request
              </Button>
            )}
          </div>
          {countCalls(calls) > 1 && (
            <section aria-labelledby={callsId} className="mb-4">
              <h4 id={callsId} className="mb-1 text-sm font-medium">
                Functions called
              </h4>
              <p className="mb-2 text-xs text-muted-foreground">An outline of the functions this request ran.</p>
              <ul className="border py-1 font-mono text-xs">
                {calls.map((c) => (
                  <CallItem key={c.executionId} node={c} current={line.executionId} />
                ))}
              </ul>
            </section>
          )}
          <ol className="flex flex-col border font-mono text-xs">
            {request.map((e) => (
              <li
                key={e.id}
                aria-current={e.id === line.id || undefined}
                className={cn(
                  "flex gap-3 border-b px-2 py-1 last:border-b-0 aria-[current=true]:bg-muted",
                  isFailure(e) && "text-destructive",
                )}
              >
                <span className="shrink-0 text-muted-foreground uppercase">{e.level}</span>
                <span className="min-w-0 break-words">{e.message}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      <h3 className="mt-5 mb-2 text-sm font-medium">Raw JSON</h3>
      <JsonView value={line} label="This line as JSON" className="text-xs [&_pre]:p-3 [&_pre]:text-xs" />
    </Panel>
  );
}
