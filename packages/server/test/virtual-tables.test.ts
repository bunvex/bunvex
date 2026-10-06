// Virtual system tables end to end (STUDY-125): apps name `_storage` and `_scheduled_functions`, bunvex stores
// Convex's `_file_storage`, `_scheduled_jobs` and `_scheduled_job_args`. Ids pass `v.id(<virtual>)` in
// arguments and schemas, a job's arguments live in their own document (joined back for `db.system` and the
// executor), and garbage collection deletes both.
import { afterEach, expect, test } from "bun:test";
import {
  defineSchema,
  defineTable,
  Engine,
  FILE_STORAGE_TABLE,
  SCHEDULED_JOB_ARGS_TABLE,
  SCHEDULED_JOBS_TABLE,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { action, Functions, internalMutation, mutation, query } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";
import { FileStorage } from "../src/storage.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({
      uploads: defineTable({ file: v.id("_storage") }),
      runs: defineTable({ job: v.id("_scheduled_functions"), n: v.int64() }),
      done: defineTable(v.any()),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    store: action(async ({ storage }, { text }: { text: string }) => storage.store(new Blob([text]))),
    keep: mutation({
      args: { file: v.id("_storage") },
      handler: async ({ db }, { file }) => db.insert("uploads", { file }),
    }),
    file: query({ args: { file: v.id("_storage") }, handler: async ({ db }, { file }) => db.system.get(file) }),
    rawGet: query(async ({ db }, { id }: { id: string }) => db.get(id as never)),
    schedule: mutation(async ({ db, scheduler }, { n, delay }: { n: bigint; delay?: number }) => {
      const job = await scheduler.runAfter(delay ?? 0, "m:work", { n, blob: new Uint8Array([1, 2, 3]).buffer });
      await db.insert("runs", { job, n });
      return job;
    }),
    job: query({
      args: { job: v.id("_scheduled_functions") },
      handler: async ({ db }, { job }) => db.system.get(job),
    }),
    pending: query(async ({ db }) =>
      db.system
        .query("_scheduled_functions")
        .filter((q) => q.eq(q.field("state.kind"), "pending"))
        .collect(),
    ),
    work: internalMutation(async ({ db }, args: { n: bigint; blob: ArrayBuffer }) => {
      await db.insert("done", { n: args.n, bytes: [...new Uint8Array(args.blob)] });
    }),
  });
  // File storage without a server (whose own executor would run the jobs): the tests start theirs.
  functions.fileStorage = new FileStorage(engine, new MemoryBlobStore(), "http://127.0.0.1:1");
  const raw = (table: string) => engine.query((db) => db.asSystem(() => db.query(table).collect()));
  stops.push(() => engine.close());
  return { engine, functions, raw };
}

const msg = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

test('a `_storage` id passes `v.id("_storage")` in arguments and in a schema; another id does not', async () => {
  const { functions, raw } = await setup();
  const file = (await functions.runAction("m:store", { text: "hello" })) as string;
  // The id is the `_file_storage` document's.
  const [doc] = await raw(FILE_STORAGE_TABLE);
  expect(doc!._id).toBe(file);
  await functions.runMutation("m:keep", { file });
  expect(await functions.runQuery("m:file", { file })).toMatchObject({ _id: file, size: 5, contentType: null });
  const job = (await functions.runMutation("m:schedule", { n: 1n, delay: 60_000 })) as string;
  expect(await msg(functions.runMutation("m:keep", { file: job }))).toContain(
    'which does not match the table name in validator `v.id("_storage")`',
  );
  // An app's `db.get` refuses it: system tables only through `db.system`.
  expect(await msg(functions.runQuery("m:rawGet", { id: file }))).toContain(
    "System tables can only be accessed with db.system.",
  );
});

test("scheduling writes the job and its arguments apart; db.system joins them; filters see the virtual fields", async () => {
  const { functions, raw } = await setup();
  const job = (await functions.runMutation("m:schedule", { n: 7n, delay: 60_000 })) as string;
  const [stored] = await raw(SCHEDULED_JOBS_TABLE);
  const [args] = await raw(SCHEDULED_JOB_ARGS_TABLE);
  expect(stored).toMatchObject({ _id: job, argsId: args!._id, udfPath: "m.js:work", udfArgs: null });
  expect(Object.keys(args!).sort()).toEqual(["_creationTime", "_id", "args"]);
  const virtual = (await functions.runQuery("m:job", { job })) as Record<string, unknown>;
  expect(virtual).toMatchObject({
    _id: job,
    name: "m.js:work",
    args: [{ n: 7n, blob: new Uint8Array([1, 2, 3]).buffer }],
    state: { kind: "pending" },
  });
  expect(Object.keys(virtual)).toEqual(["_creationTime", "_id", "args", "name", "scheduledTime", "state"]);
  expect(((await functions.runQuery("m:pending", {})) as { _id: string }[]).map((j) => j._id)).toEqual([job]);
});

test("the executor runs a job with the arguments from `_scheduled_job_args`; garbage collection deletes both", async () => {
  const { engine, functions, raw } = await setup();
  const executor = new ScheduledJobExecutor(engine, functions, { retentionSeconds: 0 });
  stops.push(() => executor.stop());
  await functions.runMutation("m:schedule", { n: 3n });
  executor.start();
  for (let i = 0; i < 400 && (await raw(SCHEDULED_JOBS_TABLE)).length > 0; i++) await Bun.sleep(5);
  expect(await raw("done")).toMatchObject([{ n: 3n, bytes: [1, 2, 3] }]);
  // Retention 0: the completed job went, and its arguments with it.
  expect(await raw(SCHEDULED_JOBS_TABLE)).toEqual([]);
  expect(await raw(SCHEDULED_JOB_ARGS_TABLE)).toEqual([]);
});

test("a job whose arguments are gone fails its attempt as a system error, and is retried", async () => {
  const { engine, functions, raw } = await setup();
  await functions.runMutation("m:schedule", { n: 1n });
  const [args] = await raw(SCHEDULED_JOB_ARGS_TABLE);
  await engine.mutation((db) => db.asSystem(() => db.delete(SCHEDULED_JOB_ARGS_TABLE, args!._id as string)));
  const executor = new ScheduledJobExecutor(engine, functions, { errorInitialBackoffMs: 60_000 });
  stops.push(() => executor.stop());
  executor.start();
  for (let i = 0; i < 400 && executor.stats.systemErrors === 0; i++) await Bun.sleep(5);
  expect(executor.stats).toMatchObject({ systemErrors: 1, succeeded: 0, failed: 0 });
  const [job] = await raw(SCHEDULED_JOBS_TABLE);
  expect(job).toMatchObject({ state: { type: "pending" }, attempts: { systemErrors: 1n, occErrors: 0n } });
  expect(await raw("done")).toEqual([]);
});
