// The SQLite store's writer thread (STUDY-190 §4.1, §6 PR 1): every write of a file store runs on a Worker with its
// own connection, the main connection only reads, a commit is acknowledged once the writer has committed it, and a
// failure of the writer (a statement that fails, or the thread dying) fails the pending writes as a write failure
// does: the committer stops (fail-stop, STUDY-25 L4).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { CommitterStoppedError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { internalIdString } from "../src/internal-id.ts";
import { SqlitePersistence, WriterThreadStoppedError } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const dirs: string[] = [];
const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    try {
      await s.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-writer-"));
  dirs.push(d);
  return d;
};
const store = (path = join(tmp(), "db.sqlite"), durable = true) => {
  const s = new SqlitePersistence(path, { durable });
  open.push(s);
  return s;
};
const id = (n: number) => {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setUint32(0, n);
  return internalIdString(b);
};
const T = id(1_000_000);
const I = id(1_000_001);
const key = (n: number) => Uint8Array.from([n >> 8, n & 255, 0, 255, 128]);
const doc = (n: number, json: string | null = `{"n":${n}}`, prevTs: bigint | null = null) => ({
  table: T,
  id: id(n),
  json,
  prevTs,
});
const entry = (n: number) => ({ index: I, key: key(n), table: T, id: id(n) });

/** Rows this handle's own (main) connection has changed since it opened. */
const mainChanges = (s: SqlitePersistence) =>
  ((s as unknown as { db: Database }).db.query("select total_changes() as n").get() as { n: number }).n;
/** The writer thread's Worker, once started. */
const workerOf = (s: SqlitePersistence) =>
  (s as unknown as { thread: { worker: Worker | null } }).thread.worker as Worker;

/** Another process holding the store's SQLite write lock for `ms`; resolves once it holds it. */
async function holdWriteLock(path: string, ms: number) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Database } from "bun:sqlite";
       const db = new Database(process.argv[1]);
       db.exec("pragma busy_timeout = 5000");
       db.exec("begin immediate");
       console.log("ready");
       await Bun.sleep(${ms});
       db.exec("commit");
       db.close();`,
      path,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the lock holder exited before it held the lock: ${out}`);
    out += new TextDecoder().decode(value);
  }
  return proc;
}

describe("every write on the writer's connection", () => {
  test("groups, index entries, prunes, globals and the read-only flag: the main connection changes no row", async () => {
    const s = store();
    for (let ts = 1n; ts <= 3n; ts++) {
      s.apply(ts, [doc(Number(ts))], [entry(Number(ts))]);
      await s.flush();
    }
    await s.writeIndexEntries([{ ...entry(9), id: id(1), ts: 1n }]);
    await s.setGlobal("g", { a: 2n ** 60n });
    expect(await s.pruneIndexes([{ index: I, key: key(9), ts: 1n }])).toBe(1);
    expect(await s.pruneDocuments([{ table: T, id: id(1), ts: 1n }])).toBe(1);
    await s.setReadOnly(true);
    await s.setReadOnly(false);
    expect(s.auditRowCount()).toEqual({ docs: 2, idx: 3 });
    expect(s.getGlobal("g")).toEqual({ a: 2n ** 60n });
    expect(mainChanges(s)).toBe(0);
  });

  test("the wire keeps every value as it was: nulls, keys of any byte, long JSON, timestamps above 2^53", async () => {
    const s = store();
    const big = 1_800_000_000_000_000_000n;
    const json = JSON.stringify({ s: `a:b_${"é𝄞\u0000:".repeat(5000)}` });
    const longKey = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 255);
    const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    s.apply(
      big,
      [doc(1, json), doc(2, null, big - 1n)],
      [
        { index: I, key: longKey, table: T, id: id(1) },
        { index: I, key: allBytes, table: null, id: null },
      ],
    );
    await s.flush();
    expect(s.get(T, id(1), big)).toEqual({ json, ts: big });
    expect(s.get(T, id(2), big)).toBeNull();
    expect(s.readDocumentLog(0n, big, 10)).toEqual([
      { ts: big, table: T, id: id(1), deleted: false, prevTs: null },
      { ts: big, table: T, id: id(2), deleted: true, prevTs: big - 1n },
    ]);
    expect(s.scan(T, I, new Uint8Array(), Uint8Array.from([255, 255]), big, 10, false)).toEqual([
      { id: id(1), ts: big, json },
    ]);
    const raw = new Database(join(dirs.at(-1)!, "db.sqlite"), { readonly: true });
    const keys = raw.query("select key, deleted, table_id from indexes order by key").all() as {
      key: Uint8Array;
      deleted: number;
      table_id: Uint8Array | null;
    }[];
    raw.close();
    expect(keys.map((k) => [[...k.key], k.deleted, k.table_id === null])).toEqual([
      [[...allBytes], 1, true],
      [[...longKey], 0, false],
    ]);
  });

  test("the main thread runs on while the writer waits for SQLite's write lock", async () => {
    const path = join(tmp(), "db.sqlite");
    const s = store(path);
    s.apply(1n, [doc(1)], []);
    await s.flush(); // the writer is running
    const holder = await holdWriteLock(path, 400);
    s.apply(2n, [doc(2)], []);
    let flushed = false;
    const t0 = performance.now();
    const flushing = (s.flush() as Promise<void>).then(() => {
      flushed = true;
    });
    // A timer fires, and the store reads, while the commit waits: this thread is not blocked.
    await Bun.sleep(20);
    expect(performance.now() - t0).toBeLessThan(300);
    expect(flushed).toBe(false);
    expect(s.get(T, id(1), 10n)).not.toBeNull();
    expect(s.get(T, id(2), 10n)).toBeNull(); // not committed yet: not seen
    await flushing;
    expect(performance.now() - t0).toBeGreaterThan(300);
    expect(await holder.exited).toBe(0);
    expect(s.get(T, id(2), 10n)).toEqual({ json: '{"n":2}', ts: 2n });
  });
});

describe("read-your-writes", () => {
  test("a flushed group is read at once by the main connection, every time", async () => {
    const s = store(undefined, false);
    for (let ts = 1n; ts <= 300n; ts++) {
      const n = Number(ts);
      s.apply(ts, [doc(n, `{"n":${n}}`, null)], [entry(n)]);
      await s.flush();
      expect(s.maxTs()).toBe(ts);
      expect(s.get(T, id(n), ts)?.ts).toBe(ts);
      expect(s.scan(T, I, key(n), key(n + 1), ts, 1, false)).toHaveLength(1);
      expect(s.readDocumentLog(ts - 1n, ts, 1)).toHaveLength(1);
    }
  });

  test("through the engine: a mutation's answer comes after its write, which every later query sees", async () => {
    const e = await new Engine(
      defineSchema({ items: defineTable({ n: v.number() }).index("by_n", ["n"]) }),
      store(),
    ).init();
    open.unshift(e);
    for (let n = 0; n < 100; n++) {
      await e.mutation((db) => db.insert("items", { n }));
      const seen = await e.query((db) =>
        db
          .query("items")
          .withIndex("by_n", (q) => q.eq("n", n))
          .collect(),
      );
      expect(seen).toHaveLength(1);
    }
    expect(await e.query((db) => db.query("items").collect())).toHaveLength(100);
  });
});

describe("a failure in the writer fails the pending writes", () => {
  test("a group that fails is refused whole, as the failure SQLite gave", async () => {
    const s = store();
    s.apply(1n, [doc(1)], []);
    await s.flush();
    s.apply(2n, [doc(2)], [entry(2)]);
    s.apply(1n, [doc(1)], []); // the same (ts, table, id) again: SQLite's primary key refuses it
    const err = await (s.flush() as Promise<void>).catch((x) => x);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("UNIQUE constraint failed");
    expect(err.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    // Rolled back: nothing of the group, not even its first commit.
    expect(s.get(T, id(2), 10n)).toBeNull();
    expect(s.auditRowCount()).toEqual({ docs: 1, idx: 0 });
  });

  test("through the engine: the mutation fails and the committer stops, as an unsure write (fail-stop)", async () => {
    const path = join(tmp(), "db.sqlite");
    store(path).close();
    open.pop();
    // A trigger refuses one document, as a failing disk would refuse any.
    const raw = new Database(path);
    raw.run(`create trigger refuse before insert on documents when new.json_value like '%boom%'
             begin select raise(abort, 'the disk refused it'); end`);
    raw.close();
    const e = await new Engine(defineSchema({ items: defineTable({ s: v.string() }) }), store(path)).init();
    open.unshift(e);
    await e.mutation((db) => db.insert("items", { s: "fine" }));
    const err = await e.mutation((db) => db.insert("items", { s: "boom" })).catch((x) => x);
    expect(err).toBeInstanceOf(CommitterStoppedError);
    expect(err.message).toContain("write failed, unsure if the group committed to disk: the disk refused it");
    expect(e.committer.stopped).not.toBeNull();
    expect(await e.mutation((db) => db.insert("items", { s: "after" })).catch((x) => x)).toBeInstanceOf(
      CommitterStoppedError,
    );
  });

  test("the Worker dying rejects every write it had not answered, and every later one", async () => {
    const path = join(tmp(), "db.sqlite");
    const s = store(path);
    s.apply(1n, [doc(1)], []);
    await s.flush(); // the writer is running
    // A group large enough that the thread is still inserting its rows when it dies.
    const docs = Array.from({ length: 200_000 }, (_, i) => doc(i + 10));
    s.apply(2n, docs, []);
    const flush = (s.flush() as Promise<void>).catch((x) => x);
    const global = (s.setGlobal("g", 1) as Promise<void>).catch((x) => x);
    const prune = (s.pruneDocuments([{ table: T, id: id(1), ts: 0n }]) as Promise<number>).catch((x) => x);
    await Bun.sleep(30);
    workerOf(s).terminate();
    for (const err of [await flush, await global, await prune]) {
      expect(err).toBeInstanceOf(WriterThreadStoppedError);
      expect(err.message).toContain("the SQLite store's writer thread stopped");
    }
    expect(await (s.setGlobal("h", 1) as Promise<void>).catch((x) => x)).toBeInstanceOf(WriterThreadStoppedError);
    // The group's transaction never committed.
    expect(s.maxTs()).toBe(1n);
    expect(s.get(T, id(10), 10n)).toBeNull();
    expect(s.getGlobal("g")).toBeNull();
    s.close(); // does not wait for a thread that is gone
  });

  test("through the engine: the Worker dying stops the committer, as a failed write", async () => {
    const s = store();
    const e = await new Engine(defineSchema({ items: defineTable({ n: v.number() }) }), s).init();
    open.unshift(e);
    await e.mutation((db) => db.insert("items", { n: 1 }));
    const exited = new Promise((resolve) => workerOf(s).addEventListener("close", resolve));
    workerOf(s).terminate();
    await exited;
    const err = await e.mutation((db) => db.insert("items", { n: 2 })).catch((x) => x);
    expect(err).toBeInstanceOf(CommitterStoppedError);
    expect(err.cause).toBeInstanceOf(WriterThreadStoppedError);
    expect(e.committer.stopped).not.toBeNull();
    expect(await e.query((db) => db.query("items").collect())).toHaveLength(1);
  });
});

describe("writes outside a group", () => {
  test("under a stream of groups, prunes, globals and backfilled entries all land, in their own transactions", async () => {
    const s = store(undefined, false);
    const groups = (async () => {
      for (let ts = 1n; ts <= 200n; ts++) {
        const n = Number(ts);
        s.apply(ts, [doc(n), doc(n + 1000)], [entry(n)]);
        await s.flush();
      }
    })();
    const others = (async () => {
      let pruned = 0;
      for (let i = 1; i <= 100; i++) {
        await s.setGlobal(`g${i % 7}`, i);
        await s.writeIndexEntries([{ ...entry(5000 + i), ts: 0n }]);
        pruned += await s.pruneIndexes([{ index: I, key: key(5000 + i), ts: 0n }]);
        pruned += await s.pruneDocuments([{ table: T, id: id(1000 + i), ts: 1n << 40n }]);
      }
      return pruned;
    })();
    await groups;
    const pruned = await others;
    // Each backfilled entry was pruned (100); each pruned document had landed or not yet, as the race went.
    expect(pruned).toBeGreaterThanOrEqual(100);
    expect(s.getGlobal("g3")).toBe(94);
    expect(s.maxTs()).toBe(200n);
    expect(s.auditRowCount().idx).toBe(200);
    expect(mainChanges(s)).toBe(0);
  });
});

describe("shutdown", () => {
  test("close() drains: writes posted but not answered are in the store at the next open", async () => {
    const path = join(tmp(), "db.sqlite");
    const s = store(path);
    s.apply(1n, [doc(1)], [entry(1)]);
    const answers = [s.flush(), s.setGlobal("g", "kept"), s.writeIndexEntries([{ ...entry(2), id: id(1), ts: 1n }])];
    s.close();
    await Promise.all(answers); // answered, not refused
    const again = store(path);
    expect(again.maxTs()).toBe(1n);
    expect(again.getGlobal("g")).toBe("kept");
    expect(again.auditRowCount()).toEqual({ docs: 1, idx: 2 });
  });

  test("releasing the lease waits for the writes posted under it", async () => {
    const s = store();
    expect(await s.acquireLease({ holder: "h", ttlMs: 1000 })).toMatchObject({ epoch: expect.any(Number) });
    s.apply(1n, [doc(1)], []);
    const order: string[] = [];
    const flushing = (s.flush() as Promise<void>).then(() => order.push("flushed"));
    await s.releaseLease().then(() => order.push("released"));
    await flushing;
    expect(order).toEqual(["flushed", "released"]);
  });

  test("the writer keeps a process alive only while a write waits for its answer", async () => {
    const dir = tmp();
    const script = join(dir, "script.ts");
    writeFileSync(
      script,
      `import { SqlitePersistence } from ${JSON.stringify(join(import.meta.dir, "../src/persistence/sqlite.ts"))};
       const s = new SqlitePersistence(${JSON.stringify(join(dir, "db.sqlite"))}, { durable: true });
       s.apply(1n, [{ table: ${JSON.stringify(T)}, id: ${JSON.stringify(id(1))}, json: "{}", prevTs: null }], []);
       await s.flush();
       console.log("flushed", s.maxTs());
       // not closed: the process still ends`,
    );
    const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
    const exited = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "hung")]);
    if (exited === "hung") proc.kill();
    expect(exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("flushed 1n\n");
  });
});

describe("an in-memory store", () => {
  test("has one connection: its writes run inline, and answer at once", () => {
    const s = store(":memory:");
    s.apply(1n, [doc(1)], [entry(1)]);
    expect(s.flush()).toBeUndefined();
    expect(s.setGlobal("g", 1)).toBeUndefined();
    expect(s.pruneIndexes([{ index: I, key: key(1), ts: 0n }])).toBe(0);
    expect(s.get(T, id(1), 1n)).toEqual({ json: '{"n":1}', ts: 1n });
    expect((s as unknown as { thread: unknown }).thread).toBeNull();
  });
});
