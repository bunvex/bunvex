// Statement chunking inside one flush (DV-62, STUDY-06 §10). The committer bounds what one flush carries to a
// write batch of whole commits (Convex's 64 documents / 64 KiB), but never splits a commit, so one large
// commit is still flushed whole, in one transaction. A remote driver then splits its rows into several
// statements of that transaction, as Convex's drivers do: Postgres at 1 024 rows per statement
// (crates/postgres/src/lib.rs `INSERTS_PER_STATEMENT`), MySQL by bytes, 10 MiB per INSERT
// (crates/mysql/src/chunks.rs `fill_chunks`, knob `MYSQL_MAX_CHUNK_BYTES`), under its packet limit.

/** Convex's Postgres `INSERTS_PER_STATEMENT`. */
export const POSTGRES_ROWS_PER_STATEMENT = 1024;
/** Convex's `MYSQL_MAX_CHUNK_BYTES` (10 MiB, under a 16 MiB `max_allowed_packet`). */
export const MYSQL_MAX_CHUNK_BYTES = 10 * 1024 * 1024;

/**
 * Split `rows` into consecutive chunks of at most `maxRows` rows and, by `size`, at most `maxBytes` bytes. A
 * row larger than `maxBytes` gets a chunk of its own, so every row is written (as Convex's `fill_chunks`).
 */
export function chunkRows<T>(
  rows: readonly T[],
  maxRows: number,
  maxBytes = Infinity,
  size?: (row: T) => number,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const r of rows) {
    const n = size ? size(r) : 0;
    if (cur.length && (cur.length >= maxRows || bytes + n > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
