// Scheduled functions (STUDY-30): ctx.scheduler, _scheduled_functions through db.system, and the executor.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, patchJob } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { action, callerOf, Functions, internalMutation, mutation, query } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";

const stops: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, what = "condition") {
  for (let i = 0; i < 400; i++) {
    const x = await f();
    if (x) return x;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup(
  opts: { start?: boolean; parallelism?: number; retentionSeconds?: number; maxBytesPerSecond?: number } = {},
) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()), counters: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    opts.maxBytesPerSecond ? { writeThroughput: { maxBytesPerSecond: opts.maxBytesPerSecond } } : {},
  ).init();
  const ran: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const functions = new Functions(engine).register("m", {
    bump: internalMutation(async ({ db, auth }, { tag }: { tag?: string }) => {
      ran.push(tag ?? "bump");
      await db.insert("items", { tag: tag ?? "bump", who: (await auth.getUserIdentity())?.subject ?? null });
    }),
    increment: mutation(async ({ db }) => {
      const c = await db.query("counters").first();
      if (c) await db.patch("counters", c._id, { n: (c.n as number) + 1 });
      else await db.insert("counters", { n: 1 });
    }),
    scheduleAt: mutation(async ({ scheduler }, { tag, at }: { tag: string; at: number }) =>
      scheduler.runAt(new Date(at), "m:bump", { tag }),
    ),
    schedule: mutation(async ({ scheduler }, { delay, fn, args }: { delay: number; fn?: string; args?: object }) =>
      scheduler.runAfter(delay, fn ?? "m:bump", args as never),
    ),
    scheduleThenThrow: mutation(async ({ scheduler }) => {
      await scheduler.runAfter(0, "m:bump");
      throw new Error("after scheduling");
    }),
    tryScheduling: mutation(async ({ scheduler }, { how }: { how: string }) => {
      const s = scheduler as never as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const calls: Record<string, () => Promise<unknown>> = {
        delayString: () => s.runAfter("1", "m:bump"),
        delayNaN: () => s.runAfter(Number.NaN, "m:bump"),
        delayNegative: () => s.runAfter(-1, "m:bump"),
        atString: () => s.runAt("tomorrow", "m:bump"),
        atNaN: () => s.runAt(Number.NaN, "m:bump"),
        atNegative: () => s.runAt(-5, "m:bump"),
        farFuture: () => s.runAt(Date.now() + 6 * 366 * 86400_000, "m:bump"),
        farPast: () => s.runAt(Date.now() - 6 * 366 * 86400_000, "m:bump"),
        noModule: () => s.runAfter(0, "nope:bump"),
        noFunction: () => s.runAfter(0, "m:nope"),
        argsArray: () => s.runAfter(0, "m:bump", [1]),
        tooMany: async () => {
          for (let i = 0; i <= 1000; i++) await s.runAfter(0, "m:bump");
        },
        tooLarge: async () => {
          const big = "x".repeat(1 << 20);
          for (let i = 0; i < 17; i++) await s.runAfter(0, "m:bump", { tag: big });
        },
        badCancelId: async () => {
          const id = await (scheduler as never as { runAfter: (...a: unknown[]) => Promise<string> }).runAfter(
            0,
            "m:bump",
          );
          return s.cancel(id.slice(0, -2) + (id.endsWith("a") ? "bb" : "aa"));
        },
      };
      try {
        await calls[how]();
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    }),
    cancel: mutation(async ({ scheduler }, { id }: { id: string }) => scheduler.cancel(id as never)),
    cancelOtherTable: mutation(async ({ db, scheduler }) => {
      const id = await db.insert("items", {});
      try {
        await scheduler.cancel(id as never);
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    }),
    // Finds its own (in-progress) job and cancels it.
    selfCancel: mutation(async ({ db, scheduler }) => {
      const mine = (await db.system.query("_scheduled_functions").collect()).find(
        (j) => j.name === "m.js:selfCancel" && (j.state as { kind: string }).kind === "inProgress",
      );
      await scheduler.cancel(mine!._id);
    }),
    fails: mutation(async ({ db }) => {
      await db.insert("items", { tag: "should vanish" });
      throw new BunvexError("nope");
    }),
    aQuery: query(async () => 1),
    job: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
    jobs: query(async ({ db }) => db.system.query("_scheduled_functions").collect()),
    systemQuery: query(async ({ db }, { what }: { what: string }) => {
      try {
        if (what === "index")
          await db.system
            .query("_scheduled_functions")
            .withIndex("by_next_ts" as never)
            .collect();
        else await db.system.query("_session_requests" as never).collect();
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    }),
    act: action(async ({ scheduler }, { tag }: { tag: string }) => {
      ran.push(`act:${tag}`);
      await gates.get(tag);
      await scheduler.runAfter(0, "m:bump", { tag: `child of ${tag}` });
      if (tag === "throws") throw new Error("action failed");
    }),
    // Schedules through the functions it calls: a mutation, and another action.
    actVia: action(async ({ runMutation, runAction }, { tag }: { tag: string }) => {
      ran.push(`actVia:${tag}`);
      await gates.get(tag);
      await runMutation("m:schedule" as never, { delay: 0, args: { tag: `via mutation of ${tag}` } } as never);
      await runAction("m:actChild" as never, { tag } as never);
    }),
    // Asks a mutation to cancel the job this action runs as.
    cancelOwnJobViaMutation: action(async (ctx) => {
      const { scheduledFunctionId } = await (
        ctx as never as { meta: { getRequestMetadata(): Promise<{ scheduledFunctionId: string }> } }
      ).meta.getRequestMetadata();
      try {
        await ctx.runMutation("m:cancel" as never, { id: scheduledFunctionId } as never);
        ran.push("canceled");
      } catch (e) {
        ran.push((e as Error).message);
      }
    }),
    actChild: action(async ({ scheduler }, { tag }: { tag: string }) => {
      await scheduler.runAfter(0, "m:bump", { tag: `via action of ${tag}` });
    }),
    scheduleFromActionThenThrow: action(async ({ scheduler }) => {
      await scheduler.runAfter(0, "m:bump", { tag: "from action" });
      throw new Error("action failed");
    }),
  });
  const executor = new ScheduledJobExecutor(engine, functions, {
    parallelism: opts.parallelism ?? 8,
    retentionSeconds: opts.retentionSeconds,
    occInitialBackoffMs: 1,
    occMaxBackoffMs: 5,
    errorInitialBackoffMs: 5,
    errorMaxBackoffMs: 20,
  });
  if (opts.start !== false) executor.start();
  stops.push(() => executor.stop());
  const job = async (id: string) => (await functions.runQuery("m:job", { id })) as Record<string, unknown> | null;
  const state = async (id: string) => ((await job(id))?.state as { kind: string; error?: string } | undefined)?.kind;
  const gate = (tag: string) => {
    let open!: () => void;
    gates.set(tag, new Promise((r) => (open = r)));
    return open;
  };
  return { engine, functions, executor, ran, job, state, gate };
}

describe("ctx.scheduler", () => {
  test("from a mutation, the job exists only if the mutation commits", async () => {
    const { functions, ran, state } = await setup();
    const id = (await functions.runMutation("m:schedule", { delay: 0 })) as string;
    await until(async () => (await state(id)) === "success", "the job ran");
    expect(ran).toEqual(["bump"]);
    expect(await functions.runMutation("m:scheduleThenThrow", {}).catch((e) => e.message)).toContain(
      "after scheduling",
    );
    await Bun.sleep(50);
    expect(ran).toEqual(["bump"]);
    expect(((await functions.runQuery("m:jobs", {})) as unknown[]).length).toBe(1);
  });

  test("from an action, scheduling commits at once, even if the action then fails", async () => {
    const { functions, ran } = await setup();
    await functions.runAction("m:scheduleFromActionThenThrow", {}).catch(() => {});
    await until(() => ran.includes("from action"), "the job ran");
  });

  test("Convex's checks and messages", async () => {
    // "tooLarge" commits about 16 MiB of scheduled arguments: over Convex's 4 MiB/s write throughput limit
    // (STUDY-78), the next mutation would be refused, as on Convex.
    const { functions } = await setup({ start: false, maxBytesPerSecond: 1 << 30 });
    const msg = (how: string) => functions.runMutation("m:tryScheduling", { how }) as Promise<string>;
    expect(await msg("delayString")).toBe("`delayMs` must be a number");
    expect(await msg("delayNaN")).toBe("`delayMs` must be a finite number");
    expect(await msg("delayNegative")).toBe("`delayMs` must be non-negative");
    expect(await msg("atString")).toBe("The invoke time must a Date or a timestamp");
    expect(await msg("atNaN")).toBe(
      "Invalid arguments for `ts`: cannot convert float seconds to Duration: value is either too big or NaN",
    );
    expect(await msg("atNegative")).toBe(
      "Invalid arguments for `ts`: cannot convert float seconds to Duration: value is negative",
    );
    expect(await msg("farFuture")).toMatch(/^UnixTimestamp\(\d+(\.\d+)?s\) is more than 5 years in the future$/);
    expect(await msg("farPast")).toMatch(/^UnixTimestamp\(\d+(\.\d+)?s\) is more than 5 years in the past$/);
    expect(await msg("noModule")).toBe("Attempted to schedule function at nonexistent path: nope.js");
    expect(await msg("noFunction")).toBe(
      "Attempted to schedule function, but no exported function nope found in the file: m.js. Did you forget to export it?",
    );
    expect(await msg("argsArray")).toBe("The arguments to a bunvex function must be an object. Received: 1");
    expect(await msg("tooMany")).toBe("Too many functions scheduled by this mutation (limit: 1000)");
    expect(await msg("tooLarge")).toBe(
      "Too large total size of the arguments of scheduled functions from this mutation (limit: 16777216 bytes)",
    );
    expect(await functions.runMutation("m:cancelOtherTable", {})).toBe(
      "Invalid scheduled function ID. The ID must be an ID on the '_scheduled_functions' table.",
    );
  });
});

describe("_scheduled_functions through db.system", () => {
  test("Convex's public shape, in each state", async () => {
    const { functions, job, state } = await setup();
    const before = Date.now();
    const id = (await functions.runMutation("m:schedule", { delay: 60_000, args: { tag: "later" } })) as string;
    const pending = await job(id);
    expect(Object.keys(pending!).sort()).toEqual(["_creationTime", "_id", "args", "name", "scheduledTime", "state"]);
    expect(pending).toMatchObject({ _id: id, name: "m.js:bump", args: [{ tag: "later" }], state: { kind: "pending" } });
    expect(pending!.scheduledTime as number).toBeGreaterThanOrEqual(before + 60_000);
    const now = (await functions.runMutation("m:schedule", { delay: 0 })) as string;
    await until(async () => (await state(now)) === "success");
    const done = await job(now);
    expect(Object.keys(done!).sort()).toEqual([
      "_creationTime",
      "_id",
      "args",
      "completedTime",
      "name",
      "scheduledTime",
      "state",
    ]);
    const failed = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:fails" })) as string;
    await until(async () => (await state(failed)) === "failed");
    expect(((await job(failed))!.state as { error: string }).error).toContain("Uncaught BunvexError: nope");
    expect(((await functions.runQuery("m:jobs", {})) as unknown[]).length).toBe(3);
  });

  test("only by_id and by_creation_time are public; other system tables read as empty, as Convex's", async () => {
    const { functions } = await setup({ start: false });
    expect(await functions.runQuery("m:systemQuery", { what: "index" })).toBe(
      "unknown index _scheduled_functions.by_next_ts",
    );
    expect(await functions.runQuery("m:systemQuery", { what: "other" })).toBe("ok"); // found nothing (STUDY-107)
  });
});

describe("the executor", () => {
  test("a failing mutation's writes are gone and its job is failed", async () => {
    const { engine, functions, state } = await setup();
    const id = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:fails" })) as string;
    await until(async () => (await state(id)) === "failed");
    const items = await engine.query((db) => db.query("items").collect());
    expect(items).toEqual([]);
  });

  test("a scheduled mutation runs exactly once, also under contention", async () => {
    const { engine, functions, executor, state } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++)
      ids.push((await functions.runMutation("m:schedule", { delay: 0, fn: "m:increment" })) as string);
    await until(async () => (await Promise.all(ids.map(state))).every((s) => s === "success"), "all succeeded");
    const [c] = await engine.query((db) => db.query("counters").collect());
    expect(c.n).toBe(30);
    expect(executor.stats.succeeded).toBe(30);
  });

  test("cancel: a pending job never runs; a finished one is a no-op; a mutation cannot cancel itself", async () => {
    const { functions, ran, state } = await setup();
    const id = (await functions.runMutation("m:schedule", { delay: 200 })) as string;
    await functions.runMutation("m:cancel", { id });
    expect(await state(id)).toBe("canceled");
    const done = (await functions.runMutation("m:schedule", { delay: 0, args: { tag: "done" } })) as string;
    await until(async () => (await state(done)) === "success");
    await functions.runMutation("m:cancel", { id: done });
    expect(await state(done)).toBe("success");
    await Bun.sleep(300);
    expect(ran).toEqual(["done"]);
    const self = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:selfCancel" })) as string;
    await until(async () => (await state(self)) === "failed");
    expect(((await setupJob(functions, self))!.state as { error: string }).error).toContain(
      "A mutation cannot cancel itself",
    );
  });

  test("an action runs at most once: one cut short is failed, never re-run", async () => {
    const { engine, functions, executor, ran, state } = await setup({ start: false });
    const id = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:act", args: { tag: "a" } })) as string;
    // As a crash leaves it: in progress, and nobody running it.
    await engine.mutation((db) =>
      patchJob(db, id, { state: { kind: "inProgress", requestId: "r", executionId: "e" } }),
    );
    executor.start();
    await until(async () => (await state(id)) === "failed");
    expect(((await setupJob(functions, id))!.state as { error: string }).error).toBe(
      "Transient error while executing action",
    );
    expect(ran).toEqual([]);
  });

  test("an action's result: success, or failed with its error", async () => {
    const { functions, state } = await setup();
    const ok = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:act", args: { tag: "fine" } })) as string;
    const bad = (await functions.runMutation("m:schedule", {
      delay: 0,
      fn: "m:act",
      args: { tag: "throws" },
    })) as string;
    await until(async () => (await state(ok)) === "success" && (await state(bad)) === "failed");
    expect(((await setupJob(functions, bad))!.state as { error: string }).error).toContain("action failed");
  });

  test("canceling a running action: it finishes, stays canceled, and what it schedules is born canceled", async () => {
    const { functions, ran, state, gate } = await setup();
    const open = gate("slow");
    const id = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:act", args: { tag: "slow" } })) as string;
    await until(async () => (await state(id)) === "inProgress");
    await functions.runMutation("m:cancel", { id });
    open();
    await until(async () => {
      const jobs = (await functions.runQuery("m:jobs", {})) as { args: { tag?: string }[] }[];
      return jobs.some((j) => j.args[0].tag === "child of slow");
    }, "the child");
    await Bun.sleep(100);
    expect(ran).toEqual(["act:slow"]); // the child never ran
    expect(await state(id)).toBe("canceled");
    const jobs = (await functions.runQuery("m:jobs", {})) as { args: { tag?: string }[]; state: { kind: string } }[];
    expect(jobs.find((j) => j.args[0].tag === "child of slow")?.state.kind).toBe("canceled");
  });

  test("canceling a running action also cancels what the functions it calls schedule (Convex: test_cancel_recursively_scheduled_job)", async () => {
    const { functions, ran, state, gate } = await setup();
    const open = gate("slow");
    const id = (await functions.runMutation("m:schedule", {
      delay: 0,
      fn: "m:actVia",
      args: { tag: "slow" },
    })) as string;
    await until(async () => (await state(id)) === "inProgress");
    await functions.runMutation("m:cancel", { id });
    open();
    const children = async () =>
      ((await functions.runQuery("m:jobs", {})) as { args: { tag?: string }[]; state: { kind: string } }[]).filter(
        (j) => j.args[0].tag?.startsWith("via "),
      );
    await until(async () => (await children()).length === 2, "both children");
    await Bun.sleep(100);
    expect(ran).toEqual(["actVia:slow"]); // neither child ran
    expect((await children()).map((j) => [j.args[0].tag, j.state.kind]).sort()).toEqual([
      ["via action of slow", "canceled"],
      ["via mutation of slow", "canceled"],
    ]);
  });

  test("a mutation a scheduled action calls runs under its job: it cannot cancel that job (Convex's check)", async () => {
    const { functions, ran, state } = await setup();
    const id = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:cancelOwnJobViaMutation" })) as string;
    await until(async () => (await state(id)) === "success");
    expect(ran).toEqual(["A mutation cannot cancel itself"]);
  });

  test("the wrong kind, or a function gone since, fails at run time", async () => {
    const { engine, functions, executor, state } = await setup();
    const q = (await functions.runMutation("m:schedule", { delay: 0, fn: "m:aQuery" })) as string;
    await until(async () => (await state(q)) === "failed");
    expect(((await setupJob(functions, q))!.state as { error: string }).error).toBe(
      'Unsupported function type. FunctionName("aQuery") in module "m.js" is defined as a Query. "\n                            "Only Mutation and Action can be scheduled.',
    );
    // Another deployment of the functions without `m:bump`: the job fails when it runs.
    await executor.stop();
    const id = (await functions.runMutation("m:schedule", { delay: 200 })) as string;
    const other = new Functions(engine).register("m", {
      job: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
    });
    const ex = new ScheduledJobExecutor(engine, other, { errorInitialBackoffMs: 5, errorMaxBackoffMs: 20 });
    stops.push(() => ex.stop());
    ex.start();
    await until(async () => (await state(id)) === "failed");
    expect(((await setupJob(functions, id))!.state as { error: string }).error).toBe(
      'Couldn\'t find "bump" in module "m.js".',
    );
  });

  test("jobs start in nextTs order; scheduled runs have no identity", async () => {
    const { functions, executor, ran, engine } = await setup({ start: false, parallelism: 1 });
    const now = Date.now();
    // Scheduled out of order, due in a moment; one runs at a time.
    for (const [tag, ahead] of [
      ["c", 300],
      ["a", 100],
      ["b", 200],
    ] as const)
      await functions.runMutation(
        "m:scheduleAt",
        { tag, at: now + ahead },
        true,
        callerOf({ tokenIdentifier: "x|ada", issuer: "x", subject: "ada" }),
      );
    executor.start();
    await until(() => ran.length === 3);
    expect(ran).toEqual(["a", "b", "c"]);
    // Scheduled by a signed-in caller, run as no one.
    const who = await until(async () => {
      const items = await engine.query((db) => db.query("items").collect());
      return items.length === 3 && items;
    }, "the three commits");
    expect(who.map((d) => d.who)).toEqual([null, null, null]);
  });

  test("one at a time, every due job still runs (no wake-up is lost)", async () => {
    const { functions, ran } = await setup({ parallelism: 1 });
    for (let i = 0; i < 20; i++) await functions.runMutation("m:schedule", { delay: 0, args: { tag: `t${i}` } });
    await until(() => ran.length === 20, "all twenty");
  });

  test("two executors on one queue never run a job twice", async () => {
    const { engine, functions, executor } = await setup({ start: false });
    const other = new ScheduledJobExecutor(engine, functions, { occInitialBackoffMs: 1, occMaxBackoffMs: 5 });
    stops.push(() => other.stop());
    for (let i = 0; i < 20; i++) await functions.runMutation("m:schedule", { delay: 0, fn: "m:increment" });
    executor.start();
    other.start();
    await until(async () => {
      const jobs = (await functions.runQuery("m:jobs", {})) as { state: { kind: string } }[];
      return jobs.every((j) => j.state.kind === "success");
    }, "all done");
    const [c] = await engine.query((db) => db.query("counters").collect());
    expect(c.n).toBe(20);
  });

  test("runAfter waits at least its delay", async () => {
    const { functions, ran } = await setup();
    const t0 = Date.now();
    await functions.runMutation("m:schedule", { delay: 150 });
    await until(() => ran.length === 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(145);
  });

  test("completed jobs are deleted after the retention window", async () => {
    const { functions, state } = await setup({ retentionSeconds: 0 });
    const id = (await functions.runMutation("m:schedule", { delay: 0 })) as string;
    await until(async () => (await state(id)) === "success");
    await until(async () => (await setupJob(functions, id)) === null, "garbage collected");
  });
});

const setupJob = (functions: Functions, id: string) =>
  functions.runQuery("m:job", { id }) as Promise<Record<string, unknown> | null>;
