// The dashboard's server source (@bunvex/dashboard-source, STUDY-149 PR 5) against a live bunvex server in this
// process: the contract suite's deployment features (schedules, crons, files, the audit log; cancelling and
// uploading enabled), then what the contract does not pin down — the mapping of Convex's system documents,
// the subscriptions behind every watcher (a change on any loaded page, nothing for an unchanged result),
// Convex's auto-pause on a busy list, and Health's concurrency and subscription invalidations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunvexClient } from "@bunvex/client";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import type { DataSourceError, LiveChange } from "@bunvex/dashboard/data-source";
import { createServerDataSource, type ServerDataSource } from "@bunvex/dashboard-source";
import { type LiveServer, startLiveServer, until } from "./live-server.ts";

const INSTANCE = "dashboard-source-ops";
let srv: LiveServer;
const sources: ServerDataSource[] = [];
const open = (adminKey = srv.adminKey) => {
  const s = createServerDataSource({ url: srv.url, adminKey });
  sources.push(s);
  return s;
};

const HOUR = 3_600_000;

beforeAll(async () => {
  srv = await startLiveServer(INSTANCE, [
    {
      path: "schema.js",
      source: `import { defineSchema, defineTable } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export default defineSchema({ messages: defineTable({ body: v.string() }) });`,
    },
    {
      path: "messages.js",
      source: `import { mutation, query } from "@bunvex/server";
        import { v } from "@bunvex/values";
        export const list = query(async ({ db }) => (await db.query("messages").collect()).length);
        export const send = mutation({ args: { body: v.string() }, handler: async ({ db }, { body }) => {
          await db.insert("messages", { body });
        } });`,
    },
    {
      path: "jobs.js",
      source: `import { makeFunctionReference, mutation } from "@bunvex/server";
        import { v } from "@bunvex/values";
        const workRef = makeFunctionReference("jobs:work");
        const otherRef = makeFunctionReference("jobs:other");
        // count runs, the first after delayMs, then step ms apart (a negative step: each one nearer)
        export const schedule = mutation({
          args: { count: v.number(), delayMs: v.number(), step: v.optional(v.number()), fn: v.optional(v.string()) },
          handler: async ({ scheduler }, { count, delayMs, step, fn }) => {
            const ids = [];
            for (let i = 0; i < count; i++)
              ids.push(await scheduler.runAfter(delayMs + i * (step ?? 1000), fn === "other" ? otherRef : workRef,
                { i, big: BigInt(i) }));
            return ids;
          },
        });
        export const work = mutation({ args: { i: v.number(), big: v.optional(v.int64()) }, handler: async () => {} });
        export const other = mutation({ args: { i: v.number(), big: v.optional(v.int64()) }, handler: async () => {} });`,
    },
    {
      path: "crons.js",
      source: `import { cronJobs, makeFunctionReference } from "@bunvex/server";
        const crons = cronJobs();
        crons.interval("tick", { hours: 1 }, makeFunctionReference("jobs:work"), { i: -1 });
        crons.daily("nightly", { hourUTC: 3, minuteUTC: 30 }, makeFunctionReference("jobs:other"), { i: -2 });
        export default crons;`,
    },
  ]);
  // runs of two functions, far in the future; three files of different kinds
  await srv.call("mutation", "jobs:schedule", { count: 3, delayMs: 10 * HOUR });
  await srv.call("mutation", "jobs:schedule", { count: 2, delayMs: 11 * HOUR, fn: "other" });
  const src = open();
  for (const [body, type] of [
    ["hello", "text/plain"],
    ["{}", "application/json"],
    ["\x89PNG", "image/png"],
  ] as const)
    await src.uploadFile!(new Blob([body], { type }));
});

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  srv?.stop();
});

describeDataSourceContract("@bunvex/dashboard-source on a live server (PR 5)", () => open(), {
  only: ["deploymentFeatures"],
  schedules: { cancel: true },
  files: { write: true },
});

/** Watches with `watch` and records what it hears. */
function recorder(watch: (on: (c?: LiveChange) => void, onError: (e: DataSourceError) => void) => () => void) {
  const heard: (LiveChange | undefined)[] = [];
  const errors: DataSourceError[] = [];
  const off = watch(
    (c) => heard.push(c),
    (e) => errors.push(e),
  );
  return { heard, errors, off };
}

describe("schedules (Convex's paginatedScheduledJobs, scheduler:getArgs, listCronJobs, listCronJobRuns)", () => {
  test("a run: its function by display path, its arguments decoded, its time in ms, nearest first", async () => {
    const before = Date.now();
    await srv.call("mutation", "jobs:schedule", { count: 2, delayMs: 20 * HOUR, fn: "other" });
    const { page } = await open().listScheduledFunctions!({ numItems: 100, cursor: null, function: "jobs:other" });
    const mine = page.filter((j) => j.scheduledTime >= before + 20 * HOUR - 1000);
    expect(mine.map((j) => [j.function, j.state, j.args])).toEqual([
      ["jobs:other", "pending", { i: 0, big: { $integer: "AAAAAAAAAAA=" } }],
      ["jobs:other", "pending", { i: 1, big: { $integer: "AQAAAAAAAAA=" } }],
    ]);
    expect(mine[0]!.scheduledTime).toBeLessThanOrEqual(Date.now() + 20 * HOUR);
    expect(mine[0]!.creationTime).toBeGreaterThanOrEqual(before - 1);
    for (const j of page) expect(j.function).toBe("jobs:other");
  });

  test("cron jobs: Convex's schedules with numbers, the next run, the interval job's first run", async () => {
    const src = open();
    const jobs = await src.listCronJobs!();
    expect(jobs.map((j) => [j.name, j.function, j.schedule, j.args])).toEqual([
      ["nightly", "jobs:other", { type: "daily", hourUTC: 3, minuteUTC: 30 }, { i: -2 }],
      ["tick", "jobs:work", { type: "interval", seconds: 3600 }, { i: -1 }],
    ]);
    const tick = jobs.find((j) => j.name === "tick")!;
    expect(tick.nextRun).toBeGreaterThan(Date.now() + HOUR / 2);
    const runs = await until(async () => {
      const r = await src.listCronRuns!("tick");
      return r.length > 0 && r;
    }, "the interval job's first run");
    expect(runs[0]).toMatchObject({ name: "tick", function: "jobs:work", status: "success", logLines: [] });
    expect(runs[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(await src.listCronRuns!("nightly")).toEqual([]);
  });

  test("back-to-back reads of the same queries answer their results, never a dropped one (CI: a null run list)", async () => {
    const src = open();
    for (let i = 0; i < 150; i++) {
      const jobs = await src.listCronJobs!();
      expect(jobs.length).toBe(2);
      for (const j of jobs) expect(Array.isArray(await src.listCronRuns!(j.name))).toBe(true);
    }
  });

  test("cancelling all of a function's runs counts the ones listed", async () => {
    const src = open();
    await srv.call("mutation", "jobs:schedule", { count: 4, delayMs: 30 * HOUR, fn: "other" });
    const listed = (await src.listScheduledFunctions!({ numItems: 100, cursor: null, function: "jobs:other" })).page;
    expect(await src.cancelAllScheduledFunctions!("jobs:other")).toEqual({ canceled: listed.length });
    expect((await src.listScheduledFunctions!({ numItems: 100, cursor: null, function: "jobs:other" })).page).toEqual(
      [],
    );
  });
});

describe("tableOfId for a file's and a scheduled run's ids (STUDY-163 §2)", () => {
  test("named by the table mapping's system tables, as Convex's getReferencedTableName", async () => {
    const src = open();
    const file = await src.uploadFile!(new Blob(["referenced"]));
    expect(await src.tableOfId!(file)).toBe("_file_storage");
    await srv.call("mutation", "jobs:schedule", { count: 1, delayMs: 30 * HOUR, fn: "other" });
    const [run] = (await src.listScheduledFunctions!({ numItems: 1, cursor: null, function: "jobs:other" })).page;
    expect(await src.tableOfId!(run!.id)).toBe("_scheduled_jobs");
    await src.deleteFiles!([file]);
  });
});

describe("files (Convex's fileStorageV2)", () => {
  test("a file's metadata as stored, with a URL that serves it", async () => {
    const src = open();
    const id = await src.uploadFile!(new Blob(["a file"], { type: "text/csv" }));
    const f = await src.getFile!(id);
    expect(f).toMatchObject({ id, size: 6, contentType: "text/csv" });
    expect(await (await fetch(f!.url)).text()).toBe("a file");
    expect((await src.listFiles!({ numItems: 1, cursor: null })).page[0]?.id).toBe(id);
    expect(await src.countFiles!()).toBeGreaterThanOrEqual(4);
    await src.deleteFiles!([id]);
  });

  test("a file uploaded without a type has none", async () => {
    const src = open();
    const id = await src.uploadFile!(new Blob(["raw"]));
    expect((await src.getFile!(id))?.contentType).toBeNull();
    await src.deleteFiles!([id]);
  });
});

describe("the audit log (Convex's paginatedDeploymentEvents)", () => {
  test("the dashboard's own writes are recorded, newest first, an admin as an unknown member; the deploy by its push", async () => {
    const src = open();
    const id = await src.uploadFile!(new Blob(["audited"]));
    await src.deleteFiles!([id]);
    const [latest, before] = (await src.listAuditEvents!({ numItems: 2, cursor: null })).page;
    expect(latest?.action).toBe("delete_files");
    expect(latest?.metadata).toMatchObject({ storage_ids: [id] });
    expect(before?.action).toBe("generate_upload_url");
    // an admin key's member is no team member: Convex's dashboard shows "Unknown member"
    expect(latest?.author).toBeNull();
    const pushes = [];
    let cursor: string | null = null;
    for (let done = false; !done; ) {
      const p = await src.listAuditEvents!({ numItems: 3, cursor, actions: ["push_config_with_components"] });
      pushes.push(...p.page);
      [done, cursor] = [p.isDone, p.continueCursor];
    }
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.time).toBeLessThan(latest!.time);
  });
});

describe("watchers: every loaded page is a subscription", () => {
  test("a new nearest run reaches watchScheduledFunctions; an unrelated write does not", async () => {
    const src = open();
    await src.listScheduledFunctions!({ numItems: 5, cursor: null });
    const r = recorder((on, err) => src.watchScheduledFunctions!(on, err));
    await Bun.sleep(100);
    await srv.call("mutation", "messages:send", { body: "unrelated" });
    await Bun.sleep(200);
    expect(r.heard).toEqual([]);
    await srv.call("mutation", "jobs:schedule", { count: 1, delayMs: 60_000 });
    await until(() => r.heard.length > 0, "the watcher");
    r.off();
    expect(r.heard[0]).toEqual({ paused: false });
    expect(r.errors).toEqual([]);
  });

  test("a change on a later page is heard (the screen's loaded pages)", async () => {
    const src = open();
    await srv.call("mutation", "jobs:schedule", { count: 6, delayMs: 40 * HOUR });
    const first = await src.listScheduledFunctions!({ numItems: 2, cursor: null });
    let cursor = first.continueCursor;
    let last = first;
    while (!last.isDone) {
      last = await src.listScheduledFunctions!({ numItems: 2, cursor });
      cursor = last.continueCursor;
      if (last.page.length > 0) break;
    }
    const onLater = last.page[0]!;
    const r = recorder((on, err) => src.watchScheduledFunctions!(on, err));
    await Bun.sleep(100);
    expect(r.heard).toEqual([]);
    await src.cancelScheduledFunction!(onLater.id);
    await until(() => r.heard.length > 0, "the later page's change");
    r.off();
  });

  test("an upload reaches watchFiles; an event reaches watchAuditEvents", async () => {
    const src = open();
    await src.listFiles!({ numItems: 10, cursor: null });
    await src.listAuditEvents!({ numItems: 10, cursor: null });
    const files = recorder((on, err) => src.watchFiles!(on, err));
    let events = 0;
    const offEvents = src.watchAuditEvents!(
      () => events++,
      () => {},
    );
    await Bun.sleep(100);
    const id = await open().uploadFile!(new Blob(["watched"]));
    await until(() => files.heard.length > 0 && events > 0, "both watchers");
    files.off();
    offEvents();
    expect(files.heard[0]).toEqual({ paused: false });
    await open().deleteFiles!([id]);
  });

  test("nothing is subscribed once the last watcher is gone", async () => {
    const src = open();
    await src.listFiles!({ numItems: 10, cursor: null });
    const r = recorder((on, err) => src.watchFiles!(on, err));
    r.off();
    const id = await open().uploadFile!(new Blob(["unwatched"]));
    await Bun.sleep(200);
    expect(r.heard).toEqual([]);
    await open().deleteFiles!([id]);
  });
});

describe("Convex's auto-pause: past 100 updates in 10 s", () => {
  test("the scheduled runs stop being followed; subscribing again resumes them", async () => {
    const src = open();
    await src.listScheduledFunctions!({ numItems: 50, cursor: null });
    const r = recorder((on, err) => src.watchScheduledFunctions!(on, err));
    await Bun.sleep(50);
    // each run nearer than the last: every one changes the first page
    for (let i = 0; i < 160 && !r.heard.some((c) => c?.paused); i++)
      await srv.call("mutation", "jobs:schedule", { count: 1, delayMs: 50 * 60_000 - i * 1000 });
    const paused = r.heard.findIndex((c) => c?.paused);
    expect(paused).toBeGreaterThanOrEqual(100);
    expect(r.heard.slice(0, paused).every((c) => c?.paused === false)).toBe(true);
    const heard = r.heard.length;
    await srv.call("mutation", "jobs:schedule", { count: 1, delayMs: 60_000 });
    await Bun.sleep(300);
    expect(r.heard.length).toBe(heard);
    // while paused, reads still answer (Convex's one-shot queries)
    const page = await src.listScheduledFunctions!({ numItems: 1, cursor: null });
    expect(page.page[0]!.scheduledTime).toBeLessThan(Date.now() + 2 * 60_000);
    // "Go live"
    const again = recorder((on, err) => src.watchScheduledFunctions!(on, err));
    await Bun.sleep(100);
    await srv.call("mutation", "jobs:schedule", { count: 1, delayMs: 30_000 });
    await until(() => again.heard.length > 0, "the resumed watcher");
    expect(again.heard[0]).toEqual({ paused: false });
    again.off();
    r.off();
    await src.cancelAllScheduledFunctions!("jobs:work");
  });
});

describe("Health: concurrency and subscription invalidations (Convex's app_metrics)", () => {
  const window = () => {
    const end = Date.now() + 60_000;
    return { start: end - 10 * 60_000, end, numBuckets: 10 };
  };

  test("concurrency: running and queued per kind, a bucket per window bucket", async () => {
    await srv.call("query", "messages:list");
    const w = window();
    const got = (await open().functionConcurrency?.(w)) ?? [];
    expect(got.map((c) => c.kind)).toEqual(["query", "mutation", "action", "nodeAction"]);
    for (const c of got) {
      expect(c.running.map((b) => b.time)).toEqual(Array.from({ length: 10 }, (_, i) => w.start + i * 60_000));
      expect(c.queued).toHaveLength(10);
    }
    const queries = got.find((c) => c.kind === "query")!;
    expect(queries.running.some((b) => b.value !== null)).toBe(true);
  });

  test("invalidations: the mutation and the table its write re-ran a subscription in", async () => {
    const app = new BunvexClient(srv.url, { logger: false });
    let results = 0;
    const off = app.onUpdate("messages:list", {}, () => results++);
    try {
      await until(() => results > 0, "the subscription");
      await srv.call("mutation", "messages:send", { body: "invalidates" });
      await until(() => results > 1, "the re-run");
      const src = open();
      const top = await until(async () => {
        // the dashboard's own subscriptions count too (as Convex's): enough room for every pair
        const t = (await src.subscriptionInvalidations?.(window(), 25)) ?? [];
        return t.some((x) => x.function === "messages:send") && t;
      }, "the invalidation");
      const send = top.find((x) => x.function === "messages:send")!;
      expect(send.table).toBe("messages");
      expect(send.series.reduce((n, b) => n + (b.value ?? 0), 0)).toBeGreaterThanOrEqual(1);
      const one = (await src.subscriptionInvalidations?.(window(), 3, { function: "messages:send" })) ?? [];
      expect(one.map((x) => [x.function, x.table])).toEqual([["messages:send", "messages"]]);
    } finally {
      off();
      await app.close();
    }
  });

  test("a read-only key may read both; a wrong k is invalid_request", async () => {
    const src = open(srv.readOnlyKey);
    expect(Array.isArray(await src.functionConcurrency?.(window()))).toBe(true);
    const bad = await open()
      .subscriptionInvalidations?.(window(), 26)
      .catch((e: DataSourceError) => e);
    expect((bad as DataSourceError).code).toBe("invalid_request");
  });
});
