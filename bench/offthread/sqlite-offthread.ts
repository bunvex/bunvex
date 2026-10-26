// STUDY-190 prototype, the main-thread side: the product's SQLite driver with its commit writes moved to a writer
// thread (candidate a) and, optionally, its reads to a pool of reader threads (candidate b). Not product code: it
// overrides the driver's methods from outside, and keeps none of the driver's failure handling (a write that
// fails rejects the flush, which the committer treats as a failed flush).
//
// What it keeps: the committer still applies a group's commits in order and awaits one flush at a time, so the
// durable prefix and the order of publication are what they are today. A commit becomes visible to the main
// thread's connection (and to readers) when the writer's transaction commits, which is before the flush resolves,
// and the engine publishes a commit only after its flush: the same rule as today.

import type { DocWrite, IndexEntryAt, IndexWrite } from "@bunvex/core/persistence";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Thread {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private next = 1;
  readonly ready: Promise<void>;
  inFlight = 0;

  constructor(init: { path: string; durable: boolean; role: "writer" | "reader"; cacheBytes?: number }) {
    this.worker = new Worker(new URL("./sqlite-offthread-worker.ts", import.meta.url).href);
    this.ready = new Promise((resolve) => {
      this.worker.onmessage = (e) => {
        if (e.data.ready) {
          this.worker.onmessage = (ev) => this.answer(ev.data);
          resolve();
        }
      };
    });
    this.worker.postMessage(init);
    // A worker does not keep the process alive on its own.
    this.worker.unref();
  }

  private answer(m: { id: number; result?: unknown; error?: { message: string; name: string } }) {
    const p = this.pending.get(m.id)!;
    this.pending.delete(m.id);
    this.inFlight--;
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
    else p.resolve(m.result);
  }

  call<T>(msg: Record<string, unknown>): Promise<T> {
    const id = this.next++;
    this.inFlight++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

export class OffThreadSqlite extends SqlitePersistence {
  private writer: Thread | null = null;
  private readers: Thread[] = [];
  private commits: { ts: bigint; docs: DocWrite[]; idx: IndexWrite[] }[] = [];
  private groupEntries: IndexEntryAt[] = [];
  private nextReader = 0;

  static async open(path: string, opts: { durable: boolean; writer: boolean; readers: number }) {
    const s = new OffThreadSqlite(path, { durable: opts.durable });
    if (opts.writer) s.writer = new Thread({ path, durable: opts.durable, role: "writer", cacheBytes: 16 << 20 });
    for (let i = 0; i < opts.readers; i++)
      s.readers.push(
        new Thread({ path, durable: opts.durable, role: "reader", cacheBytes: Math.ceil((256 << 20) / opts.readers) }),
      );
    await Promise.all([s.writer?.ready, ...s.readers.map((r) => r.ready)]);
    return s;
  }

  override apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    if (!this.writer) return super.apply(ts, docs, idx);
    (this as any).assertWriter();
    this.commits.push({ ts, docs, idx });
  }

  override writeIndexEntries(entries: IndexEntryAt[]): void | Promise<void> {
    if (!this.writer) return super.writeIndexEntries(entries);
    (this as any).assertWriter();
    if (this.commits.length) {
      this.groupEntries.push(...entries);
      return;
    }
    return this.writer.call({ op: "entries", entries });
  }

  override flush(): void | Promise<void> {
    if (!this.writer) return super.flush();
    if (!this.commits.length) return;
    const commits = this.commits;
    const entries = this.groupEntries;
    const top = commits[commits.length - 1]!.ts;
    // A retry after a failure sends the same group again: it stays until the write succeeds.
    return this.writer.call<void>({ op: "group", commits, entries }).then(() => {
      if (this.commits === commits) {
        this.commits = [];
        this.groupEntries = [];
      }
      (this as any).durableTs = top;
    });
  }

  private reader(): Thread | null {
    if (!this.readers.length) return null;
    // The least busy of the pool, round robin among equals.
    let best = this.readers[this.nextReader++ % this.readers.length]!;
    for (const r of this.readers) if (r.inFlight < best.inFlight) best = r;
    return best;
  }

  override scan(...args: Parameters<SqlitePersistence["scan"]>): any {
    const r = this.reader();
    return r ? r.call({ op: "scan", args }) : super.scan(...args);
  }

  override get(...args: Parameters<SqlitePersistence["get"]>): any {
    const r = this.reader();
    return r ? r.call({ op: "get", args }) : super.get(...args);
  }

  override getVersions(...args: Parameters<SqlitePersistence["getVersions"]>): any {
    const r = this.reader();
    return r ? r.call({ op: "getVersions", args }) : super.getVersions(...args);
  }

  override close() {
    this.writer?.terminate();
    for (const r of this.readers) r.terminate();
    super.close();
  }
}
