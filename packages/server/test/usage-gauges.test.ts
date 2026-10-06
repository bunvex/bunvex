// Storage usage gauges (STUDY-73), as Convex's `UsageGaugesTrackingWorker`: the totals of the
// `current_storage_usage` event (documents, indexes as Convex approximates them, vectors, text, files, the
// virtual tables' documents), sent once the table summaries are built, on a splayed period; and the 1 TiB
// limit on exports that include storage, on the last total.
import { afterEach, expect, test } from "bun:test";
import {
  defineSchema,
  defineTable,
  Engine,
  FILE_STORAGE_TABLE,
  insertJob,
  SCHEDULED_JOB_ARGS_TABLE,
  SCHEDULED_JOBS_TABLE,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v, valueSize } from "@bunvex/values";
import { ExportError, ExportService } from "../src/exports.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { FileStorage } from "../src/storage.ts";
import { storageUsage, UsageGauges } from "../src/usage-gauges.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({
      items: defineTable(v.any())
        .index("by_n", ["n"])
        .index("by_kind", ["kind"])
        .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
        .vectorIndex("by_v", { vectorField: "v", dimensions: 3 }),
      other: defineTable(v.any()),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  stops.push(() => engine.close());
  await engine.summariesReady();
  await engine.searchReady();
  return engine;
}

const sizeOf = async (engine: Engine, table: string) =>
  ((await engine.query((db) => db.asSystem(() => db.query(table).collect()))) as unknown[]).reduce<number>(
    (n, d) => n + valueSize(d as never),
    0,
  );

test("the totals, as Convex sums them", async () => {
  const engine = await setup();
  await engine.mutation(async (db) => {
    await db.insert("items", { n: 1, kind: "a", body: "hello world", v: [1, 0, 0] });
    await db.insert("items", { n: 2, kind: "bb", body: "olá", v: [0, 1, 0] });
    await db.insert("items", { n: 3 }); // no body or vector: in neither search index
    await db.insert("other", { x: "y" });
    await insertJob(db, { name: "m.js:f", args: [{ a: "b" }], scheduledTime: Date.now() + 60_000, now: Date.now() });
  });
  const files = new FileStorage(engine, new MemoryBlobStore(), "http://127.0.0.1:1");
  await files.actionWriter().store(new Blob(["0123456789"]));
  await files.actionWriter().store(new Blob(["x".repeat(20)]));
  const u = await storageUsage(engine);
  const items = await sizeOf(engine, "items");
  const documents = items + (await sizeOf(engine, "other"));
  expect(u).toEqual({
    documentBytes: documents,
    // Two user indexes on `items`: its documents twice; `other` has only system indexes.
    indexBytes: items * 2,
    vectorBytes: 2 * 3 * 4,
    // The body's UTF-8 bytes and `kind`'s sort key (tag, bytes, terminator), per indexed document; the third
    // has neither: no text, and a missing `kind` is `undefined`'s 1-byte key.
    textBytes: 11 + 3 + (Buffer.byteLength("olá") + 4) + (0 + 1),
    fileBytes: 30,
    backupBytes: 0,
    // A virtual table's documents are its system tables' (STUDY-125): `_scheduled_functions` sums the jobs
    // and their arguments.
    systemTableDocumentBytes: {
      _storage: await sizeOf(engine, FILE_STORAGE_TABLE),
      _scheduled_functions:
        (await sizeOf(engine, SCHEDULED_JOBS_TABLE)) + (await sizeOf(engine, SCHEDULED_JOB_ARGS_TABLE)),
    },
  });
  expect(u.systemTableDocumentBytes._storage).toBeGreaterThan(0);
  expect(u.systemTableDocumentBytes._scheduled_functions).toBeGreaterThan(await sizeOf(engine, SCHEDULED_JOBS_TABLE));
});

test("a run sends Convex's event and keeps the file total; nothing before the summaries are built", async () => {
  const engine = await setup();
  const sent: LogEvent[] = [];
  const g = new UsageGauges(engine, (e) => sent.push(...e), { periodMs: 3_600_000 });
  expect(g.latestFileStorageBytes).toBeNull();
  await g.run();
  expect(g.latestFileStorageBytes).toBe(0);
  expect(eventJsonV2(sent[0]!)).toEqual({
    timestamp: expect.any(Number),
    topic: "current_storage_usage",
    total_document_size_bytes: 0,
    total_index_size_bytes: 0,
    total_vector_storage_bytes: 0,
    total_text_storage_bytes: 0,
    total_file_storage_bytes: 0,
    total_backup_storage_bytes: 0,
    total_system_table_document_size_bytes: { _storage: 0, _scheduled_functions: 0 },
  });
  // A fresh engine, its summaries still being built: the run is skipped.
  const fresh = new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }));
  const notYet = new UsageGauges(fresh, (e) => sent.push(...e));
  expect(await notYet.run()).toBeNull();
  expect(sent).toHaveLength(1);
});

test("runs on Convex's splay: half the period plus up to a whole one, then again; stop ends it", async () => {
  const engine = await setup();
  const sent: LogEvent[] = [];
  const g = new UsageGauges(engine, (e) => sent.push(...e), { periodMs: 200, random: () => 0 });
  g.start();
  stops.push(() => g.stop());
  await Bun.sleep(60);
  expect(sent).toHaveLength(0); // not before half the period
  await Bun.sleep(80);
  expect(sent).toHaveLength(1);
  await Bun.sleep(120);
  expect(sent).toHaveLength(2);
  g.stop();
  await Bun.sleep(150);
  expect(sent).toHaveLength(2);
});

test("an export with storage is refused over 1 TiB of files, as Convex's", async () => {
  const engine = await setup();
  let files: number | null = 1.5 * 2 ** 40;
  const svc = new ExportService(engine, new MemoryBlobStore(), null, {
    deploymentName: "x",
    fileStorageBytes: () => files,
  });
  const refused = await svc.request(true).catch((e) => e);
  expect(refused).toBeInstanceOf(ExportError);
  expect(refused).toMatchObject({ status: 400, code: "ExportFileStorageTooLarge" });
  expect(refused.message).toBe(
    "File storage is too large to include in this backup (1.5 TiB > maximum size 1 TiB). You can still create a tables-only backup. Restoring it replaces table data while leaving the target deployment's current file storage unchanged.",
  );
  // Tables only, or before the gauges ran: no check.
  files = null;
  expect(typeof (await svc.request(true))).toBe("string");
});
