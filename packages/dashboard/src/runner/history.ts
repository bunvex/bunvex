// The runner's history (STUDY-12 §10.2, R2), as Convex's `RunHistory.tsx`: for each function, the arguments of
// its last 25 runs, newest first, kept in this browser per deployment; the same arguments twice in a row are
// one entry. Queries have none: they follow their arguments.
import type { UserIdentity, Value } from "../data-source.ts";

/** `identity`: the user the run acted as (STUDY-12 §10.3), as Convex keeps it with the arguments. */
export type RunHistoryEntry = { args: Record<string, Value>; startedAt: number; identity?: UserIdentity };

export const RUN_HISTORY_LENGTH = 25;
const key = (scope: string, path: string) => `bunvex:run-history:${scope}:${path}`;

export function readRunHistory(scope: string, path: string): RunHistoryEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(scope, path)) ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter(
          (e): e is RunHistoryEntry =>
            typeof e === "object" && e !== null && typeof e.startedAt === "number" && typeof e.args === "object",
        )
      : [];
  } catch {
    return [];
  }
}

/** Adds a run in front, unless it repeats the newest one; returns the history as kept. */
export function appendRunHistory(scope: string, path: string, entry: RunHistoryEntry): RunHistoryEntry[] {
  const before = readRunHistory(scope, path);
  const same = (e: RunHistoryEntry) => JSON.stringify([e.args, e.identity ?? null]);
  if (before[0] && same(before[0]) === same(entry)) return before;
  const after = [entry, ...before].slice(0, RUN_HISTORY_LENGTH);
  try {
    localStorage.setItem(key(scope, path), JSON.stringify(after));
  } catch {
    // storage may be unavailable (private mode): the history lasts for this visit only
  }
  return after;
}
