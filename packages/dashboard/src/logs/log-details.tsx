// A log line's details (STUDY-12 §7): the line, its function, its execution's outcome and duration, and every
// loaded line of the same request, oldest first. "Filter by this request" puts the request id in the text
// filter.
import { Button } from "@bunvex/ui/components/button";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { cn } from "@bunvex/ui/lib/utils";
import type { LogEntry } from "../data-source.ts";
import { Panel } from "../shell/panel.tsx";
import { formatDuration, formatLogTime, isFailure } from "./log-list.tsx";

export function LogDetails(props: {
  line: LogEntry;
  /** The loaded lines, to find the rest of the request. */
  lines: LogEntry[];
  onFilterByRequest?: (requestId: string) => void;
  onClose: () => void;
}) {
  const { line } = props;
  const request = line.requestId
    ? props.lines.filter((e) => e.requestId === line.requestId).sort((a, b) => (a.id < b.id ? -1 : 1))
    : [line];
  const end = request.find((e) => e.execution);
  return (
    <Panel title={<span className="font-mono text-sm">{formatLogTime(line.time)}</span>} onClose={props.onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {line.function && (
          <>
            <dt className="text-muted-foreground">Function</dt>
            <dd className="min-w-0 truncate font-mono text-xs leading-5">
              {line.function.path} <span className="text-muted-foreground">({line.function.kind})</span>
            </dd>
          </>
        )}
        {line.requestId && (
          <>
            <dt className="text-muted-foreground">Request</dt>
            <dd className="flex min-w-0 items-center gap-1 font-mono text-xs">
              <span className="truncate">{line.requestId}</span>
              <CopyButton text={line.requestId} label="Copy the request id" />
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Outcome</dt>
        <dd className={cn(end?.execution?.status === "failure" && "text-destructive")}>
          {end?.execution
            ? `${end.execution.status === "success" ? "Succeeded" : "Failed"} in ${formatDuration(end.execution.durationMs)}`
            : "Not in the loaded lines"}
        </dd>
      </dl>
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
    </Panel>
  );
}
