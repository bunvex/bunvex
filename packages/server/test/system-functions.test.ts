// The dashboard's system functions for schedules and crons (STUDY-30 §3.5): Convex's names, arguments and
// private document shapes; cancel one / cancel all.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, getJob, insertJob, msToNs } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { cronJobs, cronSpecs } from "../src/cron.ts";
import { CronJobExecutor } from "../src/cron-executor.ts";
import { Functions, internalMutation, mutation } from "../src/functions.ts";
import { cancelAllScheduledJobs, cancelScheduledJob } from "../src/system-functions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    a: internalMutation(async () => {}),
    b: internalMutation(async () => {}),
    schedule: mutation(async ({ scheduler }, { fn, delay, n }: { fn: string; delay: number; n?: number }) =>
      scheduler.runAfter(delay, fn, { n: n ?? 0 }),
    ),
  });
  const schedule = (fn: string, delay: number, n?: number) =>
    functions.runMutation("m:schedule", { fn, delay, n }) as Promise<string>;
  /** Many jobs at once, in transactions of 900 (the limit is 1000 per transaction). */
  const bulk = async (name: string, count: number, at: (i: number) => number) => {
    for (let i = 0; i < count; i += 900)
      await engine.mutation(async (db) => {
        for (let j = i; j < Math.min(count, i + 900); j++)
          await insertJob(db, { name, args: [{}], scheduledTime: at(j), now: Date.now() });
      });
  };
  const sys = (name: string, args: Record<string, unknown> = {}) =>
    functions.runSystemQuery(name, args) as Promise<never>;
  return { engine, functions, schedule, bulk, sys };
}

describe("_system/frontend schedules", () => {
  test("paginatedScheduledJobs: pending and running jobs, nearest first, as Convex's _scheduled_jobs documents", async () => {
    const { schedule, sys, engine } = await setup();
    const later = await schedule("m:a", 3_600_000, 1);
    const sooner = await schedule("m:b", 60_000, 2);
    const third = await schedule("m:a", 120_000, 3);
    // A finished job is not listed (Convex lists nextTs > null).
    await engine.mutation(async (db) => {
      const { completeJob } = await import("@bunvex/core");
      await completeJob(db, third, { kind: "success" }, Date.now());
    });
    const r = (await sys("_system/frontend/paginatedScheduledJobs", {
      paginationOpts: { numItems: 10, cursor: null },
    })) as {
      page: Record<string, unknown>[];
      isDone: boolean;
    };
    expect(r.isDone).toBe(true);
    expect(r.page.map((d) => d._id)).toEqual([sooner, later]);
    const d = r.page[0];
    // The `_scheduled_jobs` document as stored (STUDY-125), Convex's `SerializedScheduledJob`.
    expect(Object.keys(d).sort()).toEqual([
      "_creationTime",
      "_id",
      "argsId",
      "attempts",
      "completedTs",
      "component",
      "nextTs",
      "originalScheduledTs",
      "state",
      "udfArgs",
      "udfPath",
    ]);
    expect(d).toMatchObject({
      component: "",
      udfPath: "m.js:b",
      udfArgs: null,
      completedTs: null,
      state: { type: "pending" },
      attempts: { systemErrors: 0n, occErrors: 0n },
    });
    // The arguments live in `_scheduled_job_args`, not under the job's id.
    expect(typeof d.argsId).toBe("string");
    expect(d.argsId).not.toBe(sooner);
    expect(typeof d.nextTs).toBe("bigint");
    const job = (await engine.query((db) => getJob(db, sooner)))!;
    expect(d.originalScheduledTs).toBe(msToNs(job.scheduledTime));
    // One function's, by either spelling.
    for (const udfPath of ["m:a", "m.js:a"]) {
      const mine = (await sys("_system/frontend/paginatedScheduledJobs", {
        paginationOpts: { numItems: 10, cursor: null },
        udfPath,
      })) as {
        page: { _id: string }[];
      };
      expect(mine.page.map((x) => x._id)).toEqual([later]);
    }
  });

  test("a running job is listed with its request and execution ids", async () => {
    const { schedule, sys, engine } = await setup();
    const id = await schedule("m:a", 60_000);
    const { patchJob } = await import("@bunvex/core");
    await engine.mutation((db) =>
      patchJob(db, id, { state: { kind: "inProgress", requestId: "r1", executionId: "e1" } }),
    );
    const r = (await sys("_system/frontend/paginatedScheduledJobs", {
      paginationOpts: { numItems: 10, cursor: null },
    })) as {
      page: { state: unknown }[];
    };
    expect(r.page[0].state).toEqual({ executionId: "e1", requestId: "r1", type: "inProgress" });
  });

  test("pages follow their cursor", async () => {
    const { bulk, sys } = await setup();
    const now = Date.now();
    await bulk("m.js:a", 7, (i) => now + 60_000 * (i + 1));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const r = (await sys("_system/frontend/paginatedScheduledJobs", { paginationOpts: { numItems: 3, cursor } })) as {
        page: { _id: string }[];
        isDone: boolean;
        continueCursor: string;
      };
      seen.push(...r.page.map((d) => d._id));
      if (r.isDone) break;
      cursor = r.continueCursor;
    }
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  });

  test("scheduler:getArgs: the `_scheduled_job_args` document, its args the bytes of their JSON array", async () => {
    const { schedule, sys, engine } = await setup();
    const id = await schedule("m:a", 60_000, 42);
    const { argsId } = (await engine.query((db) => getJob(db, id)))!;
    const r = (await sys("_system/frontend/scheduler:getArgs", { argsId })) as { _id: string; args: ArrayBuffer };
    expect(Object.keys(r).sort()).toEqual(["_creationTime", "_id", "args"]);
    expect(r._id).toBe(argsId!);
    expect(JSON.parse(new TextDecoder().decode(r.args))).toEqual([{ n: 42 }]);
    // Convex's `v.id("_scheduled_job_args")`: a job's id, or no id at all, is refused.
    for (const bad of [id, "nope"])
      expect(await sys("_system/frontend/scheduler:getArgs", { argsId: bad }).catch((e: Error) => e.message)).toContain(
        "ArgumentValidationError",
      );
    // Deleted with its job: null.
    await engine.mutation(async (db) => {
      const { deleteJob } = await import("@bunvex/core");
      await deleteJob(db, { _id: id, argsId });
    });
    expect(await sys("_system/frontend/scheduler:getArgs", { argsId })).toBeNull();
  });

  test("arguments are checked, and clients cannot call system functions", async () => {
    const { sys, functions } = await setup();
    expect(await sys("_system/frontend/paginatedScheduledJobs", {}).catch((e: Error) => e.message)).toContain(
      "ArgumentValidationError",
    );
    expect(await functions.runQuery("_system/frontend/listCronJobs", {}).catch((e: Error) => e.message)).toBe(
      "You don't have permission to perform this operation.",
    );
  });

  test("cancel one job: pending or running becomes canceled; again, or finished, is a no-op", async () => {
    const { engine, schedule } = await setup();
    const id = await schedule("m:a", 60_000);
    await cancelScheduledJob(engine, id);
    expect((await engine.query((db) => getJob(db, id)))?.state.kind).toBe("canceled");
    await cancelScheduledJob(engine, id); // no-op
    expect(await cancelScheduledJob(engine, "not-an-id").catch((e: Error) => e.message)).toContain("Invalid ID");
  });

  test("cancel all: in batches of 1000, every job or one function's, within a nextTs range", async () => {
    const { engine, bulk } = await setup();
    const now = Date.now();
    await bulk("m.js:a", 2500, (i) => now + 1000 * (i + 1));
    await bulk("m.js:b", 10, (i) => now + 1000 * (i + 1));
    // b's jobs due within its first 5 s: 4 of them (nextTs in [now+1s, now+5s)).
    expect(
      await cancelAllScheduledJobs(engine, {
        udfPath: "m:b",
        startNextTs: BigInt(now + 1000) * 1_000_000n,
        endNextTs: BigInt(now + 5000) * 1_000_000n,
      }),
    ).toBe(4);
    expect(await cancelAllScheduledJobs(engine, { udfPath: "m.js:a" })).toBe(2500);
    expect(await cancelAllScheduledJobs(engine)).toBe(6);
    expect(await cancelAllScheduledJobs(engine)).toBe(0);
  });
});

describe("_system/frontend crons", () => {
  test("listCronJobs (with each one's last and next run) and listCronJobRuns, as Convex's documents", async () => {
    const { engine, functions, sys } = await setup();
    const crons = cronJobs();
    crons.interval("every hour", { hours: 1 }, "m:a", { n: 1 });
    crons.daily("nightly", { hourUTC: 3, minuteUTC: 0 }, "m:b");
    const ex = new CronJobExecutor(
      engine,
      functions,
      cronSpecs(crons, (id, n) => functions.cronTarget(id, n)),
      { cronSplaySeconds: 0 },
    );
    stops.push(() => ex.stop());
    await ex.start();
    for (let i = 0; i < 200 && ((await sys("_system/frontend/listCronJobRuns")) as unknown[]).length === 0; i++)
      await Bun.sleep(5);
    const jobs = (await sys("_system/frontend/listCronJobs")) as Record<string, never>[];
    const hourly = jobs.find((j) => j.name === "every hour") as Record<string, Record<string, unknown>>;
    expect(hourly.cronSpec).toMatchObject({ udfPath: "m.js:a", cronSchedule: { type: "interval", seconds: 3600n } });
    expect(JSON.parse(new TextDecoder().decode(hourly.cronSpec.udfArgs as ArrayBuffer))).toEqual([{ n: 1 }]);
    expect(hourly.nextRun).toMatchObject({ cronJobId: hourly._id, state: { type: "pending" } });
    expect(typeof hourly.nextRun.nextTs).toBe("bigint");
    expect(typeof hourly.nextRun.prevTs).toBe("bigint");
    expect(hourly.lastRun).toMatchObject({ name: "every hour", udfPath: "m.js:a", status: { type: "success" } });
    expect(typeof hourly.lastRun.ts).toBe("bigint");
    const nightly = jobs.find((j) => j.name === "nightly") as Record<string, Record<string, unknown> | null>;
    expect(nightly.lastRun).toBeNull();
    expect(nightly.nextRun).toMatchObject({ prevTs: null });
    const runs = (await sys("_system/frontend/listCronJobRuns")) as { name: string }[];
    expect(runs.map((r) => r.name)).toEqual(["every hour"]);
  });
});
