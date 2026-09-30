// The log lines a screen shows (STUDY-12 §7): the newest page of history, then every line the live tail
// delivers, newest first, at most MAX_LOGS. Paused, new lines wait and are counted; resuming shows them.
// Clearing hides what is loaded so far, until the reader asks for it back.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { logsQuery } from "../data/queries.ts";
import type { DataSourceError, LogEntry, LogFilter } from "../data-source.ts";

/** As in Convex's dashboard: the oldest lines go first beyond this. */
export const MAX_LOGS = 10_000;
/** Lines per history page. */
export const LOG_PAGE = 200;

const newestFirst = (a: LogEntry, b: LogEntry) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export type LogLines = {
  /** Newest first, without the cleared ones. */
  lines: LogEntry[];
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Lines that arrived while paused. */
  waiting: number;
  /** Hides every line loaded so far. */
  clear: () => void;
  /** How many lines are hidden by `clear`. */
  cleared: number;
  unclear: () => void;
  /** Loads an older page, when there is one. */
  loadOlder: () => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  pending: boolean;
  /** The history could not be read. */
  error: DataSourceError | null;
  /** The live tail failed. */
  liveError: DataSourceError | undefined;
};

/** `filter` is what the source filters (one function's lines); everything else is filtered on the client. */
export function useLogLines(filter: LogFilter = {}): LogLines {
  const scope = useQueryScope();
  const history = useInfiniteQuery(logsQuery(scope, filter, LOG_PAGE));
  const [live, setLive] = useState<LogEntry[]>([]);
  const [held, setHeld] = useState<LogEntry[]>([]);
  const [paused, setPausedState] = useState(false);
  const [clearedUpTo, setClearedUpTo] = useState<string | null>(null);

  const liveError = useWatch<LogEntry[]>(
    (onEntries, onError) => scope.source.watchLogs(filter, onEntries, onError),
    (entries) => (paused ? setHeld : setLive)((prev) => [...prev, ...entries].slice(-MAX_LOGS)),
    [scope.source, scope.scope, filter.function, filter.levels?.join(",")],
  );

  const setPaused = useCallback(
    (next: boolean) => {
      setPausedState(next);
      if (!next && held.length > 0) {
        setLive((prev) => [...prev, ...held].slice(-MAX_LOGS));
        setHeld([]);
      }
    },
    [held],
  );

  const all = useMemo(() => {
    const byId = new Map<string, LogEntry>();
    for (const page of history.data?.pages ?? []) for (const e of page.page) byId.set(e.id, e);
    for (const e of live) byId.set(e.id, e);
    return [...byId.values()].sort(newestFirst).slice(0, MAX_LOGS);
  }, [history.data, live]);

  const lines = useMemo(() => (clearedUpTo === null ? all : all.filter((e) => e.id > clearedUpTo)), [all, clearedUpTo]);

  return {
    lines,
    paused,
    setPaused,
    waiting: held.length,
    clear: () => setClearedUpTo(all[0]?.id ?? clearedUpTo),
    cleared: all.length - lines.length,
    unclear: () => setClearedUpTo(null),
    loadOlder: () => {
      if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
    },
    hasOlder: history.hasNextPage,
    loadingOlder: history.isFetchingNextPage,
    pending: history.isPending,
    error: history.error ? (history.error as DataSourceError) : null,
    liveError,
  };
}
