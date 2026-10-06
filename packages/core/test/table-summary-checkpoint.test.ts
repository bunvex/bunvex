// Table summary checkpoints (STUDY-72), as Convex's: written to the `table_summary_v2` global, loaded on
// start and brought up to date from the document log — the same summaries a scan gives; a checkpoint that
// cannot be used falls back to the scan (DV-318); the worker's pacing (500 commits, 10 min with writes, 4 h).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine, reduceShape } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { fromJsonInteger, jsonInteger, tsGlobal } from "../src/persistence-globals.ts";
import { shapeFromJson, shapeOf, shapeToJson, tableShape } from "../src/shapes.ts";
import { TableSummaries } from "../src/table-summaries.ts";
import { restoreSummaries, SummaryCheckpointer, TABLE_SUMMARY_GLOBAL } from "../src/table-summary-checkpoint.ts";
import { decodeDoc } from "../src/tx.ts";

const schema = defineSchema({ t: defineTable(v.any()), u: defineTable(v.any()) });

async function open(p: MemoryPersistence, summaryCheckpoints?: false) {
  const e = await new Engine(schema, p, summaryCheckpoints === false ? { summaryCheckpoints } : {}).init();
  await e.summariesReady();
  return e;
}

/** Every table's summary, its shape as the dashboard reduces it. */
const summaries = (e: Engine) =>
  Object.fromEntries(
    ["t", "u"].map((name) => {
      const s = e.tableSummaries.get(e.catalog.tables.get(name)!.id);
      return [name, { count: s.count, size: s.size, shape: reduceShape(s.shape, () => undefined) }];
    }),
  );

test("a restart loads the checkpoint and the log since: the summaries a scan gives", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e1 = await open(p);
  const ids = await e1.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push(await db.insert("t", { i, s: `doc ${i}`, tags: i % 2 ? ["x"] : [] }));
    await db.insert("u", { only: true });
    return out;
  });
  await e1.summaryCheckpointer!.tick(true);
  // After the checkpoint: a replace, a patch that changes a field's type, deletes, inserts in both tables.
  await e1.mutation(async (db) => {
    await db.replace(ids[0] as never, { i: 0, s: "replaced" });
    await db.patch(ids[1] as never, { s: 7n });
    await db.delete(ids[2] as never);
    await db.delete(ids[3] as never);
    await db.insert("t", { i: 100, extra: { deep: [1, 2] } });
    await db.insert("u", { only: false, n: 3 });
  });
  await e1.mutation((db) => db.patch(ids[4] as never, { s: null }));
  const expected = summaries(e1);
  await e1.close();

  const e2 = await open(p);
  expect(e2.summariesRestored).toBe(true);
  expect(summaries(e2)).toEqual(expected);
  expect(expected.t.count).toBe(19);
  await e2.close();
  const scanned = await open(p, false);
  expect(scanned.summariesRestored).toBe(false);
  expect(summaries(scanned)).toEqual(expected);
  await scanned.close();
});

test("the restore uses the checkpoint (not a scan), and drops tablets that no longer exist", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e1 = await open(p);
  await e1.mutation((db) => db.insert("t", { a: 1 }));
  await e1.summaryCheckpointer!.tick(true);
  const expected = summaries(e1);
  const tablet = e1.catalog.tables.get("t")!.id;
  await e1.close();
  // A checkpoint that says more than the documents do, and knows a tablet the catalog does not.
  const c = (await p.getGlobal(TABLE_SUMMARY_GLOBAL)) as { tables: Record<string, any> };
  c.tables[tablet]!.totalSize = jsonInteger(fromJsonInteger(c.tables[tablet]!.totalSize) + 1000n);
  c.tables["AAAAAAAAAAAAAAAAAAAAAA"] = c.tables[tablet];
  await p.setGlobal(TABLE_SUMMARY_GLOBAL, c);
  const e2 = await open(p);
  expect(e2.summariesRestored).toBe(true);
  expect(summaries(e2).t.size).toBe(expected.t.size + 1000);
  expect(e2.tableSummaries.get("AAAAAAAAAAAAAAAAAAAAAA").count).toBe(0);
  await e2.close();
});

test("retention passing the checkpoint during the restore makes it fall back", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e1 = await open(p);
  await e1.mutation((db) => db.insert("t", { a: 1 }));
  await e1.summaryCheckpointer!.tick(true);
  await e1.mutation((db) => db.insert("t", { a: 2 }));
  const expected = summaries(e1);
  await e1.close();
  const read = p.readDocumentLog.bind(p);
  p.readDocumentLog = (async (...a: Parameters<typeof read>) => {
    await p.setGlobal("document_min_snapshot_ts", tsGlobal(9_000_000_000_000_000_000n));
    return read(...a);
  }) as unknown as typeof p.readDocumentLog;
  const e2 = await open(p);
  expect(e2.summariesRestored).toBe(false);
  expect(summaries(e2)).toEqual(expected);
  await e2.close();
});

test("a table the log changed but that no longer exists is left out", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e1 = await open(p);
  await e1.mutation((db) => db.insert("t", { a: 1 }));
  await e1.summaryCheckpointer!.tick(true);
  await e1.mutation(async (db) => {
    const all = await db.query("t").collect();
    await db.delete(all[0]!._id as never);
    await db.insert("u", { b: 1 });
  });
  const [t, u] = ["t", "u"].map((n) => e1.catalog.tables.get(n)!.id);
  const at = (e1 as unknown as { committer: { visibleTs: bigint } }).committer.visibleTs;
  await e1.close();
  // As if `t` were deleted: only `u` exists.
  const s = new TableSummaries();
  expect(await restoreSummaries(p, s, at, new Set([u!]), decodeDoc)).toBe(true);
  s.finish();
  expect(s.get(t!).count).toBe(0);
  expect(s.get(u!).count).toBe(1);
});

test("commits while the restore runs are applied after it", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e1 = await open(p);
  await e1.mutation((db) => db.insert("t", { a: 1 }));
  await e1.summaryCheckpointer!.tick(true);
  await e1.close();
  const e2 = await new Engine(schema, p).init();
  // Before the summaries are ready: queued, then applied.
  await e2.mutation((db) => db.insert("t", { a: 2 }));
  await e2.summariesReady();
  expect(e2.summariesRestored).toBe(true);
  expect(summaries(e2).t.count).toBe(2);
  await e2.close();
});

for (const [name, spoil] of [
  ["unreadable", async (p: MemoryPersistence) => p.setGlobal(TABLE_SUMMARY_GLOBAL, { ts: "x", tables: {} })],
  [
    "ahead of the store",
    async (p: MemoryPersistence) =>
      p.setGlobal(TABLE_SUMMARY_GLOBAL, {
        ...((await p.getGlobal(TABLE_SUMMARY_GLOBAL)) as object),
        ts: jsonInteger((1n << 63n) - 1n),
      }),
  ],
  [
    "outside document retention",
    async (p: MemoryPersistence) => p.setGlobal("document_min_snapshot_ts", tsGlobal(9_000_000_000_000_000_000n)),
  ],
  [
    "a shape it did not write",
    async (p: MemoryPersistence) => {
      const c = (await p.getGlobal(TABLE_SUMMARY_GLOBAL)) as { tables: Record<string, any> };
      for (const t of Object.values(c.tables))
        t.inferredTypeWithOptionalFields = { numValues: 1, variant: { kind: "Nope" } };
      await p.setGlobal(TABLE_SUMMARY_GLOBAL, c);
    },
  ],
] as const)
  test(`a checkpoint ${name} falls back to the scan`, async () => {
    const p = await MemoryPersistence.open(null, { durable: false });
    const e1 = await open(p);
    await e1.mutation((db) => db.insert("t", { a: 1 }));
    await e1.summaryCheckpointer!.tick(true);
    await e1.mutation((db) => db.insert("t", { a: "two" }));
    const expected = summaries(e1);
    await e1.close();
    await spoil(p);
    const e2 = await open(p);
    expect(e2.summariesRestored).toBe(false);
    expect(summaries(e2)).toEqual(expected);
    await e2.close();
  });

test("the worker's pacing: 500 commits, 10 min with any, 4 h ± jitter; a lost lease stops it", async () => {
  const written: unknown[] = [];
  let lost = false;
  const store = {
    setGlobal: async (_k: string, v: unknown) => {
      if (lost) throw Object.assign(new Error("lease"), { name: "LeaseLostError" });
      written.push(v);
    },
  };
  const s = { commits: 0, checkpoint: () => ({ ts: "1", tables: {} }) } as unknown as TableSummaries;
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const w = new SummaryCheckpointer(store as never, s, { random: () => 0.5 }); // no jitter
    await w.tick(); // the first one always
    expect(written).toHaveLength(1);
    (s as { commits: number }).commits = 499;
    now += 60_000;
    await w.tick();
    expect(written).toHaveLength(1);
    (s as { commits: number }).commits = 500;
    await w.tick();
    expect(written).toHaveLength(2);
    (s as { commits: number }).commits = 501;
    now += 599_999;
    await w.tick();
    expect(written).toHaveLength(2);
    now += 1;
    await w.tick(); // 10 min, one commit
    expect(written).toHaveLength(3);
    now += 4 * 3600_000 - 1;
    await w.tick(); // no commits: only the maximum age
    expect(written).toHaveLength(3);
    now += 1;
    await w.tick();
    expect(written).toHaveLength(4);
    lost = true;
    await w.tick(true);
    expect(w.stats.errors).toBe(1);
    expect(written).toHaveLength(4);
    // Stopped for good: another process writes now.
    lost = false;
    await w.tick(true);
    expect(written).toHaveLength(4);
    await w.stop();
  } finally {
    Date.now = realNow;
  }
});

test("shapes round-trip through the checkpoint's JSON", () => {
  const docs = [
    { a: 1n, b: "x", c: [1.5, null], d: { e: true, f: new ArrayBuffer(2) } },
    { a: 2n, c: [], d: { e: false, f: new ArrayBuffer(1) } },
  ];
  // 17 kinds of object contract into one with optional fields: the round trip keeps them so.
  const s = tableShape(Array.from({ length: 17 }, (_, i) => ({ a: 1n, [`f${i}`]: 1n })) as never);
  expect(JSON.stringify(shapeToJson(s))).toContain('"optional":true');
  for (const x of [shapeOf(docs[0] as never), s, tableShape([...docs, { a: "s" }, 3n] as never)])
    expect(shapeFromJson(JSON.parse(JSON.stringify(shapeToJson(x))))).toEqual(x);
});
