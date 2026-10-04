// A stopped deployment's executors (STUDY-65 G-A7), as Convex's `test_disable_scheduled_jobs` and
// `test_disable_cron_jobs`: while `_backend_state` says the deployment is disabled, scheduled functions and crons
// wait, not even attempted; once it runs again they run. Convex's executors check
// `BackendState::is_stopped`, which every stop state answers (crates/common/src/types/backend_state.rs): a
// disabled or suspended system, a usage limit, a user pause. The pause is tested in pause-deployment.test.ts
// and cron.test.ts; these are the others.
import { afterEach, describe, expect, test } from "bun:test";
import { BACKEND_STATE_TABLE, defineSchema, defineTable, Engine, getJob, insertJob, type Tx } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { cronJobs, cronSpecs } from "../src/cron.ts";
import { CronJobExecutor } from "../src/cron-executor.ts";
import { Functions, internalMutation } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

type State = { system: string; usage_limit: string; user: string };
const RUNNING: State = { system: "none", usage_limit: "none", user: "none" };

/** Write `_backend_state`, as Convex's `toggle_backend_state` (bunvex itself only sets `user` and `usage_limit`). */
async function setState(db: Tx, state: State) {
  const row = (await db.asSystem(() => db.query(BACKEND_STATE_TABLE).first())) as { _id: string } | null;
  if (row) await db.asSystem(() => db.patch(BACKEND_STATE_TABLE, row._id, state));
  else await db.asSystem(() => db.insert(BACKEND_STATE_TABLE, state));
}

async function until(cond: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
  const engine = await new Engine(
    defineSchema({ objects: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const ran: string[] = [];
  const functions = new Functions(engine).register("m", {
    insertObject: internalMutation(async ({ db }, { tag }: { tag: string }) => {
      ran.push(tag);
      await db.insert("objects", { tag });
    }),
  });
  const objects = () => engine.query(async (db) => (await db.query("objects").collect()).length);
  return { engine, functions, ran, objects };
}

const stopped: [string, State][] = [
  ["a disabled system", { ...RUNNING, system: "disabled" }],
  ["a suspended system", { ...RUNNING, system: "suspended" }],
  ["a usage limit", { ...RUNNING, usage_limit: "disabled" }],
];

for (const [what, state] of stopped)
  describe(`while stopped by ${what}`, () => {
    test("a scheduled job stays pending and runs once the deployment runs again (Convex: test_disable_scheduled_jobs)", async () => {
      const { engine, functions, ran, objects } = await setup();
      const executor = new ScheduledJobExecutor(engine, functions, { occInitialBackoffMs: 1, occMaxBackoffMs: 5 });
      executor.start();
      stops.push(() => executor.stop());
      // The state and the job in one transaction, as Convex's test does.
      const jobId = await engine.mutation(async (db) => {
        await setState(db, state);
        const now = Date.now();
        return insertJob(db, {
          name: functions.scheduledTarget("m:insertObject"),
          args: [{ tag: "job" }],
          scheduledTime: now,
          now,
        });
      });
      await Bun.sleep(200);
      expect(ran).toEqual([]);
      expect(await objects()).toBe(0);
      expect((await engine.query((db) => getJob(db, jobId)))?.state.kind).toBe("pending");

      await engine.mutation((db) => setState(db, RUNNING));
      await until(async () => (await objects()) === 1, "the job");
      expect(ran).toEqual(["job"]);
      expect((await engine.query((db) => getJob(db, jobId)))?.state.kind).toBe("success");
    });

    test("crons are not attempted, and run once the deployment runs again (Convex: test_disable_cron_jobs)", async () => {
      const { engine, functions, ran, objects } = await setup();
      const c = cronJobs();
      c.interval("insert", { seconds: 60 }, "m:insertObject" as never, { tag: "cron" });
      const executor = new CronJobExecutor(
        engine,
        functions,
        cronSpecs(c, (id, name) => functions.cronTarget(id, name)),
        { cronSplaySeconds: 0, occInitialBackoffMs: 1, occMaxBackoffMs: 5 },
      );
      stops.push(() => executor.stop());
      await engine.mutation((db) => setState(db, state));
      await executor.start();
      await Bun.sleep(200);
      expect(ran).toEqual([]);
      expect(await objects()).toBe(0);

      await engine.mutation((db) => setState(db, RUNNING));
      await until(async () => (await objects()) === 1, "the cron");
      expect(ran).toEqual(["cron"]);
    });
  });
