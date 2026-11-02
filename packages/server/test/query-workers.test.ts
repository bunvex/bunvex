// Queries on execution workers (STUDY-194 2b, step iv). A deployable server on a SQLite file runs a client's queries on
// its workers; under the tests every such query also runs in-thread and the two outcomes are compared field by field
// (result, error, log lines and figures, read set interval by interval, counters), a difference failing the call
// (`query-workers.ts`, `outcomeMismatch`). Here: generated programs of writes and queries over indexes, ranges,
// pagination, counts, text search, variables, the clock, logs and errors; a commit while a worker's query is held, which
// it must not see; a push while queries are in flight; a worker that dies, and a query that never yields.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "ef".repeat(32);
const NAME = "query-workers-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, source: string): ModuleSource => ({ path, source, environment: "isolate" });

const SCHEMA = mod(
  "schema.js",
  `import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
export default defineSchema({
  items: defineTable({ k: v.any(), n: v.any(), body: v.string() })
    .index("by_k", ["k"])
    .index("by_k_n", ["k", "n"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["k"] }),
});`,
);

const app = (version: string) =>
  mod(
    "q.js",
    `import { mutation, query } from "@bunvex/server";
import { BunvexError, v } from "@bunvex/values";
export const add = mutation({ args: { k: v.any(), n: v.any(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const remove = mutation({ args: { id: v.id("items") }, handler: (ctx, { id }) => ctx.db.delete(id) });
export const all = query({ args: { order: v.union(v.literal("asc"), v.literal("desc")) }, handler: (ctx, { order }) => ctx.db.query("items").order(order).collect() });
export const range = query({ args: { lo: v.any(), hi: v.any() }, handler: (ctx, { lo, hi }) => ctx.db.query("items").withIndex("by_k", (q) => q.gte("k", lo).lt("k", hi)).collect() });
export const latest = query({ args: { k: v.any() }, handler: (ctx, { k }) => ctx.db.query("items").withIndex("by_k_n", (q) => q.eq("k", k)).order("desc").take(3) });
export const where = query({ args: { n: v.any() }, handler: (ctx, { n }) => ctx.db.query("items").filter((q) => q.eq(q.field("n"), n)).first() });
export const counted = query({ args: {}, handler: (ctx) => ctx.db.query("items").count() });
export const page = query({ args: { cursor: v.union(v.string(), v.null()), n: v.number() }, handler: (ctx, { cursor, n }) => ctx.db.query("items").withIndex("by_k").paginate({ cursor, numItems: n }) });
export const found = query({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.query("items").withSearchIndex("search_body", (q) => q.search("body", text)).take(5) });
export const one = query({ args: { k: v.any() }, handler: (ctx, { k }) => ctx.db.query("items").withIndex("by_k", (q) => q.eq("k", k)).unique() });
export const get = query({ args: { id: v.string() }, handler: async (ctx, { id }) => { const n = ctx.db.normalizeId("items", id); return n && ctx.db.get(n); } });
export const env = query({ args: { x: v.number() }, handler: (_ctx, { x }) => [x, process.env.FOO ?? null, process.env.BUNVEX_CLOUD_URL ?? null] });
export const clock = query({ args: { x: v.number() }, handler: (_ctx, { x }) => [x, Date.now() > 0] });
export const chatty = query({ args: { n: v.number() }, handler: (_ctx, { n }) => { for (let i = 0; i < n; i++) console.log("line", i, { i }); console.warn("done"); return n; } });
export const thrown = query({ args: { code: v.number() }, handler: (_ctx, { code }) => { throw new BunvexError({ code }); } });
export const broken = query({ args: { x: v.number() }, handler: (_ctx, { x }) => { const o = null; return o.field + x; } });
export const spin = query({ args: {}, handler: () => { for (;;) {} } });
export const slow = query({ args: { n: v.number() }, handler: async (ctx, { n }) => { let c = 0; for (let i = 0; i < n; i++) c += (await ctx.db.query("items").take(1)).length; return c; } });
export const countThenAll = query({ args: { x: v.number() }, handler: async (ctx) => [await ctx.db.query("items").count(), (await ctx.db.query("items").collect()).length] });
export const version = query({ args: { x: v.number() }, handler: (_ctx, { x }) => ["${version}", x] });`,
  );

async function deployment(o: { workers?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-query-workers-"));
  dirs.push(dir);
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
    executionWorkers: o.workers ?? 2,
  });
  await s.codeReady;
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object, admin = true) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(admin ? { authorization: `Bunvex ${KEY}` } : {}) },
      body: JSON.stringify(body),
    });
    return (await r.json()) as Record<string, any>;
  };
  const push = async (version: string) => {
    const start = await post("/api/deploy2/start_push", {
      adminKey: KEY,
      functions: "bunvex",
      nodeDependencies: [],
      appDefinition: {
        definition: null,
        dependencies: [],
        schema: SCHEMA,
        changedModules: [app(version)],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: [],
    });
    if (!start.schemaChange) throw new Error(JSON.stringify(start));
    await post("/api/deploy2/wait_for_schema", { adminKey: KEY, schemaChange: start.schemaChange, timeoutMs: 10000 });
    const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start, dryRun: false });
    if (finish.code) throw new Error(JSON.stringify(finish));
  };
  await push("v1");
  await post("/api/update_environment_variables", { changes: [{ name: "FOO", value: "bar" }] });
  /** A client's query (no admin key: the system identity's run in-thread). */
  const query = (path: string, args: object = {}) => post("/api/query", { path, args, format: "json" }, false);
  const mutation = (path: string, args: object = {}) => post("/api/mutation", { path, args, format: "json" }, false);
  const workers = s.queryWorkers!;
  // The first call starts a worker; the next ones run on it once it is ready.
  await query("q:counted");
  for (let i = 0; i < 200 && workers.ready === 0; i++) await Bun.sleep(10);
  if (workers.ready === 0) throw new Error("no execution worker started");
  return { s, engine, functions, workers, query, mutation, push };
}

/** A seeded generator (mulberry32), so a failing run is the same run again. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  return { next, pick, int: (n: number) => Math.floor(next() * n) };
}

const KEYS = ["a", "b", "c", "", 1, 2, -1, 0.5, null, true] as const;
const WORDS = ["apple", "banana", "cherry", "app", "ban", "zebra"];

/** A failed call, as the client sees it: never the differential check's. */
function noMismatch(r: Record<string, any>) {
  expect(String(r.errorMessage ?? "")).not.toContain("differs from the in-thread one");
}

describe("queries on execution workers answer as in-thread", () => {
  test("generated programs: writes, then queries of every kind, each checked against an in-thread run", async () => {
    const d = await deployment();
    const before = d.workers.counts.answered;
    let ran = 0;
    for (const seed of [1, 2, 3]) {
      const r = rng(seed);
      const ids: string[] = [];
      for (let step = 0; step < 60; step++) {
        const roll = r.next();
        if (roll < 0.3 || ids.length === 0) {
          const w = await d.mutation("q:add", {
            k: r.pick(KEYS),
            n: r.int(3),
            body: `${r.pick(WORDS)} ${r.pick(WORDS)}`,
          });
          ids.push(w.value);
          continue;
        }
        if (roll < 0.35) {
          const id = ids.splice(r.int(ids.length), 1)[0]!;
          await d.mutation("q:remove", { id });
          continue;
        }
        const x = step + seed * 1000;
        const calls: [string, object][] = [
          ["q:all", { order: r.pick(["asc", "desc"]) }],
          ["q:range", { lo: r.pick(KEYS), hi: r.pick(KEYS) }],
          ["q:latest", { k: r.pick(KEYS) }],
          ["q:where", { n: r.int(4) }],
          ["q:counted", {}],
          ["q:page", { cursor: null, n: 1 + r.int(4) }],
          ["q:found", { text: r.pick(WORDS) }],
          ["q:one", { k: r.pick(KEYS) }],
          ["q:get", { id: r.pick([...ids, "nope"]) }],
          ["q:env", { x }],
          ["q:clock", { x }],
          ["q:chatty", { n: r.int(5) }],
          ["q:thrown", { code: x }],
          ["q:broken", { x }],
          ["q:countThenAll", { x }],
        ];
        const [path, args] = r.pick(calls);
        const out = await d.query(path, args);
        noMismatch(out);
        ran++;
        // The next page, from the cursor the first gave.
        if (path === "q:page" && out.status === "success" && !out.value.isDone) {
          noMismatch(await d.query("q:page", { cursor: out.value.continueCursor, n: 2 }));
          ran++;
        }
      }
    }
    // Most of them ran on a worker (a cached result or a call made while none was ready did not).
    expect(d.workers.counts.answered - before).toBeGreaterThan(ran / 2);
    expect(d.workers.counts.died + d.workers.counts.stuck).toBe(0);
  }, 120_000);

  test("a worker's query does not see a commit after its snapshot, and its result is not served after it", async () => {
    const d = await deployment({ workers: 1 });
    await d.mutation("q:add", { k: "a", n: 1, body: "x" });
    // Hold the query's count on the main thread while a mutation commits.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const answer = d.engine.answerOp.bind(d.engine);
    let asked = false;
    d.engine.answerOp = (text: string) => {
      if (!asked && text[0] === "n") {
        asked = true;
        return held.then(() => answer(text)) as unknown as string;
      }
      return answer(text);
    };
    const pending = d.query("q:countThenAll", { x: 1 });
    for (let i = 0; i < 200 && !asked; i++) await Bun.sleep(5);
    expect(asked).toBe(true);
    await d.mutation("q:add", { k: "b", n: 2, body: "y" });
    release();
    const r = await pending;
    noMismatch(r);
    expect(r.value).toEqual([1, 1]);
    // The same query again: its read set covered the new document, so it runs again and sees it.
    expect((await d.query("q:countThenAll", { x: 1 })).value).toEqual([2, 2]);
  });

  test("a query that waited for its permit reads at the snapshot it was given, not at the commits since", async () => {
    const d = await deployment({ workers: 1 });
    await d.mutation("q:add", { k: "a", n: 1, body: "x" });
    // Every permit taken: the query chooses its snapshot, then waits.
    const limiter = d.functions.limits.query;
    const held = await Promise.all(Array.from({ length: limiter.max }, () => limiter.acquire()));
    const pending = d.query("q:countThenAll", { x: 2 });
    for (let i = 0; i < 200 && limiter.outstanding.queued === 0; i++) await Bun.sleep(5);
    expect(limiter.outstanding.queued).toBe(1);
    // A commit the worker hears before the query reaches it.
    await d.mutation("q:add", { k: "b", n: 2, body: "y" });
    await Bun.sleep(20);
    for (const release of held) release();
    const r = await pending;
    noMismatch(r);
    expect(r.value).toEqual([1, 1]);
  });

  test("a push while queries are in flight: each answers from the code it was checked against, none fails", async () => {
    const d = await deployment();
    const calls: Promise<Record<string, any>>[] = [];
    for (let i = 0; i < 100; i++) calls.push(d.query("q:version", { x: i }));
    const pushed = d.push("v2");
    for (let i = 100; i < 200; i++) calls.push(d.query("q:version", { x: i }));
    await pushed;
    const out = await Promise.all(calls);
    for (const r of out) {
      noMismatch(r);
      expect(r.status).toBe("success");
      expect(["v1", "v2"]).toContain(r.value[0]);
    }
    expect((await d.query("q:version", { x: 1000 })).value).toEqual(["v2", 1000]);
  }, 60_000);
});

describe("the page cache (STUDY-194 Q9)", () => {
  test("the store's own connection keeps half of the deployment's cache once workers can start", async () => {
    const d = await deployment({ workers: 2 });
    const store = d.engine.persistence as unknown as {
      cacheBytes: number;
      db: { query(sql: string): { get(): { cache_size: number } } };
    };
    expect(store.db.query("pragma cache_size").get().cache_size).toBe(-Math.ceil(store.cacheBytes / 2 / 1024));
  });
});

describe("failures", () => {
  test("a worker that dies fails its calls as system errors; the next call succeeds on a new one", async () => {
    const d = await deployment({ workers: 1 });
    for (let i = 0; i < 20; i++) await d.mutation("q:add", { k: i, n: 0, body: "z" });
    const slow = d.query("q:slow", { n: 100000 });
    await Bun.sleep(50);
    const threads = (d.workers as unknown as { threads: { worker: Worker }[] }).threads;
    threads[0]!.worker.terminate();
    const r = await slow;
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("Server Error");
    expect(d.workers.counts.died).toBe(1);
    // The next call runs in-thread (none ready) and starts another worker; then calls run on it.
    expect((await d.query("q:counted")).value).toBe(20);
    for (let i = 0; i < 200 && d.workers.ready === 0; i++) await Bun.sleep(10);
    const answered = d.workers.counts.answered;
    expect((await d.query("q:version", { x: 7 })).value).toEqual(["v1", 7]);
    expect(d.workers.counts.answered).toBe(answered + 1);
  }, 60_000);

  test("a query that never yields times out with the user time limit's message; others answer meanwhile", async () => {
    const d = await deployment({ workers: 2 });
    // A second worker starts once the first is busy.
    for (let i = 0; i < 20; i++) await d.mutation("q:add", { k: i, n: 0, body: "z" });
    await Promise.all([d.query("q:slow", { n: 300 }), d.query("q:slow", { n: 301 })]);
    for (let i = 0; i < 200 && d.workers.ready < 2; i++) await Bun.sleep(10);
    expect(d.workers.ready).toBe(2);
    const spin = d.query("q:spin");
    await Bun.sleep(100);
    // The main thread answers while a worker spins.
    expect((await d.query("q:version", { x: 1 })).value).toEqual(["v1", 1]);
    const r = await spin;
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("Function execution timed out (maximum duration: 1s)");
    expect(d.workers.counts.stuck).toBe(1);
  }, 30_000);
});
