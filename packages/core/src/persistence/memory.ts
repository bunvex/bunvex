// The memory driver: every version and index entry lives in RAM (B-trees keyed by the encoded bytes);
// durability is one append to a commit log + one fdatasync per GROUP of commits. On open the state is
// rebuilt by replaying the log. Ships with @bunvex/core (its only dependency is sorted-btree).
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L6/L7): the log's first record is a header,
// `{"layout":N}`, written when the log is created (a log written before C10 gets it appended on its next
// open, under the lock). The read-only flag is a file next to the log, `<log>.read-only`.
//
// Retention (PERSIST-01 C12–C14, STUDY-33): pruning drops old versions from RAM; the log file is not
// compacted (DV-156), so a reopen replays them and retention prunes them again. A global is a log record,
// `{"global":key,"value":…}`, written and synced when it is set.
import { closeSync, existsSync, fdatasyncSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { BTree } from "../btree.ts";
import { opaqueToInspect } from "../inspect.ts";
import { compareKeys } from "../keyenc.ts";
import { decodeGlobal, encodeGlobal } from "./global-json.ts";
import type {
  DocLogRow,
  DocPrune,
  DocVersion,
  DocWrite,
  IndexEntryAt,
  IndexedDoc,
  IndexId,
  IndexPrune,
  IndexWrite,
  InternalId,
  Lease,
  LeaseAcquire,
  Persistence,
  RetentionStore,
  TabletId,
} from "./index.ts";
import { DanglingReferenceError, LeaseLostError } from "./index.ts";
import {
  checkLayoutVersion,
  LAYOUT_VERSION,
  LayoutError,
  type OpenOptions,
  ReadOnlyError,
  type ReadOnlyFlag,
} from "./layout.ts";
import { ProcessLock } from "./lock.ts";

/** Diagnostic switch: write + fdatasync on the JS thread instead of the thread pool. */
const SYNC_LOG = process.env.BUNVEX_SYNC_LOG === "1";

/**
 * One version, stamped with its commit's sequence number in this process (`seq`, an index into
 * `MemoryPersistence.tsOf`), not the ts itself: a read walks many versions, and comparing small numbers is
 * much cheaper than comparing `bigint` timestamps. A read turns its snapshot ts into a sequence bound once.
 */
type Version<T> = { seq: number; v: T };

/** What the first line of a log says about it (PERSIST-01 C10). `complete`: the line has its terminator. */
function firstRecord(line: string, complete: boolean, store: string): "header" | "commit" | "torn" {
  const foreign = () =>
    new LayoutError(`${store} is not a bunvex store: its first line is neither a layout header nor a commit record`);
  if (!complete) {
    if (line.startsWith("{")) return "torn"; // a crash during the very first write: replay cuts it off
    throw foreign();
  }
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    throw foreign();
  }
  const r = rec as Record<string, unknown> | null;
  if (r && typeof r === "object" && "layout" in r) {
    checkLayoutVersion(r.layout, store);
    return "header";
  }
  if (r && typeof r === "object" && typeof r.ts === "string" && Array.isArray(r.docs) && Array.isArray(r.idx))
    return "commit"; // a log written before C10: the same layout, version 1
  throw foreign();
}

/** The first position in `xs` (sorted by ts) whose ts is above `ts`. */
function firstAbove(xs: { ts: bigint }[], ts: bigint, from = 0) {
  let lo = from;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid].ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Drop the versions at or below sequence `seq`; how many went. */
function pruneVersions(vs: Version<unknown>[], seq: number) {
  let n = 0;
  while (n < vs.length && vs[n].seq <= seq) n++;
  if (n) vs.splice(0, n);
  return n;
}

/** Newest version at or before sequence `seq` (versions are appended in commit order). */
function visible<T>(vs: Version<T>[] | undefined, seq: number): Version<T> | undefined {
  if (!vs) return undefined;
  for (let i = vs.length - 1; i >= 0; i--) if (vs[i].seq <= seq) return vs[i];
  return undefined;
}

export class MemoryPersistence implements Persistence, Lease, ReadOnlyFlag, RetentionStore {
  /** PERSIST-01 C7 as an OS lock next to the log, held for the process's life (STUDY-25 L9). */
  readonly leaseScope = "process";
  /** The log's single-writer lock. Replaying (and truncating a torn tail) happens only under it: another
   *  process's open must never cut the log of the one appending to it. */
  private lock: ProcessLock | null = null;
  private logPath: string | null = null;
  private docs = new Map<string, Version<string | null>[]>(); // `${table}:${id}` → versions
  private indexes = new Map<IndexId, BTree<Uint8Array, Version<string | null>[]>>();
  private fh: FileHandle | null = null;
  private pending: Buffer[] = [];
  /** A flush's write in flight (setGlobal appends after it). */
  private writing: Promise<void> | null = null;
  private durable: boolean;

  private constructor(opts: { durable: boolean }) {
    this.durable = opts.durable;
  }

  private lastTs = 0n;
  /** Every applied commit's ts, by sequence number (ascending): what a version's `seq` stands for. */
  private tsOf: bigint[] = [];
  /** The sequence of the last commit at or before `ts` (-1: none). */
  private seqAt(ts: bigint): number {
    const xs = this.tsOf;
    if (xs.length && xs[xs.length - 1] <= ts) return xs.length - 1;
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (xs[mid] <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
  /** The highest ts made durable by a flush (or replayed from the log): the document log's bound (PERSIST-01 C12). */
  private durableTs = 0n;
  /** The document log (C12): every commit that wrote documents, in ts order. */
  private docCommits: { ts: bigint; docs: DocWrite[] }[] = [];
  /** Where the document log starts once retention has forgotten its head (compacted when it gets long). */
  private docCommitsHead = 0;
  /** Persistence globals (C14), replayed from the log. */
  private globals = new Map<string, string>();

  static async open(logPath: string | null, opts: { durable: boolean } & OpenOptions) {
    const m = new MemoryPersistence(opts);
    m.logPath = logPath;
    if (logPath) {
      // PERSIST-01 C10 first, reading only (no lock needed to refuse): the read-only flag, then the header.
      if (!opts.allowReadOnly && existsSync(`${logPath}.read-only`)) throw new ReadOnlyError(m.store);
      m.peekLayout();
      // Load now if the log is free; if another process holds it, acquireLease loads once it is released.
      await m.takeAndLoad();
    }
    return m;
  }

  private get store() {
    return `the memory store's log ${this.logPath}`;
  }

  /** Refuse a foreign or future log from its first line, without reading the rest. */
  private peekLayout() {
    let fd: number;
    try {
      fd = openSync(this.logPath!, "r");
    } catch {
      return; // no log yet: a new store
    }
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n === 0) return;
      const head = buf.subarray(0, n).toString("utf8");
      const nl = head.indexOf("\n");
      if (nl !== -1) firstRecord(head.slice(0, nl), true, this.store);
      // A first line longer than 4 KB is a commit record (a header is a few bytes) or not ours.
      else if (!head.startsWith(`{"ts":`)) firstRecord(head, n < buf.length, this.store);
    } finally {
      closeSync(fd);
    }
  }

  /** Convex's `set_read_only`: no lock needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    if (!this.logPath) return; // nothing outlives this process
    if (readOnly) writeFileSync(`${this.logPath}.read-only`, "");
    else rmSync(`${this.logPath}.read-only`, { force: true });
  }

  private async takeAndLoad() {
    const lock = ProcessLock.tryTake(this.logPath!);
    if (!lock) return false;
    this.lock = lock;
    try {
      const stamped = await this.replay(this.logPath!);
      this.fh = await open(this.logPath!, "a");
      // PERSIST-01 C10 under the lock: a new log starts with its header; one written before C10 gets it now.
      if (!stamped) {
        await this.fh.write(`${JSON.stringify({ layout: LAYOUT_VERSION })}\n`);
        if (this.durable) await this.fh.datasync();
      }
    } catch (e) {
      await this.fh?.close();
      this.fh = null;
      lock.release();
      this.lock = null;
      throw e;
    }
    return true;
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    if (!this.logPath) return { epoch: 1 }; // no log: nothing another process could share
    if (!this.lock && !(await this.takeAndLoad()))
      return { heldBy: ProcessLock.holderOf(this.logPath), expiresInMs: null };
    this.lock!.recordHolder(opts.holder);
    return { epoch: this.lock!.epoch };
  }

  async renewLease() {} // the OS holds the lock for as long as this process lives

  async releaseLease() {
    this.lock?.release();
    this.lock = null;
  }

  /** Rebuild the in-memory state from the log (PERSIST-01 C5). A record is one line; a crash can leave
   *  the LAST line torn — it is cut off (truncating the file) so the next append starts on a boundary.
   *  Records are commits in ts order, so what survives is always a prefix (C4). */
  private async replay(logPath: string): Promise<boolean> {
    const f = Bun.file(logPath);
    if (!(await f.exists())) return false;
    const text = await f.text();
    let stamped = false;
    let good = 0; // byte offset just after the last complete record
    let pos = 0;
    const enc = new TextEncoder();
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos);
      if (pos === 0 && firstRecord(nl === -1 ? text : text.slice(0, nl), nl !== -1, this.store) === "header")
        stamped = true;
      if (nl === -1) break; // torn: no terminator
      const line = text.slice(pos, nl);
      let rec: {
        ts: string;
        docs: [TabletId, InternalId, string | null, string | null][];
        idx: [IndexId, string, TabletId | null, InternalId | null][];
        layout?: unknown;
        global?: string;
        entries?: [IndexId, string, TabletId | null, InternalId | null, string][];
        value?: unknown;
      };
      try {
        // A global's integers above 2^53 (`max_repeatable_ts`) keep their digits.
        rec = (line.startsWith('{"global"') ? decodeGlobal(line) : JSON.parse(line)) as typeof rec;
      } catch {
        break; // torn inside the line
      }
      if (rec.layout !== undefined) {
        // The header (first line), or the one appended to a log written before C10.
        checkLayoutVersion(rec.layout, this.store);
        stamped = true;
        good += enc.encode(line).length + 1;
        pos = nl + 1;
        continue;
      }
      if (rec.global !== undefined) {
        this.globals.set(rec.global, encodeGlobal(rec.value));
        good += enc.encode(line).length + 1;
        pos = nl + 1;
        continue;
      }
      if (rec.entries !== undefined) {
        this.entriesAt(
          rec.entries.map(([index, key, table, id, ts]) => ({
            index,
            key: new Uint8Array(Buffer.from(key, "base64")),
            table,
            id,
            ts: BigInt(ts),
          })),
        );
        good += enc.encode(line).length + 1;
        pos = nl + 1;
        continue;
      }
      this.applyMemory(
        BigInt(rec.ts),
        rec.docs.map(([table, id, json, prev]) => ({ table, id, json, prevTs: prev === null ? null : BigInt(prev) })),
        rec.idx.map(([index, key, table, id]) => ({
          index,
          key: new Uint8Array(Buffer.from(key, "base64")),
          table,
          id,
        })),
      );
      good += enc.encode(line).length + 1;
      pos = nl + 1;
    }
    this.durableTs = this.lastTs;
    if (good < enc.encode(text).length) {
      const { truncate } = await import("node:fs/promises");
      await truncate(logPath, good);
    }
    return stamped;
  }

  maxTs() {
    return this.lastTs;
  }

  auditLiveDocs(table: TabletId, ts: bigint) {
    let n = 0;
    const seq = this.seqAt(ts);
    for (const [k, vs] of this.docs) if (k.startsWith(`${table}:`) && visible(vs, seq)?.v != null) n++;
    return n;
  }

  auditRowCount() {
    let docs = 0;
    let idx = 0;
    for (const vs of this.docs.values()) docs += vs.length;
    for (const t of this.indexes.values()) for (const vs of t.values()) idx += vs.length;
    return { docs, idx };
  }

  private tree(index: IndexId) {
    let t = this.indexes.get(index);
    if (!t) {
      t = new BTree<Uint8Array, Version<string | null>[]>(undefined, compareKeys);
      this.indexes.set(index, t);
    }
    return t;
  }

  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.assertWriter();
    this.applyMemory(ts, docs, idx);
    if (this.fh !== null) {
      // The log record: ts (a decimal string: JSON has no 64-bit integers) + the writes. JSON keeps the
      // prototype honest about bytes written; a real engine would use a binary frame with a checksum.
      this.pending.push(
        Buffer.from(
          `${JSON.stringify({
            ts: String(ts),
            docs: docs.map((d) => [d.table, d.id, d.json, d.prevTs === null ? null : String(d.prevTs)]),
            idx: idx.map((e) => [e.index, Buffer.from(e.key).toString("base64"), e.table, e.id]),
          })}\n`,
        ),
      );
    }
  }

  private applyMemory(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.lastTs = ts;
    const seq = this.tsOf.length;
    this.tsOf.push(ts);
    if (docs.length) this.docCommits.push({ ts, docs });
    for (const d of docs) {
      const k = `${d.table}:${d.id}`;
      const vs = this.docs.get(k);
      if (vs) vs.push({ seq, v: d.json });
      else this.docs.set(k, [{ seq, v: d.json }]);
    }
    for (const e of idx) {
      const t = this.tree(e.index);
      const vs = t.get(e.key);
      if (vs) vs.push({ seq, v: e.id });
      else t.set(e.key, [{ seq, v: e.id }]);
    }
  }

  // One write + one fdatasync per group, OFF the JS thread (libuv/Bun thread pool): while the disk works,
  // the event loop keeps serving reads and the next group accumulates.
  async flush() {
    const top = this.lastTs;
    if (this.fh === null || this.pending.length === 0) {
      this.durableTs = top;
      return;
    }
    const buf = Buffer.concat(this.pending);
    this.pending = [];
    if (SYNC_LOG) {
      // Diagnostic path (BUNVEX_SYNC_LOG=1): write + fdatasync on the JS thread.
      writeSync(this.fh.fd, buf);
      if (this.durable) fdatasyncSync(this.fh.fd);
    } else {
      const fh = this.fh;
      const w = (async () => {
        await fh.write(buf);
        if (this.durable) await fh.datasync();
      })();
      this.writing = w;
      try {
        await w;
      } finally {
        if (this.writing === w) this.writing = null;
      }
    }
    this.durableTs = top;
  }

  /** PERSIST-01 C12: a binary search for the first commit after `afterTs`, then a walk. */
  readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): DocLogRow[] {
    const out: DocLogRow[] = [];
    if (limit <= 0) return out;
    const hi = upToTs < this.durableTs ? upToTs : this.durableTs;
    const cs = this.docCommits;
    for (
      let i = firstAbove(cs, afterTs, this.docCommitsHead), n = 0;
      i < cs.length && cs[i].ts <= hi && n < limit;
      i++, n++
    )
      for (const d of cs[i].docs)
        out.push({ ts: cs[i].ts, table: d.table, id: d.id, deleted: d.json === null, prevTs: d.prevTs });
    return out;
  }

  private assertWriter() {
    if (this.logPath && !this.lock) throw new LeaseLostError("another process holds this memory store's log");
  }

  /** PERSIST-01 C13: drop the versions from RAM, and forget the log up to `through`. */
  pruneIndexes(entries: IndexPrune[], through: bigint) {
    this.assertWriter();
    let n = 0;
    for (const e of entries) {
      const t = this.indexes.get(e.index);
      const vs = t?.get(e.key);
      if (!vs) continue;
      n += pruneVersions(vs, this.seqAt(e.ts));
      if (!vs.length) t!.delete(e.key);
    }
    return n;
  }

  pruneDocuments(entries: DocPrune[], through: bigint) {
    this.assertWriter();
    let n = 0;
    for (const e of entries) {
      const k = `${e.table}:${e.id}`;
      const vs = this.docs.get(k);
      if (!vs) continue;
      n += pruneVersions(vs, this.seqAt(e.ts));
      if (!vs.length) this.docs.delete(k);
    }
    this.docCommitsHead = firstAbove(
      this.docCommits,
      through < this.durableTs ? through : this.durableTs,
      this.docCommitsHead,
    );
    if (this.docCommitsHead > 1024 && this.docCommitsHead * 2 > this.docCommits.length) {
      this.docCommits = this.docCommits.slice(this.docCommitsHead);
      this.docCommitsHead = 0;
    }
    return n;
  }

  /** PERSIST-01 C14: a log record of its own, durable when this returns. */
  getGlobal(key: string): unknown {
    const v = this.globals.get(key);
    return v === undefined ? null : decodeGlobal(v);
  }

  /** PERSIST-01 C17: entries at past timestamps, a log record of their own, durable when this returns. */
  async writeIndexEntries(entries: IndexEntryAt[]) {
    this.assertWriter();
    if (!entries.length) return;
    this.entriesAt(entries);
    while (this.writing) await this.writing.catch(() => {});
    if (this.fh !== null) {
      const rec = entries.map((e) => [e.index, Buffer.from(e.key).toString("base64"), e.table, e.id, String(e.ts)]);
      writeSync(this.fh.fd, `${JSON.stringify({ entries: rec })}\n`);
      if (this.durable) fdatasyncSync(this.fh.fd);
    }
  }

  /** Each entry into its key's versions at its commit's place (replacing one there), by sequence number. */
  private entriesAt(entries: IndexEntryAt[]) {
    for (const e of entries) {
      const seq = this.seqAt(e.ts);
      if (seq < 0 || this.tsOf[seq] !== e.ts) throw new Error(`no commit at ${e.ts} for an index entry at it`);
      const t = this.tree(e.index);
      const vs = t.get(e.key);
      const v = { seq, v: e.id };
      if (!vs) {
        t.set(e.key, [v]);
        continue;
      }
      let i = vs.length;
      while (i > 0 && vs[i - 1].seq > seq) i--;
      if (i > 0 && vs[i - 1].seq === seq) vs[i - 1] = v;
      else vs.splice(i, 0, v);
    }
  }

  async setGlobal(key: string, value: unknown) {
    this.assertWriter();
    this.globals.set(key, encodeGlobal(value));
    // After a group's write in flight, never inside it: records stay whole lines.
    while (this.writing) await this.writing.catch(() => {});
    if (this.fh !== null) {
      writeSync(this.fh.fd, `${encodeGlobal({ global: key, value })}\n`);
      if (this.durable) fdatasyncSync(this.fh.fd);
    }
  }

  scan(table: TabletId, index: IndexId, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean) {
    const t = this.indexes.get(index);
    const out: IndexedDoc[] = [];
    if (!t || limit <= 0) return out;
    const seq = this.seqAt(ts);
    // The entry's document at the entry's own commit (Convex's exact-ts join).
    const join = (v: Version<string | null>) => {
      const id = v.v!;
      const vs = this.docs.get(`${table}:${id}`);
      let doc: Version<string | null> | undefined;
      if (vs) for (let i = vs.length - 1; i >= 0 && vs[i].seq >= v.seq; i--) if (vs[i].seq === v.seq) doc = vs[i];
      const at = this.tsOf[v.seq];
      if (!doc || doc.v === null) throw new DanglingReferenceError(index, id, at, !!doc);
      out.push({ id, ts: at, json: doc.v });
    };
    if (desc) {
      for (const [k, vs] of t.entriesReversed(hi)) {
        if (compareKeys(k, hi) >= 0) continue; // entriesReversed(hi) starts AT hi (inclusive)
        if (compareKeys(k, lo) < 0) break;
        const v = visible(vs, seq);
        if (v && v.v !== null) join(v);
        if (out.length >= limit) break;
      }
    } else {
      t.forRange(lo, hi, false, (_k, vs) => {
        const v = visible(vs, seq);
        if (v && v.v !== null) join(v);
        if (out.length >= limit) return { break: true };
      });
    }
    return out;
  }

  get(table: TabletId, id: InternalId, ts: bigint): DocVersion {
    const v = visible(this.docs.get(`${table}:${id}`), this.seqAt(ts));
    return v && v.v !== null ? { json: v.v, ts: this.tsOf[v.seq] } : null;
  }

  getVersions(table: TabletId, ids: string[], ts: bigint) {
    const seq = this.seqAt(ts);
    return ids.map((id) => {
      const v = visible(this.docs.get(`${table}:${id}`), seq);
      return v && v.v !== null ? { json: v.v, ts: this.tsOf[v.seq] } : null;
    });
  }

  async close() {
    await this.fh?.close();
    this.lock?.release();
    this.lock = null;
  }
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(MemoryPersistence);
