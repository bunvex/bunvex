// `/api/delete_scheduled_functions_table` (STUDY-113), as Convex's route (local_backend/src/scheduling.rs,
// `Application::delete_scheduled_jobs_table`): the scheduler's table replaced with an empty one in one commit,
// whatever it holds; WriteData required; a `delete_scheduled_jobs_table` audit event.
import { afterEach, expect, test } from "bun:test";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, internalMutation, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "5e".repeat(32);
const NAME = "delete-jobs";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, what: string) {
  for (let i = 0; i < 400; i++) {
    const x = await f();
    if (x) return x;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const ran: string[] = [];
  let entered = () => {};
  const inAction = new Promise<void>((r) => {
    entered = r;
  });
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const functions = new Functions(engine).register("m", {
    bump: internalMutation(async ({ db }, { tag }: { tag: string }) => {
      ran.push(tag);
      await db.insert("items", { tag });
    }),
    // Schedules `n` runs of `bump` after `delay` ms (at most 1000 a mutation).
    many: mutation(async ({ scheduler }, { n, delay, tag }: { n: number; delay: number; tag: string }) => {
      for (let i = 0; i < n; i++) await scheduler.runAfter(delay, "m:bump", { tag });
    }),
    // A job that is in progress until the test lets it go.
    slow: action(async () => {
      ran.push("slow:start");
      entered();
      await gate;
      ran.push("slow:end");
    }),
    scheduleSlow: mutation(async ({ scheduler }) => scheduler.runAfter(0, "m:slow", {})),
    // A mutation job held open mid-transaction.
    held: internalMutation(async ({ db }) => {
      ran.push("held:start");
      entered();
      await gate;
      await db.insert("items", { tag: "held" });
    }),
    scheduleHeld: mutation(async ({ scheduler }) => scheduler.runAfter(0, "m:held", {})),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null });
  stops.push(s.stop);
  const api = `http://127.0.0.1:${s.server!.port}`;
  const post = async (path: string, body: object, key = KEY) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { authorization: `Bunvex ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: r.status === 200 ? await r.text() : await r.json() };
  };
  const run = (path: string, args: object) => post("/api/mutation", { path, args });
  const jobs = () =>
    engine.query((db) => db.system.query("_scheduled_functions").collect()) as unknown as Promise<
      { name: string; state: { kind: string } }[]
    >;
  const events = () =>
    engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect())) as unknown as Promise<
      { action: string; metadata: unknown; member_id: unknown }[]
    >;
  return { api, engine, scheduler: s.scheduler, ran, inAction, release, post, run, jobs, events };
}

const SOON_MS = 4000;

test("every job goes at once: pending, in progress and done; none runs later; the scheduler keeps working", async () => {
  const t = await setup();
  // One done, one in progress, 2000 waiting (two mutations' worth, one of them due soon).
  expect((await t.run("m:many", { n: 1, delay: 0, tag: "done" })).status).toBe(200);
  await until(async () => (await t.jobs()).some((j) => j.state.kind === "success"), "the first job");
  expect((await t.run("m:scheduleSlow", {})).status).toBe(200);
  await t.inAction;
  // "Soon" must not come before the delete below, however slow the machine: scheduling 1000 more jobs and
  // deleting the table took over 400 ms on a loaded runner, and the soon jobs ran first.
  const soonAt = Date.now() + SOON_MS;
  expect((await t.run("m:many", { n: 1000, delay: SOON_MS, tag: "soon" })).status).toBe(200);
  expect((await t.run("m:many", { n: 1000, delay: 3_600_000, tag: "later" })).status).toBe(200);
  expect((await t.jobs()).length).toBe(2002);

  expect(await t.post("/api/delete_scheduled_functions_table", {})).toEqual({ status: 200, body: "" });
  expect(await t.jobs()).toEqual([]);

  // The running action finishes and finds its job gone: nothing is recorded, nothing fails.
  t.release();
  await until(() => t.ran.includes("slow:end"), "the action to end");
  await Bun.sleep(Math.max(0, soonAt + 200 - Date.now())); // past the "soon" jobs' time
  expect(await t.jobs()).toEqual([]);
  expect(t.ran).toEqual(["done", "slow:start", "slow:end"]);
  expect(t.scheduler.stats.systemErrors).toBe(0);
  await t.engine.tablesDeleted();

  // A job scheduled afterwards runs at once: the executor watches the new table.
  expect((await t.run("m:many", { n: 1, delay: 0, tag: "after" })).status).toBe(200);
  await until(async () => (await t.jobs())[0]?.state.kind === "success", "a job scheduled after the deletion");
  expect(t.ran.at(-1)).toBe("after");
  expect((await t.jobs()).length).toBe(1);
}, 20_000);

test("a mutation job running meanwhile writes nothing: its retry finds the job gone", async () => {
  const t = await setup();
  expect((await t.run("m:scheduleHeld", {})).status).toBe(200);
  await t.inAction;
  expect((await t.post("/api/delete_scheduled_functions_table", {})).status).toBe(200);
  t.release();
  // The commit conflicts with the replacement (it read the old table); the engine retries it, and the retry
  // finds the job gone and writes nothing (as Convex's executor, `new_transaction_for_job_state`).
  await Bun.sleep(300);
  expect(await t.engine.query((db) => db.query("items").collect())).toEqual([]);
  expect(await t.jobs()).toEqual([]);
  expect(t.ran).toEqual(["held:start"]);
  expect(t.scheduler.stats.systemErrors).toBe(0);
});

test("the audit event: delete_scheduled_jobs_table for the root component, in the same commit", async () => {
  const t = await setup();
  expect((await t.run("m:many", { n: 3, delay: 60_000, tag: "x" })).status).toBe(200);
  expect((await t.post("/api/delete_scheduled_functions_table", { componentId: null })).status).toBe(200);
  const deleted = (await t.events()).filter((e) => e.action === "delete_scheduled_jobs_table");
  expect(deleted.length).toBe(1);
  expect(deleted[0]!.metadata).toEqual({ component_id: null, component: null });
  // An empty table is replaced all the same (Convex has no check), with its event.
  expect((await t.post("/api/delete_scheduled_functions_table", {})).status).toBe(200);
  expect((await t.events()).filter((e) => e.action === "delete_scheduled_jobs_table").length).toBe(2);
});

test("WriteData required (a read-only key gets 403), a component refused, no key refused", async () => {
  const t = await setup();
  expect((await t.run("m:many", { n: 2, delay: 60_000, tag: "x" })).status).toBe(200);
  const ro = await t.post("/api/delete_scheduled_functions_table", {}, READ_ONLY);
  expect(ro.status).toBe(403);
  expect(ro.body).toMatchObject({ code: "OperationNotPermitted" });
  expect((await t.post("/api/delete_scheduled_functions_table", { componentId: "abc" })).body).toMatchObject({
    code: "ComponentsNotSupported",
  });
  expect((await t.jobs()).length).toBe(2);
  expect((await t.events()).some((e) => e.action === "delete_scheduled_jobs_table")).toBe(false);
  // No admin key at all: refused before anything runs.
  const anonymous = await fetch(`${t.api}/api/delete_scheduled_functions_table`, { method: "POST", body: "{}" });
  expect([401, 403]).toContain(anonymous.status);
  expect((await t.jobs()).length).toBe(2);
});
