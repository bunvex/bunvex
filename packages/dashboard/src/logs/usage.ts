// A request's resources and who started it, for a line's details (STUDY-12 §10.5), as Convex's
// `LogMetadata.tsx`: the usage summed over the executions (the loaded lines that end one), and the identity.
import type { ExecutionIdentity, ExecutionUsage, LogEntry } from "../data-source.ts";

export type UsageTotals = ExecutionUsage & { executions: number; runtimeMs: number };

/** The usage of the executions that end among `lines`; null when none carries any. */
export function sumUsage(lines: LogEntry[]): UsageTotals | null {
  const ends = lines.filter((e) => e.execution?.usage);
  if (ends.length === 0) return null;
  const t: UsageTotals = { executions: ends.length, runtimeMs: 0 };
  const add = (k: keyof ExecutionUsage, v: number | undefined) => {
    if (v !== undefined) t[k] = (t[k] ?? 0) + v;
  };
  for (const e of ends) {
    const u = e.execution!.usage!;
    t.runtimeMs += e.execution!.durationMs;
    // memory is the most any execution used, not a sum
    if (u.memoryMb !== undefined) t.memoryMb = Math.max(t.memoryMb ?? 0, u.memoryMb);
    add("databaseReadBytes", u.databaseReadBytes);
    add("databaseWriteBytes", u.databaseWriteBytes);
    add("fileReadBytes", u.fileReadBytes);
    add("fileWriteBytes", u.fileWriteBytes);
    add("returnBytes", u.returnBytes);
  }
  return t;
}

/** Convex's words for who started a request, with what they mean. */
export const IDENTITY_TEXT: Record<ExecutionIdentity, [string, string]> = {
  admin: ["Admin", "Started by a developer with this deployment's admin key."],
  user: ["User", "Started by a user of the app."],
  acting_as_user: ["Admin (acting as a user)", "Started by a developer acting as a user."],
  system: ["System", "Started by the deployment itself: the scheduler or a cron job."],
  unknown: ["Unknown", "Who started it is not known."],
};
