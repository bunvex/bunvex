// Bounded flushes (DV-62, STUDY-06 §9), as Convex's write batcher: a group of commits is written in batches
// of whole commits, each closed once it holds 64 document versions or 64 KiB, one fenced flush each, in ts
// order; a commit is never split, however large. A batch's commits are acknowledged once it is durable.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Committer,
  CommitterStoppedError,
  commitWriteBytes,
  WRITE_BATCH_MAX_BYTES,
  WRITE_BATCH_MAX_DOCUMENTS,
} from "../src/committer.ts";
import { encodeKey } from "../src/keyenc.ts";
import { chunkRows, type DocWrite, type IndexWrite, type Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

const dirs: string[] = [];
const opened: Persistence[] = [];
afterEach(async () => {
  for (const p of opened.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Flush = { ts: number[]; docs: number; bytes: number; last: { docs: number; bytes: number } };

/** A memory store that records what each flush carries, and fails flushes as scripted. */
async function recorded(path: string | null = null) {
  const inner = await MemoryPersistence.open(path, { durable: path !== null });
  opened.push(inner);
  const flushes: Flush[] = [];
  let cur: Flush = { ts: [], docs: 0, bytes: 0, last: { docs: 0, bytes: 0 } };
  const script: (null | ((inner: Persistence) => Promise<void>))[] = [];
  const store: Persistence = Object.create(inner);
  store.apply = (ts: number, docs: DocWrite[], idx: IndexWrite[]) => {
    const bytes = commitWriteBytes(docs, idx);
    cur.ts.push(ts);
    cur.docs += docs.length;
    cur.bytes += bytes;
    cur.last = { docs: docs.length, bytes };
    inner.apply(ts, docs, idx);
  };
  store.flush = async () => {
    const step = script.shift();
    if (step) return step(inner);
    await inner.flush();
    flushes.push(cur);
    cur = { ts: [], docs: 0, bytes: 0, last: { docs: 0, bytes: 0 } };
  };
  return { inner, store, flushes, script };
}

/** One commit of `n` documents of `size` characters each, with one index entry per document. */
let seq = 0;
function commitOf(n: number, size: number) {
  const docs: DocWrite[] = [];
  const idx: IndexWrite[] = [];
  for (let i = 0; i < n; i++) {
    const id = `d${seq++}`;
    docs.push({ table: 1, id, json: JSON.stringify({ id, pad: "x".repeat(size) }) });
    idx.push({ index: 1, key: encodeKey([id]), id });
  }
  return { snapshot: 0, reads: [], docs, idx };
}

/** Every flush obeys Convex's batch rule: everything before its last commit is under both caps. */
function obeysBatchRule(flushes: Flush[]) {
  return flushes.every(
    (f) => f.docs - f.last.docs < WRITE_BATCH_MAX_DOCUMENTS && f.bytes - f.last.bytes < WRITE_BATCH_MAX_BYTES,
  );
}

describe("bounded flushes (DV-62, Convex's write batcher)", () => {
  test("a group over the caps is flushed in batches of whole commits, each within Convex's soft caps", async () => {
    const { store, flushes } = await recorded();
    const c = new Committer(store);
    const published: number[][] = [];
    c.onCommit((entries) => published.push(entries.map((e) => e.ts)));
    // 300 commits queued at once form one group: 300 documents, ~600 KiB.
    const commits = Array.from({ length: 300 }, () => commitOf(1, 2000));
    const ts = await Promise.all(commits.map((x) => c.commit(x)));
    expect(c.groups).toBe(1);
    expect(c.batches).toBe(flushes.length);
    expect(flushes.length).toBeGreaterThan(5);
    expect(obeysBatchRule(flushes)).toBe(true);
    // Whole batches: no flush ends before the caps unless it is the group's last.
    for (const f of flushes.slice(0, -1))
      expect(f.docs >= WRITE_BATCH_MAX_DOCUMENTS || f.bytes >= WRITE_BATCH_MAX_BYTES).toBe(true);
    // Every commit flushed once, in ts order, and published batch by batch in the same order.
    expect(flushes.flatMap((f) => f.ts)).toEqual(ts);
    expect(published).toEqual(flushes.map((f) => f.ts));
    expect(c.visibleTs).toBe(ts[ts.length - 1]);
  });

  test("64 one-document commits fill exactly one batch; the 65th starts the next", async () => {
    const { store, flushes } = await recorded();
    const c = new Committer(store);
    await Promise.all(Array.from({ length: 65 }, () => c.commit(commitOf(1, 10))));
    expect(flushes.map((f) => f.ts.length)).toEqual([64, 1]);
  });

  test("a commit above the caps is never split: it ends the batch it joins", async () => {
    const { store, flushes, inner } = await recorded();
    const c = new Committer(store);
    const small = commitOf(1, 10);
    const huge = commitOf(500, 1000); // 500 documents, ~500 KiB
    const after = commitOf(1, 10);
    const [, hugeTs, afterTs] = await Promise.all([c.commit(small), c.commit(huge), c.commit(after)]);
    expect(flushes.map((f) => f.ts.length)).toEqual([2, 1]);
    expect(flushes[0].docs).toBe(501);
    expect(flushes[1].ts).toEqual([afterTs]);
    for (const d of huge.docs) expect(inner.get(1, d.id, hugeTs)).not.toBeNull();
  });

  test("custom caps (the engine's writeBatch option)", async () => {
    const { store, flushes } = await recorded();
    const c = new Committer(store, {}, undefined, {}, { maxDocuments: 3, maxBytes: Infinity });
    await Promise.all(Array.from({ length: 10 }, () => c.commit(commitOf(1, 10))));
    expect(flushes.map((f) => f.ts.length)).toEqual([3, 3, 3, 1]);
  });

  test("a failed batch stops the committer: earlier batches stay acknowledged, it and later ones are refused, and the store holds a prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-batch-"));
    dirs.push(dir);
    const path = join(dir, "log");
    const { store, script } = await recorded(path);
    const c = new Committer(store, {}, undefined, {}, { maxDocuments: 4, maxBytes: Infinity });
    // Batch 1 lands, batch 2 fails (disk full), batches 3 and later are never written.
    script.push(null, async () => {
      throw new Error("disk full");
    });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => c.commit(commitOf(1, 10))));
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<number>).value);
    expect(ok).toHaveLength(4);
    for (const r of results.slice(4)) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(CommitterStoppedError);
    }
    expect(c.visibleTs).toBe(ok[3]);
    await store.close();
    opened.length = 0;
    // After a restart the store holds exactly the acknowledged prefix.
    const back = await MemoryPersistence.open(path, { durable: true });
    opened.push(back);
    expect(await back.maxTs()).toBe(ok[3]);
  });

  test("a transient failure of a later batch is retried; every commit is acknowledged once, in order", async () => {
    const { store, flushes, script } = await recorded();
    store.isTransient = (e) => (e as Error).message === "reset";
    const c = new Committer(
      store,
      {},
      undefined,
      { initialBackoffMs: 1, maxBackoffMs: 2, onRetry: () => {} },
      { maxDocuments: 4, maxBytes: Infinity },
    );
    script.push(null, async () => {
      throw new Error("reset"); // before reaching the store: it keeps the batch
    });
    const ts = await Promise.all(Array.from({ length: 10 }, () => c.commit(commitOf(1, 10))));
    expect(c.flushFailures).toBe(1);
    expect(c.stopped).toBeNull();
    expect(flushes.map((f) => f.ts.length)).toEqual([4, 4, 2]);
    expect(flushes.flatMap((f) => f.ts)).toEqual(ts);
  });

  test("stopped from outside between two batches (a lost lease): nothing more is written", async () => {
    const { store, flushes } = await recorded();
    const c = new Committer(store, {}, undefined, {}, { maxDocuments: 2, maxBytes: Infinity });
    c.onCommit(() => c.fail(new Error("lease lost")));
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => c.commit(commitOf(1, 10))));
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", ...Array(4).fill("rejected")]);
    expect(flushes).toHaveLength(1);
  });
});

describe("chunkRows (statement chunking inside one flush)", () => {
  test("by rows", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkRows([], 2)).toEqual([]);
  });
  test("by bytes; a row over the limit gets a chunk of its own", () => {
    const size = (n: number) => n;
    expect(chunkRows([3, 3, 3, 9, 1, 1], Infinity, 6, size)).toEqual([[3, 3], [3], [9], [1, 1]]);
  });
});
