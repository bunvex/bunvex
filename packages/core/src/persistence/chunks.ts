// Statement chunking inside one flush (DV-62, STUDY-06 §10). The committer bounds what one flush carries to a
// write batch of whole commits (Convex's 64 documents / 64 KiB), but never splits a commit, so one large
// commit is still flushed whole, in one transaction. A remote driver then splits its rows into several
// statements of that transaction, as Convex's drivers do: Postgres at 1 024 rows per statement
// (crates/postgres/src/lib.rs `INSERTS_PER_STATEMENT`), MySQL by bytes, 10 MiB per INSERT
// (crates/mysql/src/chunks.rs `fill_chunks`, knob `MYSQL_MAX_CHUNK_BYTES`), under its packet limit.
import { knob } from "../knobs.ts";

/** Convex's Postgres `INSERTS_PER_STATEMENT`. */
export const POSTGRES_ROWS_PER_STATEMENT = 1024;
/** Convex's `MYSQL_MAX_CHUNK_BYTES` (10 MiB, under a 16 MiB `max_allowed_packet`). */
export const MYSQL_MAX_CHUNK_BYTES = knob("MYSQL_MAX_CHUNK_BYTES", 10 * 1024 * 1024);

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

/** Convex's `MYSQL_MAX_FILL_CHUNK_ROWS`: rows per INSERT, past which MySQL may scan and lock a whole table. */
export const MYSQL_MAX_FILL_CHUNK_ROWS = knob("MYSQL_MAX_FILL_CHUNK_ROWS", 1024, "positive");
/** Convex's `MYSQL_SMART_CHUNK_MAX_SIZE`: the largest `smartChunks` chunk, in rows. */
export const MYSQL_SMART_CHUNK_MAX_SIZE = knob("MYSQL_SMART_CHUNK_MAX_SIZE", 128, "positive");
/** Convex's `MYSQL_MAX_DYNAMIC_SMART_CHUNK_SIZE`: up to it, any chunk length; past it, powers of two. */
export const MYSQL_MAX_DYNAMIC_SMART_CHUNK_SIZE = knob("MYSQL_MAX_DYNAMIC_SMART_CHUNK_SIZE", 8, "positive");

/**
 * Convex's `smart_chunks` (crates/mysql/src/chunks.rs): as many rows as fit `maxBytes`, up to `maxSize`, then the
 * length rounded down to one of few: any up to `maxDynamic`, else a power of two (`maxSize` at most). So a
 * statement has one of a dozen shapes, and the server can reuse its plans (STUDY-147 §3.6).
 */
export function smartChunks<T>(
  rows: readonly T[],
  size: (row: T) => number = () => 0,
  maxSize = MYSQL_SMART_CHUNK_MAX_SIZE,
  maxDynamic = MYSQL_MAX_DYNAMIC_SMART_CHUNK_SIZE,
  maxBytes = MYSQL_MAX_CHUNK_BYTES,
): T[][] {
  const out: T[][] = [];
  let at = 0;
  while (at < rows.length) {
    let len = 0;
    let bytes = 0;
    for (let i = at; i < rows.length; i++) {
      bytes += size(rows[i]!);
      if (len > maxSize || (len > 0 && bytes > maxBytes)) break;
      len++;
    }
    const n = len <= maxDynamic ? len : len >= maxSize ? maxSize : 2 ** Math.floor(Math.log2(len));
    out.push(rows.slice(at, at + n));
    at += n;
  }
  return out;
}
