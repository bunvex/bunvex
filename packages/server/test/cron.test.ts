// Cron jobs (STUDY-30 §1.5): cronJobs(), the server's checks, the next run, the startup diff and the executor.
import { afterEach, describe, expect, test } from "bun:test";
import {
  CRON_JOB_LOGS_TABLE,
  CRON_NEXT_RUN_TABLE,
  defineSchema,
  defineTable,
  Engine,
  setUserStopState,
} from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { makeFunctionReference } from "@bunvex/protocol";
import { BunvexError, v } from "@bunvex/values";
import { type Crons, cronJobs, cronSpecs } from "../src/cron.ts";
import { CronJobExecutor } from "../src/cron-executor.ts";
import { completeRun, currentJob, insertLog } from "../src/cron-model.ts";
import { computeNextTs } from "../src/cron-next.ts";
import { action, Functions, internalMutation, mutation, query } from "../src/functions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};
async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, what = "condition") {
  for (let i = 0; i < 600; i++) {
    const x = await f();
    if (x) return x;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("cronJobs()", () => {
  const fn = makeFunctionReference<"mutation">("m:tick");
  test("Convex's checks and messages", () => {
    const c = cronJobs();
    expect(err(() => c.interval("x\n", { seconds: 1 }, fn))).toBe(
      "Invalid cron identifier x\n: use ASCII letters that are not control characters",
    );
    c.interval("a", { seconds: 1 }, fn);
    expect(err(() => c.interval("a", { seconds: 1 }, fn))).toBe("Cron identifier registered twice: a");
    expect(err(() => c.interval("b", {}, fn))).toBe("Must specify one of seconds, minutes, or hours");
    expect(err(() => c.interval("b", { seconds: 1, minutes: 1 }, fn))).toBe(
      "Must specify one of seconds, minutes, or hours",
    );
    expect(err(() => c.interval("b", { minutes: 0 }, fn))).toBe("Interval must be an integer greater than 0");
    expect(err(() => c.interval("b", { hours: 1.5 }, fn))).toBe("Interval must be an integer greater than 0");
    expect(err(() => c.daily("b", { hourUTC: 24 }, fn))).toBe("Hour of day must be an integer from 0 to 23");
    expect(err(() => c.hourly("b", { minuteUTC: 60 }, fn))).toBe("Minute of hour must be an integer from 0 to 59");
    expect(err(() => c.monthly("b", { day: 32, hourUTC: 0 }, fn))).toBe("Day of month must be an integer from 1 to 31");
    expect(err(() => c.weekly("b", { dayOfWeek: "Tuesday" as never, hourUTC: 0 }, fn))).toBe(
      'Day of week must be a string like "monday".',
    );
    expect(err(() => c.interval("b", { seconds: 1 }, fn, [1] as never))).toBe(
      "The arguments to a bunvex function must be an object. Received: 1",
    );
  });

  test("the shapes Convex exports; hourly without a schedule", () => {
    const c = cronJobs();
    c.interval("i", { minutes: 5 }, "m:tick", { n: 1n });
    c.hourly("h", "m:tick");
    c.daily("d", { hourUTC: 3 }, "m:tick");
    c.weekly("w", { dayOfWeek: "monday", hourUTC: 3, minuteUTC: 7 }, "m:tick");
    c.cron("c", "*/5 * * * *", "m:tick");
    expect(JSON.parse(c.export())).toEqual({
      i: { name: "m:tick", args: [{ n: { $integer: "AQAAAAAAAAA=" } }], schedule: { minutes: 5, type: "interval" } },
      h: { name: "m:tick", args: [{}], schedule: { type: "hourly" } },
      d: { name: "m:tick", args: [{}], schedule: { hourUTC: 3, type: "daily" } },
      w: { name: "m:tick", args: [{}], schedule: { dayOfWeek: "monday", hourUTC: 3, minuteUTC: 7, type: "weekly" } },
      c: { name: "m:tick", args: [{}], schedule: { cron: "*/5 * * * *", type: "cron" } },
    });
  });
});

async function setup(crons: Crons, opts: { start?: boolean } = {}) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const ran: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const functions = new Functions(engine).register("m", {
    tick: internalMutation(async ({ db, auth }, { tag }: { tag?: string }) => {
      ran.push(tag ?? "tick");
      console.log("tick ran");
      await db.insert("items", { tag: tag ?? "tick", who: (await auth.getUserIdentity())?.subject ?? null });
      return { ok: true };
    }),
    fails: mutation(async ({ db }) => {
      await db.insert("items", { tag: "should vanish" });
      throw new BunvexError("nope");
    }),
    act: action(async (_ctx, { tag }: { tag: string }) => {
      ran.push(`act:${tag}`);
      await gates.get(tag);
      return tag;
    }),
    aQuery: query(async () => 1),
  });
  const make = (c: Crons) => {
    const ex = new CronJobExecutor(
      engine,
      functions,
      cronSpecs(c, (id, name) => functions.cronTarget(id, name)),
      {
        cronSplaySeconds: 0,
        occInitialBackoffMs: 1,
        occMaxBackoffMs: 5,
        errorInitialBackoffMs: 5,
        errorMaxBackoffMs: 20,
      },
    );
    stops.push(() => ex.stop());
    return ex;
  };
  const executor = make(crons);
  const diff = opts.start === false ? null : await executor.start();
  const logs = (name?: string) =>
    engine.query(async (db) =>
      (await db.asSystem(() => db.query(CRON_JOB_LOGS_TABLE).collect())).filter(
        (l) => name === undefined || l.name === name,
      ),
    );
  const nextRuns = () => engine.query((db) => db.asSystem(() => db.query(CRON_NEXT_RUN_TABLE).collect()));
  const gate = (tag: string) => {
    let open!: () => void;
    gates.set(tag, new Promise((r) => (open = r)));
    return open;
  };
  return { engine, functions, executor, diff, ran, logs, nextRuns, make, gate };
}

describe("the server's checks (Convex's push)", () => {
  test("the target must exist and not be a query; cron strings must parse and be able to match", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const functions = new Functions(engine).register("m", {
      tick: mutation(async () => {}),
      q: query(async () => 1),
    });
    const check = (c: Crons) => err(() => cronSpecs(c, (id, name) => functions.cronTarget(id, name)));
    const one = (f: (c: Crons) => void) => {
      const c = cronJobs();
      f(c);
      return check(c);
    };
    expect(one((c) => c.interval("x", { seconds: 1 }, "m:nope"))).toBe(
      "The cron job 'x' schedules a function that does not exist: m.js:nope",
    );
    expect(one((c) => c.interval("x", { seconds: 1 }, "m:q"))).toBe(
      "The cron job 'x' schedules a query function, only actions and mutations can be scheduled: m.js:q",
    );
    expect(one((c) => c.cron("x", "61 * * * *", "m:tick"))).toBe("Failed to parse cron expression");
    expect(one((c) => c.cron("x", "0 0 31 2 *", "m:tick"))).toBe(
      'The cron spec "0 0 31 2 *" will never match any time',
    );
    const c = cronJobs();
    c.interval("x", { hours: 2 }, "m:tick");
    expect(cronSpecs(c, (id, n) => functions.cronTarget(id, n)).get("x")).toEqual({
      udfPath: "m.js:tick",
      udfArgs: [{}],
      cronSchedule: { type: "interval", seconds: 7200 },
    });
  });
});

describe("the next run", () => {
  const T = Date.UTC(2026, 0, 5, 10, 30, 15); // a Monday
  test("an interval runs at once when new, then every period from the previous scheduled time", () => {
    const s = { type: "interval" as const, seconds: 30 };
    expect(computeNextTs(s, null, T)).toBe(T);
    expect(computeNextTs(s, T - 5000, T)).toBe(T + 25_000);
  });

  test("clock schedules in UTC, with Convex's splay", () => {
    const zero = { rng: () => 0, cronSplaySeconds: 60 };
    expect(computeNextTs({ type: "daily", hourUTC: 9, minuteUTC: 0 }, null, T, zero)).toBe(Date.UTC(2026, 0, 6, 9, 0));
    expect(computeNextTs({ type: "weekly", dayOfWeek: 3, hourUTC: 1, minuteUTC: 2 }, null, T, zero)).toBe(
      Date.UTC(2026, 0, 7, 1, 2),
    );
    expect(
      computeNextTs({ type: "monthly", day: 31, hourUTC: 0, minuteUTC: 0 }, null, Date.UTC(2026, 1, 1), zero),
    ).toBe(Date.UTC(2026, 2, 31));
    // A pinned minute: up to 60 s late; an unpinned one: anywhere in the hour; either way the same offset
    // every run after (it lives in the previous run's time).
    const pinned = computeNextTs({ type: "hourly", minuteUTC: 0 }, null, T, { rng: () => 42 });
    expect(pinned).toBe(Date.UTC(2026, 0, 5, 11, 0, 42));
    expect(computeNextTs({ type: "hourly", minuteUTC: 0 }, pinned, pinned, { rng: () => 7 })).toBe(
      Date.UTC(2026, 0, 5, 12, 0, 42),
    );
    const unpinned = computeNextTs({ type: "hourly" }, null, T, { rng: () => 1234 });
    expect(unpinned).toBe(Date.UTC(2026, 0, 5, 11, 20, 34));
    expect(computeNextTs({ type: "hourly" }, unpinned, unpinned, { rng: () => 1 })).toBe(
      Date.UTC(2026, 0, 5, 12, 20, 34),
    );
    expect(computeNextTs({ type: "cron", cronExpr: "*/15 * * * *" }, null, T, { cronSplaySeconds: 0 })).toBe(
      Date.UTC(2026, 0, 5, 10, 45),
    );
  });
});

describe("the executor", () => {
  test("a new interval cron runs at once, as no one; success and error runs are logged; the cron moves on", async () => {
    const c = cronJobs();
    c.interval("tick", { hours: 1 }, "m:tick", { tag: "t" });
    c.interval("fails", { hours: 1 }, "m:fails");
    const { engine, ran, logs, nextRuns } = await setup(c);
    await until(async () => (await logs()).length === 2, "two runs");
    expect(ran).toEqual(["t"]);
    const tick = (await logs("tick"))[0];
    expect(tick).toMatchObject({
      udfPath: "m.js:tick",
      udfArgs: [{ tag: "t" }],
      status: { type: "success", result: { type: "default", value: { ok: true } } },
      logLines: { logLines: ["[LOG] 'tick ran'"], isTruncated: false },
    });
    expect((await logs("fails"))[0].status).toMatchObject({ type: "err" });
    expect(((await logs("fails"))[0].status as { error: string }).error).toContain("Uncaught BunvexError: nope");
    const items = await engine.query((db) => db.query("items").collect());
    expect(items.map((d) => [d.tag, d.who])).toEqual([["t", null]]);
    for (const r of await nextRuns()) expect(r.nextTs as number).toBeGreaterThan(Date.now() + 3_500_000);
  });

  test("an action cron; one never runs twice at once; one left in progress is logged as a transient error", async () => {
    const c = cronJobs();
    c.interval("act", { seconds: 1 }, "m:act", { tag: "slow" });
    const { ran, logs, gate, engine, make, functions } = await setup(c, { start: false });
    const open = gate("slow");
    const ex = make(c);
    await ex.start();
    await until(() => ran.length === 1);
    await Bun.sleep(1300); // past the next due time: still one run, since the first has not finished
    expect(ran).toEqual(["act:slow"]);
    open();
    await until(async () => (await logs("act")).length >= 1);
    expect((await logs("act"))[0].status).toEqual({ type: "success", result: { type: "default", value: "slow" } });
    await ex.stop();
    // As a crash leaves it: in progress, nobody running it.
    await engine.mutation(async (db) => {
      const [r] = await db.asSystem(() => db.query(CRON_NEXT_RUN_TABLE).collect());
      await db.asSystem(() =>
        db.patch(CRON_NEXT_RUN_TABLE, r._id, {
          state: { type: "inProgress", requestId: "r", executionId: "e" },
          nextTs: Date.now() - 1,
        }),
      );
    });
    const before = ran.length;
    const again = new CronJobExecutor(
      engine,
      functions,
      cronSpecs(c, (id, n) => functions.cronTarget(id, n)),
      { cronSplaySeconds: 0 },
    );
    stops.push(() => again.stop());
    await again.start();
    await until(async () =>
      (await logs("act")).some(
        (l) => (l.status as { error?: string }).error === "Transient error while executing action",
      ),
    );
    expect(ran.length).toBe(before);
  });

  test("missed runs are skipped, not replayed, and logged as canceled", async () => {
    const c = cronJobs();
    c.interval("tick", { seconds: 1 }, "m:tick");
    const { engine, ran, logs, make } = await setup(c, { start: false });
    // Registered, then the process was away for ten seconds.
    const ex = make(c);
    await engine.mutation(async (db) => {
      const { applyCrons } = await import("../src/cron-model.ts");
      await applyCrons(
        db,
        cronSpecs(c, (_i, n) => n.replace(":", ".js:")),
        Date.now() - 10_000,
        { cronSplaySeconds: 0 },
      );
    });
    await ex.start();
    await until(async () => (await logs()).some((l) => (l.status as { type: string }).type === "canceled"));
    const canceled = (await logs()).find((l) => (l.status as { type: string }).type === "canceled")!;
    expect((canceled.status as { num_canceled: number }).num_canceled).toBeGreaterThanOrEqual(9);
    expect(ran.length).toBeLessThan(3);
  });

  test("only the newest 5 logs of a cron are kept", async () => {
    const c = cronJobs();
    c.interval("tick", { hours: 1 }, "m:tick");
    const { engine, logs } = await setup(c);
    await until(async () => (await logs()).length === 1);
    const job = (await engine.query(async (db) => {
      const [r] = await db.asSystem(() => db.query(CRON_NEXT_RUN_TABLE).collect());
      return currentJob(db, r.cronJobId as string);
    }))!;
    for (let i = 0; i < 7; i++)
      await engine.mutation((db) =>
        insertLog(db, job, 1000 + i, { type: "err", error: `e${i}` }, { logLines: [], isTruncated: false }, 0),
      );
    const kept = await logs();
    expect(kept.length).toBe(5);
    // The newest by `ts`: the real run (now) and the four latest inserted.
    expect(
      kept
        .map((l) => l.ts as number)
        .filter((t) => t < 2000)
        .sort(),
    ).toEqual([1003, 1004, 1005, 1006]);
    await engine.mutation((db) => completeRun(db, job, Date.now()));
  });

  test("at start, crons are diffed with the stored ones by name (Convex's push)", async () => {
    const c = cronJobs();
    c.interval("a", { hours: 1 }, "m:tick", { tag: "a" });
    c.interval("b", { hours: 1 }, "m:tick", { tag: "b" });
    c.daily("d", { hourUTC: 3 }, "m:tick");
    const { engine, functions, executor, diff, logs, nextRuns } = await setup(c);
    expect(diff).toEqual({ added: ["a", "b", "d"], updated: [], deleted: [] });
    await until(async () => (await logs()).length === 2);
    await executor.stop();
    const before = new Map((await nextRuns()).map((r) => [r.cronJobId, r.nextTs]));
    const next = cronJobs();
    next.interval("a", { hours: 1 }, "m:tick", { tag: "changed" }); // args only: the next run stays
    next.interval("d", { seconds: 5 }, "m:tick"); // the schedule changed, and daily runs are > 30 s apart: moved
    next.interval("c", { hours: 1 }, "m:tick");
    const ex = new CronJobExecutor(
      engine,
      functions,
      cronSpecs(next, (id, n) => functions.cronTarget(id, n)),
      { cronSplaySeconds: 0 },
    );
    stops.push(() => ex.stop());
    expect(await ex.start()).toEqual({ added: ["c"], updated: ["a", "d"], deleted: ["b"] });
    expect(await logs("b")).toEqual([]);
    const after = new Map((await nextRuns()).map((r) => [r.cronJobId, r.nextTs]));
    expect(after.size).toBe(3);
    const [aId] = [...before.keys()].filter((k) => after.has(k) && after.get(k) === before.get(k));
    expect(aId).toBeDefined(); // a's next run did not move
    // d was daily (tomorrow 03:00 at the latest); as a new interval its next run is now.
    const moved = [...before.keys()].filter(
      (k) => after.has(k) && (after.get(k) as number) < (before.get(k) as number),
    );
    expect(moved.length).toBe(1);
    expect(after.get(moved[0]) as number).toBeLessThanOrEqual(Date.now());
  });
});

describe("createServer({ crons })", () => {
  test("registers the crons at start and runs them", async () => {
    const { createServer } = await import("../src/server.ts");
    const engine = await new Engine(
      defineSchema({ items: defineTable(v.any()) }),
      await MemoryPersistence.open(null, { durable: false }),
    ).init();
    const functions = new Functions(engine).register("m", {
      tick: internalMutation(async ({ db }) => {
        await db.insert("items", {});
      }),
    });
    const crons = cronJobs();
    crons.interval("tick", { minutes: 1 }, "m:tick");
    const server = createServer({ engine, functions, port: 0, crons });
    stops.push(() => server.stop());
    expect(await server.cronsReady).toEqual({ added: ["tick"], updated: [], deleted: [] });
    await until(async () => (await engine.query((db) => db.query("items").collect())).length === 1);
  });

  test("an invalid cron fails the start", async () => {
    const { createServer } = await import("../src/server.ts");
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    const crons = cronJobs();
    crons.cron("bad", "0 0 30 2 *", "m:tick");
    const functions = new Functions(engine).register("m", { tick: mutation(async () => {}) });
    expect(() => createServer({ engine, functions, port: 0, crons })).toThrow(
      'The cron spec "0 0 30 2 *" will never match any time',
    );
  });
});

test("a paused deployment's crons wait; unpausing wakes the executor (STUDY-57)", async () => {
  const c = cronJobs();
  c.interval("t", { seconds: 1 }, "m:tick" as never);
  const t = await setup(c, { start: false });
  await t.engine.mutation((db) => setUserStopState(db, "paused"));
  await t.executor.start();
  await Bun.sleep(200);
  // Not even attempted (an attempt would fail, and be logged: user functions fail while paused).
  expect(t.ran).toEqual([]);
  expect(await t.logs()).toEqual([]);
  await t.engine.mutation((db) => setUserStopState(db, "none"));
  await until(() => t.ran.length > 0, "the cron to run");
  expect(t.ran).toEqual(["tick"]);
});
