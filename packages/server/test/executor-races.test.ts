// The executors' races (STUDY-65 G-A6): a scheduled job canceled, or a cron deleted, after the executor picked
// it must not run. Convex re-reads the job before each attempt, in the transaction the attempt runs in
// (`new_transaction_for_job_state` in crates/application/src/scheduled_jobs/mod.rs and cron_jobs/mod.rs), and
// does nothing when it changed; its `test_scheduled_jobs_race_condition` and `test_cron_jobs_race_condition`
// hand the executor a job read before the cancel or the delete. These tests do the same with bunvex's
// executors (their loops are not started, so nothing else picks the job), and add the interleaving where the
// cancel or the delete commits while the mutation is running: its commit conflicts, and the retry sees the
// change.
import { afterEach, describe, expect, test } from "bun:test";
import { CRON_JOB_LOGS_TABLE, defineSchema, defineTable, Engine, getJob, type JobDoc } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { type Crons, cronJobs, cronSpecs } from "../src/cron.ts";
import { CronJobExecutor } from "../src/cron-executor.ts";
import { type CronJob, dueCrons } from "../src/cron-model.ts";
import { action, Functions, internalMutation, mutation } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";

const stops: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const fast = { occInitialBackoffMs: 1, occMaxBackoffMs: 5, errorInitialBackoffMs: 5, errorMaxBackoffMs: 20 };

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const ran: string[] = [];
  let gate: Promise<void> | null = null;
  /** The next run of `m:write` waits in its body until the returned function is called. */
  const hold = () => {
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    return { inside, open: () => open(), entered: () => entered() };
  };
  let held: ReturnType<typeof hold> | null = null;
  const functions = new Functions(engine).register("m", {
    write: internalMutation(async ({ db }, { tag }: { tag: string }) => {
      ran.push(tag);
      if (held) {
        held.entered();
        await gate;
      }
      await db.insert("items", { tag });
      return tag;
    }),
    act: action(async (_ctx, { tag }: { tag: string }) => {
      ran.push(`act:${tag}`);
      return tag;
    }),
    schedule: mutation(async ({ scheduler }, { fn, tag }: { fn: string; tag: string }) =>
      scheduler.runAfter(0, fn as never, { tag } as never),
    ),
    cancel: mutation(async ({ scheduler }, { id }: { id: string }) => scheduler.cancel(id as never)),
  });
  const items = () => engine.query(async (db) => db.query("items").collect());
  const holdNext = () => {
    held = hold();
    return held;
  };
  return { engine, functions, ran, items, holdNext };
}

describe("scheduled jobs", () => {
  async function scheduler() {
    const s = await setup();
    // Not started: the test hands jobs to the executor, as Convex's `test_one_off_scheduled_job_executor_run`.
    const executor = new ScheduledJobExecutor(s.engine, s.functions, fast);
    stops.push(() => executor.stop());
    const execute = (job: JobDoc) => (executor as unknown as { execute(j: JobDoc): Promise<void> }).execute(job);
    const read = (id: string) => s.engine.query((db) => getJob(db, id));
    return { ...s, executor, execute, read };
  }

  for (const fn of ["m:write", "m:act"]) {
    test(`a ${fn === "m:write" ? "mutation" : "action"} job canceled after the executor picked it does not run`, async () => {
      const { functions, executor, execute, read, ran, items } = await scheduler();
      const id = (await functions.runMutation("m:schedule", { fn, tag: "late" })) as string;
      const picked = (await read(id))!;
      expect(picked.state.kind).toBe("pending");
      await functions.runMutation("m:cancel", { id });

      await execute(picked);
      expect(ran).toEqual([]);
      expect(await items()).toEqual([]);
      expect((await read(id))!.state.kind).toBe("canceled");
      expect(executor.stats).toMatchObject({ succeeded: 0, failed: 0, systemErrors: 0 });
    });
  }

  test("a job canceled while its mutation runs: the commit conflicts, the retry sees the cancel, nothing is written", async () => {
    const { functions, executor, execute, read, ran, items, holdNext } = await scheduler();
    const id = (await functions.runMutation("m:schedule", { fn: "m:write", tag: "racing" })) as string;
    const picked = (await read(id))!;
    const h = holdNext();
    const running = execute(picked);
    await h.inside;
    await functions.runMutation("m:cancel", { id });
    h.open();
    await running;

    // The body ran once, then its transaction lost to the cancel; the retry saw the job had changed and did
    // not run the body again.
    expect(ran).toEqual(["racing"]);
    expect(await items()).toEqual([]);
    expect((await read(id))!.state.kind).toBe("canceled");
    expect(executor.stats.succeeded).toBe(0);
  });

  test("a job that already ran is not run again by an executor holding the older copy", async () => {
    const { functions, execute, read, ran, items } = await scheduler();
    const id = (await functions.runMutation("m:schedule", { fn: "m:write", tag: "once" })) as string;
    const picked = (await read(id))!;
    await execute(picked);
    await execute(picked);
    expect(ran).toEqual(["once"]);
    expect((await items()).map((i) => i.tag)).toEqual(["once"]);
    expect((await read(id))!.state.kind).toBe("success");
  });
});

describe("cron jobs", () => {
  async function crons(fn: string) {
    const s = await setup();
    const declare = (withCron: boolean) => {
      const c: Crons = cronJobs();
      if (withCron) c.interval("tick", { seconds: 60 }, fn, { tag: "cron" });
      return cronSpecs(c, (cid, name) => s.functions.cronTarget(cid, name));
    };
    // Not started: `push` registers the crons, and the test hands the run to the executor.
    const executor = new CronJobExecutor(s.engine, s.functions, declare(true), { cronSplaySeconds: 0, ...fast });
    stops.push(() => executor.stop());
    await executor.push(declare(true));
    const execute = (job: CronJob) => (executor as unknown as { execute(j: CronJob): Promise<void> }).execute(job);
    const [picked] = await s.engine.query((db) => dueCrons(db, Date.now() + 1000, 10));
    expect(picked?.name).toBe("tick");
    const logs = () => s.engine.query(async (db) => db.asSystem(() => db.query(CRON_JOB_LOGS_TABLE).collect()));
    return { ...s, executor, execute, picked: picked!, logs, remove: () => executor.push(declare(false)) };
  }

  for (const fn of ["m:write", "m:act"]) {
    test(`a ${fn === "m:write" ? "mutation" : "action"} cron deleted after the executor picked it does not run`, async () => {
      const { executor, execute, picked, remove, ran, items, logs } = await crons(fn);
      expect(await remove()).toMatchObject({ deleted: ["tick"] });

      await execute(picked);
      expect(ran).toEqual([]);
      expect(await items()).toEqual([]);
      expect(await logs()).toEqual([]);
      expect(executor.stats.runs).toBe(0);
    });
  }

  test("a cron deleted while its mutation runs: the commit conflicts, the retry sees the delete, nothing is written", async () => {
    const { executor, execute, picked, remove, ran, items, logs, holdNext } = await crons("m:write");
    const h = holdNext();
    const running = execute(picked);
    await h.inside;
    await remove();
    h.open();
    await running;

    expect(ran).toEqual(["cron"]);
    expect(await items()).toEqual([]);
    expect(await logs()).toEqual([]);
    expect(executor.stats.runs).toBe(0);
  });

  test("a cron run that already happened is not repeated by an executor holding the older copy", async () => {
    const { execute, picked, ran, logs } = await crons("m:write");
    await execute(picked);
    await execute(picked);
    expect(ran).toEqual(["cron"]);
    expect(await logs()).toHaveLength(1);
  });
});
