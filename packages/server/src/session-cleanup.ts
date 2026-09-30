// Retention of `_session_requests` (STUDY-23 P6), after Convex's SystemTableCleanupWorker
// (crates/application/src/system_table_cleanup/mod.rs): after a random wait of up to 30 minutes, delete
// the records older than the retention window (two weeks), 64 per transaction and at most 256 per
// second, then wait again. A client that could still resend such an old request is long gone.
import {
  type Engine,
  SESSION_CLEANUP_CHUNK,
  SESSION_CLEANUP_ROWS_PER_SECOND,
  SESSION_REQUEST_RETENTION_MS,
} from "@bunvex/core";

/** Convex's SYSTEM_TABLE_CLEANUP_FREQUENCY: runs start at a random point of each such period. */
export const SESSION_CLEANUP_FREQUENCY_MS = 30 * 60 * 1000;

/**
 * The retention window from the environment: `MAX_SESSION_CLEANUP_DURATION_HOURS` as in Convex (0 keeps
 * records forever), else two weeks.
 */
export function sessionRetentionFromEnv(env = process.env): number | null {
  const h = env.MAX_SESSION_CLEANUP_DURATION_HOURS;
  if (h === undefined || h === "") return SESSION_REQUEST_RETENTION_MS;
  const hours = Number(h);
  if (!Number.isFinite(hours) || hours < 0)
    throw new Error(`MAX_SESSION_CLEANUP_DURATION_HOURS: not a number of hours: ${h}`);
  return hours === 0 ? null : hours * 60 * 60 * 1000;
}

/** One cleanup run: delete every record created before `now - retentionMs`, rate-limited. */
export async function cleanSessionRequests(
  engine: Engine,
  retentionMs: number,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<unknown>; stopped?: () => boolean } = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? Bun.sleep;
  const cutoff = now() - retentionMs;
  let total = 0;
  for (;;) {
    if (opts.stopped?.()) return total;
    const n = await engine.deleteSessionRequests(cutoff, SESSION_CLEANUP_CHUNK);
    total += n;
    if (n < SESSION_CLEANUP_CHUNK) return total;
    // Rate-limit between transactions, not within them (as Convex), to bound the deletion rate.
    await sleep((n / SESSION_CLEANUP_ROWS_PER_SECOND) * 1000);
  }
}

/** Run cleanups in the background until stopped. */
export function startSessionCleanup(engine: Engine, retentionMs: number | null): () => void {
  if (retentionMs === null) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      try {
        await cleanSessionRequests(engine, retentionMs, { stopped: () => stopped });
      } catch (e) {
        if (!engine.committer.stopped) console.error("bunvex: session request cleanup failed", e);
      }
      if (!stopped) schedule();
    }, Math.random() * SESSION_CLEANUP_FREQUENCY_MS);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
