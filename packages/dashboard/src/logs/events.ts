// The deployment's events in the log list (STUDY-12 §10.4, L8), as Convex's `interleaveLogs.ts`: the audit log's
// events (§9, the History screen's) from the oldest loaded line on, placed among the lines by time. They are not
// log lines, so the log filters leave them be, as in Convex.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { capabilitiesQuery, dashboardKeys } from "../data/queries.ts";
import type { AuditEvent, LogEntry } from "../data-source.ts";
import { describeEvent } from "../history/describe.ts";

/** A row of the log list: a line, or a deployment event shown as one. */
export type LogRow = LogEntry & { event?: AuditEvent };

const EVENTS_PER_LOOK = 200;

/** The events since `from` (ms), newest first, when the source has an audit log this credential may read. */
export function useLogEvents(from: number | undefined): AuditEvent[] {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const key = [...dashboardKeys.all(scope.scope), "log-events"] as const;
  const enabled =
    from !== undefined &&
    typeof scope.source.listAuditEvents === "function" &&
    (caps?.operations.includes("viewAuditLog") ?? false);
  const { data } = useQuery({
    queryKey: [...key, from ?? null],
    queryFn: ({ signal }) =>
      scope.source.listAuditEvents!({ from, numItems: EVENTS_PER_LOOK, cursor: null }, { signal }).then((p) => p.page),
    enabled,
  });
  useWatch<void>(
    (onChange, onError) => (enabled && scope.source.watchAuditEvents?.(onChange, onError)) || (() => {}),
    () => void queryClient.invalidateQueries({ queryKey: key }),
    [scope.source, scope.scope, enabled],
  );
  return enabled ? (data ?? []) : [];
}

/** An event as a row: at its time, said in words (as History says it). */
export const eventRow = (e: AuditEvent): LogRow => ({
  id: `event:${e.id}`,
  time: e.time,
  level: "info",
  message: describeEvent(e),
  event: e,
});

/** Lines and events, newest first (both come newest first). */
export function interleave(lines: LogEntry[], events: AuditEvent[]): LogRow[] {
  if (events.length === 0) return lines;
  const out: LogRow[] = [];
  let i = 0;
  let j = 0;
  while (i < lines.length || j < events.length) {
    const line = lines[i];
    const event = events[j];
    if (event && (!line || event.time > line.time)) {
      out.push(eventRow(event));
      j++;
    } else if (line) {
      out.push(line);
      i++;
    }
  }
  return out;
}
