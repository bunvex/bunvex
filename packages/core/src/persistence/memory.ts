// The memory driver: every version and index entry lives in RAM (B-trees keyed by the encoded bytes);
// durability is one append to a commit log + one fdatasync per GROUP of commits. On open the state is
// rebuilt by replaying the log. Ships with @bunvex/core (its only dependency is sorted-btree).
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L6/L7): the log's first record is a header,
// `{"layout":N}`, written when the log is created (a log written before C10 gets it appended on its next
// open, under the lock). The read-only flag is a file next to the log, `<log>.read-only`.
import { closeSync, existsSync, fdatasyncSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import BTree from "sorted-btree";
import { compareKeys } from "../keyenc.ts";
import type { DocWrite, IndexWrite, Lease, LeaseAcquire, Persistence } from "./index.ts";
import { LeaseLostError } from "./index.ts";
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

type Version<T> = { ts: number; v: T };

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
  if (r && typeof r === "object" && typeof r.ts === "number" && Array.isArray(r.docs) && Array.isArray(r.idx))
    return "commit"; // a log written before C10: the same layout, version 1
  throw foreign();
}

/** Newest version at or before ts (versions are appended in ts order). */
function visible<T>(vs: Version<T>[] | undefined, ts: number): Version<T> | undefined {
  if (!vs) return undefined;
  for (let i = vs.length - 1; i >= 0; i--) if (vs[i].ts <= ts) return vs[i];
  return undefined;
}

export class MemoryPersistence implements Persistence, Lease, ReadOnlyFlag {
  /** PERSIST-01 C7 as an OS lock next to the log, held for the process's life (STUDY-25 L9). */
  readonly leaseScope = "process";
  /** The log's single-writer lock. Replaying (and truncating a torn tail) happens only under it: another
   *  process's open must never cut the log of the one appending to it. */
  private lock: ProcessLock | null = null;
  private logPath: string | null = null;
  private docs = new Map<string, Version<string | null>[]>(); // `${table}:${id}` → versions
  private indexes = new Map<number, BTree<Uint8Array, Version<string | null>[]>>();
  private fh: FileHandle | null = null;
  private pending: Buffer[] = [];
  private durable: boolean;

  private constructor(opts: { durable: boolean }) {
    this.durable = opts.durable;
  }

  private lastTs = 0;

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
      let rec: { ts: number; docs: DocWrite[]; idx: [number, string, string | null][]; layout?: unknown };
      try {
        rec = JSON.parse(line);
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
      this.applyMemory(
        rec.ts,
        rec.docs,
        rec.idx.map(([index, key, id]) => ({ index, key: new Uint8Array(Buffer.from(key, "base64")), id })),
      );
      good += enc.encode(line).length + 1;
      pos = nl + 1;
    }
    if (good < enc.encode(text).length) {
      const { truncate } = await import("node:fs/promises");
      await truncate(logPath, good);
    }
    return stamped;
  }

  maxTs() {
    return this.lastTs;
  }

  auditLiveDocs(table: number, ts: number) {
    let n = 0;
    for (const [k, vs] of this.docs) if (k.startsWith(`${table}:`) && visible(vs, ts)?.v != null) n++;
    return n;
  }

  private tree(index: number) {
    let t = this.indexes.get(index);
    if (!t) {
      t = new BTree<Uint8Array, Version<string | null>[]>(undefined, compareKeys);
      this.indexes.set(index, t);
    }
    return t;
  }

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    if (this.logPath && !this.lock) throw new LeaseLostError("another process holds this memory store's log");
    this.applyMemory(ts, docs, idx);
    if (this.fh !== null) {
      // The log record: ts + the writes. JSON keeps the prototype honest about bytes written; a real
      // engine would use a binary frame with a checksum.
      this.pending.push(
        Buffer.from(
          `${JSON.stringify({ ts, docs, idx: idx.map((e) => [e.index, Buffer.from(e.key).toString("base64"), e.id]) })}\n`,
        ),
      );
    }
  }

  private applyMemory(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    this.lastTs = ts;
    for (const d of docs) {
      const k = `${d.table}:${d.id}`;
      const vs = this.docs.get(k);
      if (vs) vs.push({ ts, v: d.json });
      else this.docs.set(k, [{ ts, v: d.json }]);
    }
    for (const e of idx) {
      const t = this.tree(e.index);
      const vs = t.get(e.key);
      if (vs) vs.push({ ts, v: e.id });
      else t.set(e.key, [{ ts, v: e.id }]);
    }
  }

  // One write + one fdatasync per group, OFF the JS thread (libuv/Bun thread pool): while the disk works,
  // the event loop keeps serving reads and the next group accumulates.
  async flush() {
    if (this.fh === null || this.pending.length === 0) return;
    const buf = Buffer.concat(this.pending);
    this.pending = [];
    if (SYNC_LOG) {
      // Diagnostic path (BUNVEX_SYNC_LOG=1): write + fdatasync on the JS thread.
      writeSync(this.fh.fd, buf);
      if (this.durable) fdatasyncSync(this.fh.fd);
      return;
    }
    await this.fh.write(buf);
    if (this.durable) await this.fh.datasync();
  }

  scan(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    const t = this.indexes.get(index);
    const out: string[] = [];
    if (!t || limit <= 0) return out;
    if (desc) {
      for (const [k, vs] of t.entriesReversed(hi)) {
        if (compareKeys(k, hi) >= 0) continue; // entriesReversed(hi) starts AT hi (inclusive)
        if (compareKeys(k, lo) < 0) break;
        const v = visible(vs, ts);
        if (v && v.v !== null) out.push(v.v);
        if (out.length >= limit) break;
      }
    } else {
      t.forRange(lo, hi, false, (_k, vs) => {
        const v = visible(vs, ts);
        if (v && v.v !== null) out.push(v.v);
        if (out.length >= limit) return { break: true };
      });
    }
    return out;
  }

  get(table: number, id: string, ts: number) {
    return visible(this.docs.get(`${table}:${id}`), ts)?.v ?? null;
  }

  async close() {
    await this.fh?.close();
    this.lock?.release();
    this.lock = null;
  }
}
