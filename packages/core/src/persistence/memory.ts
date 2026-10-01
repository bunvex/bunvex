// The memory driver: every version and index entry lives in RAM (B-trees keyed by the encoded bytes);
// durability is one append to a commit log + one fdatasync per GROUP of commits. On open the state is
// rebuilt by replaying the log. Ships with @bunvex/core (its only dependency is sorted-btree).
import { fdatasyncSync, writeSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import BTree from "sorted-btree";
import { compareKeys } from "../keyenc.ts";
import type { DocWrite, IndexWrite, Lease, LeaseAcquire, LogCommit, Persistence } from "./index.ts";
import { LeaseLostError } from "./index.ts";
import { ProcessLock } from "./lock.ts";

/** Diagnostic switch: write + fdatasync on the JS thread instead of the thread pool. */
const SYNC_LOG = process.env.BUNVEX_SYNC_LOG === "1";

type Version<T> = { ts: number; v: T };

/** Newest version at or before ts (versions are appended in ts order). */
function visible<T>(vs: Version<T>[] | undefined, ts: number): Version<T> | undefined {
  if (!vs) return undefined;
  for (let i = vs.length - 1; i >= 0; i--) if (vs[i].ts <= ts) return vs[i];
  return undefined;
}

export class MemoryPersistence implements Persistence, Lease {
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
  /** The highest ts made durable by a flush (or replayed from the log): readLog's bound (PERSIST-01 C11). */
  private durableTs = 0;
  /** The log by ts (C11): every commit that wrote index entries, in ts order (apply is called in ts order).
   *  The write arrays are the ones `apply` received, shared with the B-trees' keys: no copy. */
  private commits: { ts: number; writes: IndexWrite[] }[] = [];

  static async open(logPath: string | null, opts: { durable: boolean }) {
    const m = new MemoryPersistence(opts);
    m.logPath = logPath;
    // Load now if the log is free; if another process holds it, acquireLease loads once it is released.
    if (logPath) await m.takeAndLoad();
    return m;
  }

  private async takeAndLoad() {
    const lock = ProcessLock.tryTake(this.logPath!);
    if (!lock) return false;
    this.lock = lock;
    await this.replay(this.logPath!);
    this.fh = await open(this.logPath!, "a");
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
  private async replay(logPath: string) {
    const f = Bun.file(logPath);
    if (!(await f.exists())) return;
    const text = await f.text();
    let good = 0; // byte offset just after the last complete record
    let pos = 0;
    const enc = new TextEncoder();
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos);
      if (nl === -1) break; // torn: no terminator
      const line = text.slice(pos, nl);
      let rec: { ts: number; docs: DocWrite[]; idx: [number, string, string | null][] };
      try {
        rec = JSON.parse(line);
      } catch {
        break; // torn inside the line
      }
      this.applyMemory(
        rec.ts,
        rec.docs,
        rec.idx.map(([index, key, id]) => ({ index, key: new Uint8Array(Buffer.from(key, "base64")), id })),
      );
      good += enc.encode(line).length + 1;
      pos = nl + 1;
    }
    this.durableTs = this.lastTs;
    if (good < enc.encode(text).length) {
      const { truncate } = await import("node:fs/promises");
      await truncate(logPath, good);
    }
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
    if (idx.length) this.commits.push({ ts, writes: idx });
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
      await this.fh.write(buf);
      if (this.durable) await this.fh.datasync();
    }
    this.durableTs = top;
  }

  /** PERSIST-01 C11: a binary search for the first commit after `afterTs`, then a walk. Bounded by what a
   *  flush made durable: a group applied but still being written is not returned. */
  readLog(afterTs: number, upToTs: number, limit: number): LogCommit[] {
    const out: LogCommit[] = [];
    if (limit <= 0) return out;
    const hi = Math.min(upToTs, this.durableTs);
    const cs = this.commits;
    let lo = 0;
    let n = cs.length;
    while (lo < n) {
      const mid = (lo + n) >>> 1;
      if (cs[mid].ts <= afterTs) lo = mid + 1;
      else n = mid;
    }
    let prevTs = lo > 0 ? cs[lo - 1].ts : 0;
    for (let i = lo; i < cs.length && cs[i].ts <= hi && out.length < limit; i++) {
      out.push({ ts: cs[i].ts, prevTs, writes: cs[i].writes.slice() });
      prevTs = cs[i].ts;
    }
    return out;
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
