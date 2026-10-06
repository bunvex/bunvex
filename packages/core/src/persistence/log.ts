// PERSIST-01 C11, the log by timestamp: drivers read `indexes` rows in ts order and hand them here to be
// cut into commits, each with the ts of the commit before it (`prevTs`).
import type { IndexWrite, LogCommit } from "./index.ts";

/** One `indexes` row, as a by-ts read returns it. */
export type LogRow = IndexWrite & { ts: bigint };

/**
 * Cut `rows` (whole commits, sorted by ts) into commits. `prevTs` is the ts of the newest commit at or
 * before the read's `afterTs` (0n if none): the first commit's predecessor.
 */
export function groupLog(rows: LogRow[], prevTs: bigint): LogCommit[] {
  const out: LogCommit[] = [];
  let cur: LogCommit | null = null;
  for (const r of rows) {
    if (cur === null || r.ts !== cur.ts) {
      if (cur !== null) prevTs = cur.ts;
      cur = { ts: r.ts, prevTs, writes: [] };
      out.push(cur);
    }
    cur.writes.push({ index: r.index, key: r.key, table: r.table, id: r.id });
  }
  return out;
}
