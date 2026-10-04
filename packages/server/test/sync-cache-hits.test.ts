// A sync query served without running (STUDY-75), as Convex's query cache logs it: a session that reuses
// another's result, or joins its run, logs a cache hit — `cached: true`, the run's lines, its own run reason —
// in the function log and the log streams; a reused failure is logged as a run (Convex never caches errors).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { FunctionLog } from "../src/function-log.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "6a".repeat(32);
const NAME = "cache-hits";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const store = await MemoryPersistence.open(null, { durable: false });
  // A gate on reading one document: a query that reads it waits until the test opens it.
  const gate = { id: "", open: Promise.resolve() as Promise<void> };
  const get = store.get.bind(store);
  store.get = (async (...a: Parameters<typeof get>) => {
    if (a[1] === gate.id) await gate.open;
    return get(...a);
  }) as unknown as typeof store.get;
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), store, {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const id = (await engine.mutation((db) => db.insert("items", { n: 1 }))) as string;
  let runs = 0;
  const functions = new Functions(engine).register("m", {
    list: query(async ({ db }) => {
      console.log("listing");
      runs++;
      return (await db.query("items").collect()).length;
    }),
    gated: query(async ({ db }) => {
      console.log("gated");
      runs++;
      return (await db.get(id as never)) && 1;
    }),
    whoami: query(async ({ auth }) => {
      runs++;
      return (await auth.getUserIdentity()) === null ? "anonymous" : "someone";
    }),
    broken: query(() => {
      runs++;
      throw new Error("always");
    }),
    add: mutation(({ db }) => db.insert("items", {})),
  });
  const s = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(() => s.stop());
  const events: Record<string, any>[] = [];
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      for (const x of e) if (x.event.topic === "function_execution") events.push(eventJsonV2(x));
    },
  } as never;
  const completions: any[] = [];
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") completions.push(p);
    },
  } as unknown as FunctionLog;
  const client = () => v1Client(syncUrl(s.server.port));
  const of = (path: string) => events.filter((e) => e.function.path === path);
  const until = async <T>(f: () => T | undefined | false) => {
    for (let i = 0; i < 400; i++) {
      const x = f();
      if (x) return x;
      await Bun.sleep(5);
    }
    throw new Error("timed out");
  };
  const hold = () => {
    let release = () => {};
    gate.id = id;
    gate.open = new Promise<void>((r) => (release = r));
    return release;
  };
  return { client, of, until, completions, hold, runs: () => runs };
}

test("a second session reusing a result logs a cache hit with the run's lines", async () => {
  const t = await setup();
  const a = await t.client();
  a.modify([add(1, "m:list")]);
  await t.until(() => t.of("m.js:list").length === 1);
  const b = await t.client();
  b.modify([add(1, "m:list")]);
  await t.until(() => t.of("m.js:list").length === 2);
  expect(t.runs()).toBe(1);
  const [ran, hit] = t.of("m.js:list");
  expect(ran.function.cached).toBe(false);
  expect(hit.function.cached).toBe(true);
  expect(hit.run_reason).toBe("initialSubscription");
  expect(hit.usage.function_returns_bytes).toBe(ran.usage.function_returns_bytes);
  // The function log too, with the lines the run printed.
  const [, logged] = t.completions.filter((c) => c.identifier === "m:list");
  expect(logged).toMatchObject({ cachedResult: true, caller: "SyncWorker", error: null });
  expect(JSON.stringify(logged.logLines)).toContain("listing");
});

test("a session joining a run in flight logs a cache hit once it is served", async () => {
  const t = await setup();
  const release = t.hold();
  const a = await t.client();
  const b = await t.client();
  a.modify([add(1, "m:gated")]);
  await Bun.sleep(30);
  b.modify([add(1, "m:gated")]);
  await Bun.sleep(30);
  release();
  await t.until(() => t.of("m.js:gated").length === 2);
  expect(t.runs()).toBe(1);
  expect(t.of("m.js:gated").map((e) => e.function.cached)).toEqual([false, true]);
});

test("a reused failure is logged as a failed run, not a cache hit", async () => {
  const t = await setup();
  const a = await t.client();
  a.modify([add(1, "m:broken")]);
  await t.until(() => t.of("m.js:broken").length === 1);
  const b = await t.client();
  b.modify([add(1, "m:broken")]);
  await t.until(() => t.of("m.js:broken").length === 2);
  const second = t.of("m.js:broken")[1];
  expect(second.function.cached).toBe(false);
  expect(second.status).toBe("failure");
  expect(second.error_message).toContain("always");
});

test("a session whose identity changed reuses the run of another with that identity: a hit", async () => {
  const t = await setup();
  const authenticate = (c: Awaited<ReturnType<typeof t.client>>) =>
    c.send({ type: "Authenticate", tokenType: "Admin", value: KEY, baseVersion: 0 } as v1.ClientMessage);
  // An admin session runs it under the admin's identity.
  const admin = await t.client();
  authenticate(admin);
  admin.modify([add(1, "m:whoami")]);
  await t.until(() => t.of("m.js:whoami").length === 1);
  // An anonymous session runs it as itself, then authenticates as the same admin: the admin's run serves it.
  const other = await t.client();
  other.modify([add(1, "m:whoami")]);
  await t.until(() => t.of("m.js:whoami").length === 2);
  authenticate(other);
  await t.until(() => t.of("m.js:whoami").length === 3);
  expect(t.runs()).toBe(2);
  expect(t.of("m.js:whoami")[2]).toMatchObject({ run_reason: "identityChange", function: { cached: true } });
});
