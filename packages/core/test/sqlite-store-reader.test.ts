// A SQLite store read from another connection than its writer's (STUDY-194 §10.2, 2b step ii): what an execution
// worker opens. It answers as the writer's own connection does at every ts, sees a commit only at or after its ts,
// takes no lock, changes and creates nothing, and refuses writes. The same reads through a Worker are the
// conformance suite's (`bench/drivers/sqlite-worker-reads.ts`).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalIdString } from "../src/internal-id.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence, SqliteStoreReader } from "../src/persistence/sqlite.ts";

const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(() => {
  for (const s of open.splice(0).reverse()) {
    try {
      s.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dbPath = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-sqlite-reader-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const writer = (path: string) => {
  const s = new SqlitePersistence(path, { durable: false });
  open.push(s);
  return s;
};
const reader = (path: string, cacheBytes = 1 << 20) => {
  const r = new SqliteStoreReader(path, { cacheBytes });
  open.push(r);
  return r;
};
/** An internal id (16 bytes) whose bytes are all `n`. */
const id = (n: number) => internalIdString(new Uint8Array(16).fill(n));
const T = id(200);
const I = id(201);
const doc = (d: string, json: string | null, prevTs: bigint | null = null) => ({ table: T, id: d, json, prevTs });
const entry = (k: number, d: string | null) => ({
  index: I,
  key: Uint8Array.of(k),
  table: d === null ? null : T,
  id: d,
});
const ALL = [Uint8Array.of(), Uint8Array.of(0xff)] as const;

describe("the store's reader description", () => {
  test("a file: its absolute path; in memory: none", async () => {
    const path = dbPath();
    expect(writer(path).reader()).toEqual({ driver: "sqlite", path });
    const mem = new SqlitePersistence(":memory:", { durable: false });
    open.push(mem);
    expect(mem.reader()).toBeUndefined();
    const memory = await MemoryPersistence.open(null, { durable: false });
    open.push(memory);
    expect((memory as { reader?: unknown }).reader).toBeUndefined();
  });
});

describe("a reader", () => {
  test("answers as the writer's connection at every ts; a commit after ts is not seen at ts", async () => {
    const path = dbPath();
    const w = writer(path);
    const r = reader(path);
    // Random writes over a few documents, each commit at its own ts, flushed in groups.
    let ts = 0n;
    const prev = new Map<string, bigint>();
    for (let c = 0; c < 60; c++) {
      ts += 1n;
      const d = id(1 + (c % 7));
      const json = c % 5 === 4 ? null : JSON.stringify({ c });
      w.apply(ts, [doc(d, json, prev.get(d) ?? null)], [entry(c % 7, json === null ? null : d)]);
      prev.set(d, ts);
      if (c % 4 === 3) await w.flush();
    }
    await w.flush();
    expect(r.maxTs()).toBe(w.maxTs());
    for (let at = 0n; at <= ts; at++) {
      for (let n = 1; n <= 7; n++) expect(r.get(T, id(n), at)).toEqual(w.get(T, id(n), at));
      expect(r.getVersions(T, [id(1), id(2), id(9)], at)).toEqual(w.getVersions(T, [id(1), id(2), id(9)], at));
      for (const desc of [false, true])
        expect(r.scan(T, I, ...ALL, at, 100, desc)).toEqual(w.scan(T, I, ...ALL, at, 100, desc));
    }
    // A commit after `ts`: unseen at `ts`, seen at its own once the writer committed it.
    const before = r.scan(T, I, ...ALL, ts, 100, false);
    w.apply(ts + 1n, [doc(id(50), '"late"')], [entry(50, id(50))]);
    await w.flush();
    expect(r.scan(T, I, ...ALL, ts, 100, false)).toEqual(before);
    expect(r.get(T, id(50), ts)).toBeNull();
    expect(r.get(T, id(50), ts + 1n)).toEqual({ json: '"late"', ts: ts + 1n });
    expect(r.maxTs()).toBe(ts + 1n);
  });

  test("reads the store's globals", async () => {
    const path = dbPath();
    const w = writer(path);
    await w.setGlobal("k", { a: 2n ** 60n });
    expect(reader(path).getGlobal("k")).toEqual({ a: 2n ** 60n });
  });

  test("takes no lock: it opens while the writer holds the store, and a writer opens while it is open", async () => {
    const path = dbPath();
    const w = writer(path);
    w.apply(1n, [doc(id(1), '"x"')], []);
    await w.flush();
    const r = reader(path);
    expect(await w.acquireLease({ holder: "a", ttlMs: 1000 })).toEqual({ epoch: expect.any(Number) });
    w.close();
    open.splice(open.indexOf(w), 1);
    // The writer gone and the reader still open: another writer takes the store.
    const w2 = writer(path);
    expect(await w2.acquireLease({ holder: "b", ttlMs: 1000 })).toEqual({ epoch: expect.any(Number) });
    expect(r.get(T, id(1), 1n)).toEqual({ json: '"x"', ts: 1n });
  });

  test("creates nothing: a store that does not exist is not opened", () => {
    const path = dbPath();
    expect(() => reader(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  test("changes nothing in the file, and refuses writes", async () => {
    const path = dbPath();
    const w = writer(path);
    w.apply(1n, [doc(id(1), '"x"')], []);
    await w.flush();
    const size = statSync(path).size;
    const r = reader(path);
    const refused = "this SQLite connection only reads: the store's writer is another thread's";
    expect(() => r.apply(2n, [doc(id(2), '"y"')], [])).toThrow(refused);
    expect(() => r.flush()).toThrow(refused);
    expect(() => r.setGlobal("k", 1)).toThrow(refused);
    expect(() => r.writeIndexEntries([])).toThrow(refused);
    expect(statSync(path).size).toBe(size);
    expect(r.maxTs()).toBe(1n);
  });

  test("its page cache is its own, of the size asked for", () => {
    const path = dbPath();
    writer(path);
    const r = reader(path, 8 * 1024 * 1024);
    const db = (r as unknown as { db: { query(s: string): { get(): { cache_size: number } } } }).db;
    expect(db.query("pragma cache_size").get().cache_size).toBe(-8192);
  });
});
