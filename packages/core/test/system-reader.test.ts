// `db.system` (Convex's `DatabaseReader.system`) over the virtual system tables (STUDY-125): every query
// method gives `_storage` documents in Convex's virtual shape — the `_file_storage` fields (`storageId`,
// `storageKey`, bytes sha256, int64 size) never leak, whatever the query shape — filters see the virtual
// fields, ids are the system documents' own, and only the `by_id` / `by_creation_time` indexes are reachable.
import { expect, test } from "bun:test";
import { decodeId, v } from "@bunvex/values";
import { FILE_STORAGE_TABLE, SCHEDULED_JOB_ARGS_TABLE, SCHEDULED_JOBS_TABLE, STORAGE_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { argsFromBytes, insertJob } from "../src/scheduled-jobs.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()) });
const PUBLIC_KEYS = ["_creationTime", "_id", "contentType", "sha256", "size"];
const sha = (i: number) => new Uint8Array(32).fill(i).buffer as ArrayBuffer;
const b64 = (i: number) => Buffer.from(sha(i)).toString("base64");

async function withFiles(sizes: number[]) {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  for (const [i, size] of sizes.entries()) {
    await e.mutation((db) =>
      db.asSystem(() =>
        db.insert(FILE_STORAGE_TABLE, {
          storageId: `uuid-${i}`,
          storageKey: `blob-${i}`,
          sha256: sha(i),
          size: BigInt(size),
          contentType: i % 2 ? "text/plain" : null,
        }),
      ),
    );
  }
  return e;
}

const keysOf = (d: unknown) => Object.keys(d as object);

test("every query shape returns the virtual document only", async () => {
  const e = await withFiles([10, 20, 30, 40]);
  const r = await e.query(async (db) => {
    const q = () => db.system.query(STORAGE_TABLE);
    const iterated = [];
    for await (const d of q().order("desc")) iterated.push(d);
    return {
      take: await q().order("desc").take(2),
      first: await q().first(),
      unique: await q()
        .filter((f) => f.eq(f.field("size"), 30))
        .unique(),
      none: await q()
        .filter((f) => f.eq(f.field("size"), 99))
        .first(),
      noneUnique: await q()
        .filter((f) => f.eq(f.field("size"), 99))
        .unique(),
      byCreation: await q()
        .withIndex("by_creation_time", (b) => b.gt("_creationTime", 0))
        .collect(),
      scan: await q().fullTableScan().collect(),
      limited: await q().order("desc").limit(3).collect(),
      page: await q().paginate({ numItems: 3, cursor: null }),
      iterated,
    };
  });
  expect(r.take.map((d) => d.size)).toEqual([40, 30]);
  expect(r.first?.size).toBe(10);
  expect(r.first?.contentType).toBeNull();
  expect(r.unique).toMatchObject({ size: 30, sha256: b64(2), contentType: null });
  expect(r.none).toBeNull();
  expect(r.noneUnique).toBeNull();
  expect(r.byCreation.map((d) => d.size)).toEqual([10, 20, 30, 40]);
  expect(r.scan.length).toBe(4);
  expect(r.limited.map((d) => d.size)).toEqual([40, 30, 20]);
  expect(r.page.page.map((d) => d.size)).toEqual([10, 20, 30]);
  expect(r.page.isDone).toBe(false);
  expect(r.iterated.map((d) => d.size)).toEqual([40, 30, 20, 10]);
  for (const d of [
    ...r.take,
    r.first,
    r.unique,
    ...r.byCreation,
    ...r.scan,
    ...r.limited,
    ...r.page.page,
    ...r.iterated,
  ]) {
    // Convex's document: its keys in its order, sha256 in base64, size a float.
    expect(keysOf(d)).toEqual(PUBLIC_KEYS);
    expect(typeof (d as unknown as { size: unknown }).size).toBe("number");
  }
  await e.close();
});

test("filters run on the virtual fields (base64 sha256, float size), as Convex's", async () => {
  const e = await withFiles([10, 20, 30]);
  const r = await e.query(async (db) => ({
    bySha: await db.system
      .query(STORAGE_TABLE)
      .filter((f) => f.eq(f.field("sha256"), b64(1)))
      .collect(),
    // The system fields are not there to filter on.
    byKey: await db.system
      .query(STORAGE_TABLE)
      .filter((f) => f.eq(f.field("storageKey"), "blob-1"))
      .collect(),
    // A float compares with the stored int64 size made a float; an int64 does not.
    sizeFloat: await db.system
      .query(STORAGE_TABLE)
      .filter((f) => f.gt(f.field("size"), 15))
      .collect(),
    sizeInt: await db.system
      .query(STORAGE_TABLE)
      .filter((f) => f.eq(f.field("size"), 20n))
      .collect(),
    paged: await db.system
      .query(STORAGE_TABLE)
      .filter((f) => f.eq(f.field("contentType"), "text/plain"))
      .paginate({ numItems: 5, cursor: null }),
  }));
  expect(r.bySha.map((d) => d.size)).toEqual([20]);
  expect(r.byKey).toEqual([]);
  expect(r.sizeFloat.map((d) => d.size)).toEqual([20, 30]);
  expect(r.sizeInt).toEqual([]);
  expect(r.paged.page.map((d) => d.size)).toEqual([20]);
  await e.close();
});

test("a virtual document's id is its system document's: same string, the system table's number", async () => {
  const e = await withFiles([5]);
  const { raw, virtual } = await e.query(async (db) => ({
    raw: (await db.asSystem(() => db.query(FILE_STORAGE_TABLE).first()))!,
    virtual: (await db.system.query(STORAGE_TABLE).first())!,
  }));
  expect(virtual._id).toBe(raw._id);
  expect(virtual._creationTime).toBe(raw._creationTime);
  expect(decodeId(virtual._id as string).tableNumber).toBe(540);
  expect(e.catalog.table(FILE_STORAGE_TABLE).number).toBe(540);
  // There is no `_storage` table: the name is virtual.
  expect(e.catalog.tables.has(STORAGE_TABLE)).toBe(false);
  expect(e.catalog.publicNameOf(540)).toBe(STORAGE_TABLE);
  expect(e.catalog.publicNameOf(539)).toBe("_scheduled_functions");
  expect(e.catalog.publicNameOf(e.catalog.table(SCHEDULED_JOB_ARGS_TABLE).number)).toBe(SCHEDULED_JOB_ARGS_TABLE);
  await e.close();
});

test("only the public indexes; no search indexes; other system tables are not accessible", async () => {
  const e = await withFiles([1]);
  await expect(
    e.query(async (db) => db.system.query(STORAGE_TABLE).withIndex("by_storage_id").collect()),
  ).rejects.toThrow("unknown index _storage.by_storage_id");
  await expect(
    e.query(async (db) =>
      db.system
        .query(STORAGE_TABLE)
        .withSearchIndex("s", (q) => q as never)
        .collect(),
    ),
  ).rejects.toThrow("Index _storage.s not found.");
  for (const hidden of ["_tables", FILE_STORAGE_TABLE, SCHEDULED_JOBS_TABLE, SCHEDULED_JOB_ARGS_TABLE])
    await expect(e.query(async (db) => db.system.query(hidden).collect())).rejects.toThrow(
      `System table ${hidden} is not accessible here.`,
    );
  const r = await e.query(async (db) => {
    const id = (await db.system.query(STORAGE_TABLE).first())!._id as string;
    return {
      byId: await db.system.get(id),
      byTable: await db.system.get(STORAGE_TABLE, id),
      normalized: db.system.normalizeId(STORAGE_TABLE, id),
      hiddenTable: db.system.normalizeId("_tables", id),
      physical: db.system.normalizeId(FILE_STORAGE_TABLE, id),
    };
  });
  expect(keysOf(r.byId)).toEqual(PUBLIC_KEYS);
  expect(r.byTable).toEqual(r.byId);
  expect(r.normalized).toBe(r.byId!._id as string);
  expect(r.hiddenTable).toBeNull();
  expect(r.physical).toBeNull();
  await e.close();
});

test("db.system.get and db.get refuse the other kind of table, as Convex's `system_table_guard`", async () => {
  const e = await withFiles([1]);
  const fileId = await e.query(async (db) => (await db.system.query(STORAGE_TABLE).first())!._id as string);
  const itemId = await e.mutation((db) => db.insert("items", { a: 1 }));
  const jobId = await e.mutation((db) =>
    insertJob(db, { name: "m.js:f", args: [{}], scheduledTime: 0, now: Date.now() }),
  );
  const err = (f: () => Promise<unknown>) =>
    f().then(
      () => "ok",
      (x: Error) => x.message,
    );
  expect(await err(() => e.query((db) => db.system.get(itemId)))).toBe(
    "User tables cannot be accessed with db.system.",
  );
  expect(await err(() => e.query((db) => db.get(fileId)))).toBe("System tables can only be accessed with db.system.");
  expect(await err(() => e.query((db) => db.system.get(STORAGE_TABLE, jobId)))).toBe(
    'Invalid argument `id` for `db.system.get`: expected to be an Id<"_storage">, got Id<"_scheduled_functions"> instead.',
  );
  // An id of a private system table reads nothing.
  const argsId = await e.query(
    async (db) => (await db.asSystem(() => db.query(SCHEDULED_JOB_ARGS_TABLE).first()))!._id,
  );
  expect(await e.query((db) => db.system.get(argsId as string))).toBeNull();
  await e.close();
});

test("_scheduled_functions joins each job's arguments from _scheduled_job_args", async () => {
  const e = await withFiles([]);
  const id = await e.mutation((db) =>
    insertJob(db, { name: "m.js:f", args: [{ n: 1n, s: "x" }], scheduledTime: 1_700_000_000_123.5, now: 0 }),
  );
  const { job, raw, args } = await e.query(async (db) => {
    const raw = (await db.asSystem(() => db.get(SCHEDULED_JOBS_TABLE, id)))!;
    const argsDoc = (await db.asSystem(() => db.get(SCHEDULED_JOB_ARGS_TABLE, raw.argsId as string)))!;
    return { job: await db.system.get(id), raw, args: argsFromBytes(argsDoc.args as ArrayBuffer) };
  });
  // The system document, as Convex's `SerializedScheduledJob`: ns times as int64, args elsewhere.
  expect(raw).toMatchObject({
    component: "",
    udfPath: "m.js:f",
    udfArgs: null,
    state: { type: "pending" },
    nextTs: 1_700_000_000_123_500_000n,
    completedTs: null,
    originalScheduledTs: 1_700_000_000_123_500_000n,
    attempts: { systemErrors: 0n, occErrors: 0n },
  });
  expect(args).toEqual([{ n: 1n, s: "x" }]);
  // The virtual document: Convex's keys and order, ms times, `kind`, the args joined in.
  expect(job).toEqual({
    _creationTime: raw._creationTime,
    _id: id,
    args: [{ n: 1n, s: "x" }],
    name: "m.js:f",
    scheduledTime: 1_700_000_000_123.5,
    state: { kind: "pending" },
  });
  expect(keysOf(job)).toEqual(["_creationTime", "_id", "args", "name", "scheduledTime", "state"]);
  await e.close();
});
