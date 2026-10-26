// The SQLite store's writes (STUDY-190 §4.1, PR 1): every statement that changes the store, run on one connection
// of their own. A file store runs them on the writer thread (`sqlite-writer-thread.ts`), so the commit of a group
// and its fsync never hold the main thread; an in-memory store (one connection only) runs them inline.
//
// What crosses between the threads is one string per call, never objects (STUDY-190 §4.0: a string of a few KiB
// costs the main thread about 2 µs, the same writes as objects tens of µs). The format is fields one after the
// other: a string is its length, `:`, then its characters; a number is its digits and `:`; null is `_`. Ids stay
// in their string form on the wire: the writer turns them into bytes, off the main thread. Index keys (bytes) are
// sent as one character per byte.
import type { Database, Statement } from "bun:sqlite";
import { internalIdBytes } from "../internal-id.ts";
import type { DocPrune, DocWrite, IndexEntryAt, IndexPrune, IndexWrite } from "./index.ts";

/** A tablet's or an index's bytes, by id: few distinct ones, bound on every statement. */
const idBytesCache = new Map<string, Uint8Array>();
export function cachedBytes(id: string): Uint8Array {
  let b = idBytesCache.get(id);
  // Stryker disable next-line ConditionalExpression: a cache: recomputing the bytes gives the same bytes.
  if (b === undefined) {
    b = internalIdBytes(id);
    // Stryker disable next-line all: a cache's bound only limits its memory.
    if (idBytesCache.size > 4096) idBytesCache.clear();
    // Stryker disable next-line CallExpression: a cache: not keeping the bytes only recomputes them.
    idBytesCache.set(id, b);
  }
  return b;
}

/** What a call asks of the writer: the first character of its message. */
export const WriteOp = {
  /** A group of commits, one SQLite transaction: its rows, then its commit (and fsync). */
  Group: "G",
  /** An index backfill's entries at their own ts (PERSIST-01 C17), one transaction. */
  Entries: "E",
  /** Retention's deletes of index versions (PERSIST-01 C13); answers how many rows went. */
  PruneIndexes: "I",
  /** Retention's deletes of document versions (PERSIST-01 C13); answers how many rows went. */
  PruneDocuments: "D",
  /** A persistence global (PERSIST-01 C14): its key, then its JSON text. */
  Global: "S",
  /** The read-only flag: `1` sets it, `0` clears it. */
  ReadOnly: "R",
  /** Nothing: answered once every call posted before it is done. */
  Barrier: "B",
  /** The writer's connection closes; the thread then ends (the thread only, never inline). */
  Close: "C",
} as const;
export type WriteOp = (typeof WriteOp)[keyof typeof WriteOp];

/** Bytes as a string of one character per byte, and back: what a key is on the wire. */
function bytesText(b: Uint8Array): string {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: both forms give the same text.
  if (b.length <= 1024) return String.fromCharCode.apply(null, b as unknown as number[]);
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
}
function textBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/** Builds one message, field by field. */
export class WireWriter {
  private parts: string[] = [];
  /** Whether nothing was written since the last `take`. */
  get empty() {
    return this.parts.length === 0;
  }
  str(s: string) {
    this.parts.push(`${s.length}:`, s);
  }
  opt(s: string | null) {
    if (s === null) this.parts.push("_");
    else this.str(s);
  }
  num(n: number | bigint) {
    this.parts.push(`${n}:`);
  }
  optNum(n: bigint | null) {
    if (n === null) this.parts.push("_");
    else this.num(n);
  }
  bytes(b: Uint8Array) {
    this.str(bytesText(b));
  }
  take(): string {
    const s = this.parts.join("");
    this.parts = [];
    return s;
  }
}

/** Reads a message `WireWriter` built, in the same order. */
class WireReader {
  pos = 0;
  constructor(private s: string) {}
  get done() {
    return this.pos >= this.s.length;
  }
  private head(): string {
    const end = this.s.indexOf(":", this.pos);
    if (end < 0) throw new Error("a malformed write message");
    const h = this.s.slice(this.pos, end);
    this.pos = end + 1;
    return h;
  }
  private isNull(): boolean {
    if (this.s.charCodeAt(this.pos) !== 95 /* _ */) return false;
    this.pos++;
    return true;
  }
  str(): string {
    const n = Number(this.head());
    const v = this.s.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  opt(): string | null {
    return this.isNull() ? null : this.str();
  }
  int(): number {
    return Number(this.head());
  }
  big(): bigint {
    return BigInt(this.head());
  }
  optBig(): bigint | null {
    return this.isNull() ? null : this.big();
  }
  bytes(): Uint8Array {
    return textBytes(this.str());
  }
}

/** One commit of a group, appended to the group's message. */
export function encodeCommit(w: WireWriter, ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
  w.num(ts);
  w.num(docs.length);
  for (const d of docs) {
    w.str(d.table);
    w.str(d.id);
    w.opt(d.json);
    w.optNum(d.prevTs);
  }
  w.num(idx.length);
  for (const e of idx) encodeEntry(w, e);
}

function encodeEntry(w: WireWriter, e: IndexWrite) {
  w.str(e.index);
  w.bytes(e.key);
  w.opt(e.table);
  w.opt(e.id);
}

export function encodeEntries(entries: IndexEntryAt[]): string {
  const w = new WireWriter();
  for (const e of entries) {
    encodeEntry(w, e);
    w.num(e.ts);
  }
  return w.take();
}

export function encodeIndexPrunes(entries: IndexPrune[]): string {
  const w = new WireWriter();
  for (const e of entries) {
    w.str(e.index);
    w.bytes(e.key);
    w.num(e.ts);
  }
  return w.take();
}

export function encodeDocumentPrunes(entries: DocPrune[]): string {
  const w = new WireWriter();
  for (const e of entries) {
    w.str(e.table);
    w.str(e.id);
    w.num(e.ts);
  }
  return w.take();
}

export function encodeGlobalWrite(key: string, json: string): string {
  const w = new WireWriter();
  w.str(key);
  w.str(json);
  return w.take();
}

/** A message: its op, the id its answer carries, then its fields. */
export const message = (op: WriteOp, id: number, payload: string) => `${op}${id}:${payload}`;

/** The connection settings the writer's connection takes. The file's journal mode (WAL) and its tables are the
 *  main connection's, set at the open before any write. */
export function writerPragmas(durable: boolean, cacheKiB: number) {
  return `pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; pragma synchronous = ${durable ? "full" : "off"};
    pragma temp_store = memory; pragma cache_size = -${cacheKiB};`;
}
/** How long a statement waits for another connection's lock before failing with SQLITE_BUSY: rusqlite's default,
 *  which Convex's SQLite store keeps (rusqlite 0.39.0 `InnerConnection::open_with_flags` calls
 *  `sqlite3_busy_timeout(db, 5000)`; crates/sqlite/src/lib.rs `SqlitePersistence::new` sets no other). bun:sqlite
 *  sets none, so without it a read fails at once while another connection holds the file, e.g. one closing. Both
 *  connections of a store take it. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * The store's writes on one connection: Convex's statements (crates/sqlite/src/lib.rs `write`, `DELETE_INDEX`,
 * `DELETE_DOCUMENT`, `WRITE_PERSISTENCE_GLOBAL`, `set_read_only`), each call in a transaction of its own.
 */
export class SqliteWriter {
  private statements: Statement[] = [];
  private insDoc: Statement;
  private insIdx: Statement;
  private putIdx: Statement;
  private pruneIdx: Statement;
  private pruneDoc: Statement;
  private putGlobal: Statement;

  constructor(private db: Database) {
    this.insDoc = this.prepare(
      `insert into documents (id, ts, table_id, json_value, deleted, prev_ts) values (?, ?, ?, ?, ?, ?)`,
    );
    this.insIdx = this.prepare(`insert into indexes values (?, ?, ?, ?, ?, ?)`);
    this.putIdx = this.prepare(`insert or replace into indexes values (?, ?, ?, ?, ?, ?)`);
    this.pruneIdx = this.prepare(`delete from indexes where index_id = ? and ts <= ? and key = ?`);
    this.pruneDoc = this.prepare(`delete from documents where table_id = ? and id = ? and ts <= ?`);
    this.putGlobal = this.prepare(`insert or replace into persistence_globals values (?, ?)`);
  }

  private prepare(sql: string): Statement {
    const st = this.db.prepare(sql);
    this.statements.push(st);
    return st;
  }

  /** Runs one message's writes; what it answers (a count of rows), if anything. Throws what SQLite throws, the
   *  transaction rolled back. */
  run(msg: string): number | undefined {
    const op = msg[0] as WriteOp;
    const r = new WireReader(msg);
    r.pos = 1;
    r.int(); // the id: the caller's business
    switch (op) {
      case WriteOp.Group:
        this.tx(() => {
          while (!r.done) {
            const ts = r.big();
            for (let n = r.int(); n > 0; n--) {
              const table = r.str();
              const id = r.str();
              const json = r.opt();
              const prevTs = r.optBig();
              this.insDoc.run(internalIdBytes(id), ts, cachedBytes(table), json, json === null ? 1 : 0, prevTs);
            }
            for (let n = r.int(); n > 0; n--) this.entry(this.insIdx, r, ts);
          }
        });
        return;
      case WriteOp.Entries:
        this.tx(() => {
          while (!r.done) this.entry(this.putIdx, r, null);
        });
        return;
      case WriteOp.PruneIndexes:
        return this.tx(() => {
          let n = 0;
          while (!r.done) {
            const index = r.str();
            const key = r.bytes();
            n += this.pruneIdx.run(cachedBytes(index), r.big(), key).changes;
          }
          return n;
        });
      case WriteOp.PruneDocuments:
        return this.tx(() => {
          let n = 0;
          while (!r.done) {
            const table = r.str();
            const id = r.str();
            n += this.pruneDoc.run(cachedBytes(table), internalIdBytes(id), r.big()).changes;
          }
          return n;
        });
      case WriteOp.Global: {
        const key = r.str();
        this.putGlobal.run(key, r.str());
        return;
      }
      case WriteOp.ReadOnly:
        if (r.int()) this.db.run(`insert or ignore into read_only (id) values (1)`);
        else this.db.run(`delete from read_only`);
        return;
      case WriteOp.Barrier:
        return;
      default:
        throw new Error(`an unknown write message ${JSON.stringify(op)}`);
    }
  }

  /** One `indexes` row, as Convex's `write`: a tombstone has NULL `table_id` and `document_id`. Its ts is the
   *  commit's, or the entry's own (after its fields) when `ts` is null. */
  private entry(stmt: Statement, r: WireReader, ts: bigint | null) {
    const index = cachedBytes(r.str());
    const key = r.bytes();
    const table = r.opt();
    const id = r.opt();
    const at = ts ?? r.big();
    if (id === null) stmt.run(index, at, key, 1, null, null);
    else stmt.run(index, at, key, 0, cachedBytes(table!), internalIdBytes(id));
  }

  /** `fn` in one transaction: committed (and, on a durable store, synced) when it returns, rolled back if it
   *  throws. */
  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close() {
    for (const st of this.statements.splice(0)) st.finalize();
  }
}

/** The writer thread ended while the store was open (it crashed, or was terminated): every write it had not
 *  answered fails with this, and so does every later one. Whether those reached the store is unknown, as with any
 *  write that fails; the committer stops (fail-stop, STUDY-25 L4). */
export class WriterThreadStoppedError extends Error {
  constructor(
    readonly exitCode: number | null,
    detail?: string,
  ) {
    super(
      `the SQLite store's writer thread stopped (exit code ${exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}); ` +
        "the writes it had not answered may or may not have reached the store",
    );
    this.name = "WriterThreadStoppedError";
  }
}

/** How long `close()` waits for the writer to finish what was posted and close its connection. */
const CLOSE_WAIT_MS = 30_000;

/** A Bun Worker: `ref` and `unref` are Bun's (the DOM's `Worker` type, which an app's typecheck may load, lacks them). */
type ThreadWorker = Worker & { ref(): void; unref(): void };

type Pending = { resolve: (n: number | undefined) => void; reject: (e: Error) => void };

/**
 * The main thread's handle on the writer thread, started at the first write: each call posts one message and
 * resolves with the writer's answer. The Worker keeps the process alive only while a call waits for its answer.
 */
export class WriterThread {
  private worker: ThreadWorker | null = null;
  private pending = new Map<number, Pending>();
  private next = 1;
  /** Set to 1 by the writer once its connection is closed (`close`). */
  private signal = new Int32Array(new SharedArrayBuffer(4));
  /** Why the thread stopped, once it has: every call fails with it. */
  private stopped: Error | null = null;
  private closed = false;
  /** The uncaught error the thread reported before ending, if any. */
  private detail: string | undefined;

  constructor(private init: { path: string; durable: boolean; cacheKiB: number }) {}

  private start(): ThreadWorker {
    const w = new Worker(new URL("./sqlite-writer-thread.ts", import.meta.url).href) as ThreadWorker;
    w.unref();
    w.onmessage = (e: MessageEvent<string>) => this.answer(e.data);
    w.addEventListener("error", (e) => {
      this.detail ??= (e as ErrorEvent).message;
    });
    w.addEventListener("close", (e) => this.ended((e as CloseEvent).code));
    w.postMessage(this.signal.buffer);
    w.postMessage(JSON.stringify(this.init));
    return w;
  }

  call(op: WriteOp, payload = ""): Promise<number | undefined> {
    if (this.stopped) return Promise.reject(this.stopped);
    if (this.closed) return Promise.reject(new Error("the SQLite store is closed"));
    this.worker ??= this.start();
    const w = this.worker;
    const id = this.next++;
    if (this.pending.size === 0) w.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage(message(op, id, payload));
    });
  }

  /** Resolves once every write posted so far is done (or failed); at once if the thread never started. */
  async drain(): Promise<void> {
    if (!this.worker || this.stopped || this.closed) return;
    await this.call(WriteOp.Barrier).catch(() => {});
  }

  private answer(text: string) {
    const a = JSON.parse(text) as { id: number; n?: number; error?: { name: string; message: string; code?: unknown } };
    const p = this.pending.get(a.id);
    // Stryker disable next-line ConditionalExpression: an answer always has its call (the thread answers each once).
    if (!p) return;
    this.pending.delete(a.id);
    if (this.pending.size === 0) this.worker?.unref();
    if (a.error) {
      const e = new Error(a.error.message);
      e.name = a.error.name;
      if (a.error.code !== undefined) Object.assign(e, { code: a.error.code });
      p.reject(e);
    } else p.resolve(a.n);
  }

  /** The thread ended: whatever it did not answer fails, and so does every later call. */
  private ended(code: number) {
    const why = this.closed ? new Error("the SQLite store is closed") : new WriterThreadStoppedError(code, this.detail);
    this.stopped ??= why;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(why);
  }

  /**
   * Waits, blocking this thread, until the writer has run everything posted before it (messages run in order) and
   * closed its connection: a close drains the writes, and the store's last connection to close is the main one,
   * as with one connection. A writer that does not finish within `CLOSE_WAIT_MS` is terminated.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    const w = this.worker;
    if (!w || this.stopped) return;
    w.postMessage(WriteOp.Close);
    const deadline = performance.now() + CLOSE_WAIT_MS;
    while (Atomics.load(this.signal, 0) === 0) {
      const left = deadline - performance.now();
      if (left <= 0 || Atomics.wait(this.signal, 0, 0, left) === "timed-out") {
        w.terminate();
        return;
      }
    }
  }
}
