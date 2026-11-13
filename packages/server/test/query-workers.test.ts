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
import { type CallOutcome, defineSchema, Engine, encodeCallOutcome, type Persistence } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { MysqlPersistence } from "@bunvex/persistence/mysql";
import { PostgresPersistence } from "@bunvex/persistence/postgres";
import { v1 } from "@bunvex/protocol";
import { SQL } from "bun";
import { functionLimitsFromEnv, TooManyConcurrentRequestsError } from "../src/action-permits.ts";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { encodeCallError } from "../src/call-errors.ts";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { connectionSplit, outcomeMismatch } from "../src/query-workers.ts";
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

/**
 * At most this many of the tests' requests are open at once. A burst of new connections past the listen backlog
 * (`kern.ipc.somaxconn`, 128 on macOS) while the server's thread is busy is reset by the kernel (ECONNRESET) before
 * the server sees it.
 */
const OPEN_REQUESTS = 64;
let open = 0;
const waiting: (() => void)[] = [];
async function limited<T>(f: () => Promise<T>): Promise<T> {
  while (open >= OPEN_REQUESTS) await new Promise<void>((r) => waiting.push(r));
  open++;
  try {
    return await f();
  } finally {
    open--;
    waiting.shift()?.();
  }
}

const SCHEMA = mod(
  "schema.js",
  `import { defineSchema, defineTable } from "@bunvex/server";
import { v } from "@bunvex/values";
export default defineSchema({
  items: defineTable({ k: v.any(), n: v.any(), body: v.string() })
    .index("by_k", ["k"])
    .index("by_k_n", ["k", "n"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["k"] }),
  counters: defineTable({ k: v.string(), n: v.number() }).index("by_k", ["k"]),
  accounts: defineTable({ i: v.number(), b: v.number() }).index("by_i", ["i"]),
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
export const bump = mutation({ args: { k: v.string() }, handler: async (ctx, { k }) => { const c = await ctx.db.query("counters").withIndex("by_k", (q) => q.eq("k", k)).unique(); if (c) { await ctx.db.patch(c._id, { n: c.n + 1 }); return c.n + 1; } await ctx.db.insert("counters", { k, n: 1 }); return 1; } });
export const silent = mutation({ args: { k: v.string() }, handler: async (ctx, { k }) => { await ctx.db.insert("counters", { k, n: 1 }); } });
export const nulled = mutation({ args: { k: v.string() }, handler: async (ctx, { k }) => { await ctx.db.insert("counters", { k, n: 1 }); return null; } });
export const count = query({ args: { k: v.string() }, handler: async (ctx, { k }) => (await ctx.db.query("counters").withIndex("by_k", (q) => q.eq("k", k)).unique())?.n ?? 0 });
export const stamp = mutation({ args: {}, returns: v.object({ at: v.commitTs(), id: v.id("counters") }), handler: async (ctx) => ({ at: ctx.db.vars.commitTs, id: await ctx.db.insert("counters", { k: "stamp", n: 1 }) }) });
export const invalid = mutation({ args: {}, handler: (ctx) => ctx.db.insert("counters", { k: "bad", n: "one" }) });
export const slowAdd = mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => { for (let i = 0; i < n; i++) await ctx.db.query("items").take(1); return ctx.db.insert("counters", { k: "slow", n: 1 }); } });
export const open = mutation({ args: { i: v.number(), b: v.number() }, handler: (ctx, a) => ctx.db.insert("accounts", a) });
export const transfer = mutation({ args: { from: v.number(), to: v.number(), amount: v.number() }, handler: async (ctx, { from, to, amount }) => { const acct = (i) => ctx.db.query("accounts").withIndex("by_i", (q) => q.eq("i", i)).unique(); const a = await acct(from); const b = await acct(to); if (a.b < amount) return false; await ctx.db.patch(a._id, { b: a.b - amount }); await ctx.db.patch(b._id, { b: b.b + amount }); return true; } });
export const balances = query({ args: { x: v.number() }, handler: async (ctx) => (await ctx.db.query("accounts").withIndex("by_i").collect()).map((a) => a.b) });
export const version = query({ args: { x: v.number() }, handler: (_ctx, { x }) => ["${version}", x] });`,
  );

// STUDY-194 step v: a database server's store too, when PG_URL or MYSQL_URL names one (an EMPTY scratch database).
const PG_URL = process.env.PG_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const STORES = ["sqlite", ...(PG_URL ? ["postgres" as const] : []), ...(MYSQL_URL ? ["mysql" as const] : [])] as const;
type Store = (typeof STORES)[number];

/** A store of `kind`, empty. */
async function emptyStore(kind: Store): Promise<Persistence> {
  if (kind === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-query-workers-"));
    dirs.push(dir);
    return new SqlitePersistence(join(dir, "db.sqlite"), { durable: true });
  }
  const url = kind === "postgres" ? PG_URL! : MYSQL_URL!;
  // Bun's MySQL client authenticates as MySQL 8's default asks only over TLS: its own certificates, unverified.
  const sql = kind === "mysql" ? new SQL(url, { tls: { rejectUnauthorized: false } }) : new SQL(url);
  try {
    await sql.unsafe("drop table if exists documents, indexes, leases, read_only, persistence_globals");
  } finally {
    await sql.close();
  }
  const tls = { requireSsl: !process.env.DO_NOT_REQUIRE_SSL };
  return kind === "postgres" ? PostgresPersistence.open(url, 16, tls) : MysqlPersistence.open(url, 16, tls);
}

async function deployment(o: { workers?: number; store?: Store; limits?: Record<string, string> } = {}) {
  const engine = await new Engine(defineSchema({}), await emptyStore(o.store ?? "sqlite"), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const functions = new Functions(engine, o.limits ? { limits: functionLimitsFromEnv(o.limits) } : {});
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
  const post = (path: string, body: object, admin = true) =>
    limited(async () => {
      const r = await fetch(`${api}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(admin ? { authorization: `Bunvex ${KEY}` } : {}) },
        body: JSON.stringify(body),
      });
      return (await r.json()) as Record<string, any>;
    });
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

for (const store of STORES)
  describe(`queries on execution workers answer as in-thread (${store})`, () => {
    test("generated programs: writes, then queries of every kind, each checked against an in-thread run", async () => {
      const d = await deployment({ store });
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
      const d = await deployment({ workers: 1, store });
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
      const d = await deployment({ workers: 1, store });
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
      const d = await deployment({ store });
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

/** A mutation that ran out of OCC retries: the request's 503 code, as Convex's. */
const OCC_FAILURE = "OptimisticConcurrencyControlFailure";

describe("mutations (STUDY-194 PR 3)", () => {
  test("a client's mutations run on the workers and commit from their outcome, one at a time per key", async () => {
    const d = await deployment({ workers: 2 });
    const answered = d.workers.counts.answered;
    const keys = ["a", "b", "c"];
    const out = await Promise.all(Array.from({ length: 60 }, (_, i) => d.mutation("q:bump", { k: keys[i % 3] })));
    // Each succeeded, or ran out of OCC retries (Convex's 503) and committed nothing.
    for (const r of out) expect(["success", OCC_FAILURE]).toContain(r.status ?? r.code);
    // Every value a key handed out, once, and as many as committed: the commits were serialized as in-thread ones are.
    for (const k of keys) {
      const values = out.filter((r, i) => keys[i % 3] === k && r.status === "success").map((r) => r.value as number);
      expect(values.sort((x, y) => x - y)).toEqual(Array.from({ length: values.length }, (_, i) => i + 1));
      expect((await d.query("q:count", { k })).value).toBe(values.length);
    }
    expect(out.filter((r) => r.status === "success").length).toBeGreaterThan(30);
    expect(d.workers.counts.answered - answered).toBeGreaterThanOrEqual(60);
  }, 60_000);

  test("concurrent transfers keep the bank's total at every snapshot, and no balance goes negative", async () => {
    const d = await deployment({ workers: 2 });
    for (let i = 0; i < 5; i++) expect((await d.mutation("q:open", { i, b: 100 })).status).toBe("success");
    const answered = d.workers.counts.answered;
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const transfers = Array.from({ length: 120 }, () => {
      const from = rand(5);
      return d.mutation("q:transfer", { from, to: (from + 1 + rand(4)) % 5, amount: 1 + rand(40) });
    });
    const reads = Array.from({ length: 40 }, (_, x) => d.query("q:balances", { x }));
    const [moved, seen] = await Promise.all([Promise.all(transfers), Promise.all(reads)]);
    // Each succeeded, or ran out of OCC retries (Convex's 503) and moved nothing.
    for (const r of moved) expect(["success", OCC_FAILURE]).toContain(r.status ?? r.code);
    for (const r of seen) {
      expect((r.value as number[]).reduce((a, b) => a + b, 0)).toBe(500);
      for (const b of r.value as number[]) expect(b).toBeGreaterThanOrEqual(0);
    }
    const final = (await d.query("q:balances", { x: -1 })).value as number[];
    expect(final.reduce((a, b) => a + b, 0)).toBe(500);
    expect(final.every((b) => b >= 0)).toBe(true);
    expect(moved.some((r) => r.status === "success" && r.value === true)).toBe(true);
    expect(d.workers.counts.answered - answered).toBeGreaterThanOrEqual(160);
  }, 60_000);

  test("a worker's write to a table with a text index is searchable once it commits", async () => {
    const d = await deployment({ workers: 1 });
    const answered = d.workers.counts.answered;
    expect((await d.mutation("q:add", { k: 1, n: 1, body: "hello worker" })).status).toBe("success");
    expect(d.workers.counts.answered).toBe(answered + 1);
    const found = await d.query("q:found", { text: "worker" });
    expect(found.value.map((x: { body: string }) => x.body)).toEqual(["hello worker"]);
  }, 60_000);

  test("the schema refuses a worker's invalid write with the in-thread error", async () => {
    const d = await deployment({ workers: 1 });
    const answered = d.workers.counts.answered;
    const r = await d.mutation("q:invalid");
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain('Failed to insert or update a document in table "counters"');
    expect(d.workers.counts.answered).toBe(answered + 1);
    expect((await d.query("q:count", { k: "bad" })).value).toBe(0);
  }, 60_000);

  test("a commit timestamp runs the mutation again in-thread, which commits it once", async () => {
    const d = await deployment({ workers: 1 });
    const answered = d.workers.counts.answered;
    const r = await d.mutation("q:stamp");
    expect(r.status).toBe("success");
    expect(r.value.at).toBeDefined();
    expect(d.workers.counts.answered).toBe(answered + 1);
    expect((await d.query("q:count", { k: "stamp" })).value).toBe(1);
    expect((await d.query("q:counted")).value).toBe(0);
  }, 60_000);

  test("a WebSocket mutation runs on a worker, and its request resent after a reconnect answers its record", async () => {
    const d = await deployment({ workers: 1 });
    const sessionId = crypto.randomUUID();
    const connect = async (connectionCount: number) => {
      const ws = new WebSocket(`ws://127.0.0.1:${d.s.server.port}/api/1.0.0/sync`);
      const got: v1.ServerMessage[] = [];
      let wake = () => {};
      ws.onmessage = (m) => {
        got.push(v1.parseServerMessage(String(m.data)));
        wake();
      };
      await new Promise((r) => (ws.onopen = r));
      ws.send(
        v1.encodeClientMessage({ type: "Connect", sessionId, connectionCount, lastCloseReason: null, clientTs: 0 }),
      );
      const response = async () => {
        for (;;) {
          const m = got.find((x) => x.type === "MutationResponse");
          if (m) return m as Extract<v1.ServerMessage, { type: "MutationResponse" }>;
          await new Promise<void>((r) => (wake = r));
        }
      };
      return { ws, response };
    };
    const answered = d.workers.counts.answered;
    const first = await connect(0);
    first.ws.send(v1.encodeClientMessage({ type: "Mutation", requestId: 0, udfPath: "q:bump", args: [{ k: "ws" }] }));
    const r1 = await first.response();
    expect(r1).toMatchObject({ success: true, result: 1 });
    expect(d.workers.counts.answered).toBe(answered + 1);
    first.ws.close();
    const second = await connect(1);
    second.ws.send(v1.encodeClientMessage({ type: "Mutation", requestId: 0, udfPath: "q:bump", args: [{ k: "ws" }] }));
    expect(await second.response()).toMatchObject({ success: true, result: 1 });
    second.ws.close();
    expect((await d.query("q:count", { k: "ws" })).value).toBe(1);
  }, 60_000);

  test("a session's request without a permit: a recorded one answers its record, a new one is refused", async () => {
    const d = await deployment({
      workers: 1,
      limits: { APPLICATION_MAX_CONCURRENT_MUTATIONS: "1", APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT: "100" },
    });
    const run = (requestId: number) =>
      d.functions.runSessionMutation("q:bump", { k: "p" }, { sessionId: "s", requestId });
    const answered = d.workers.counts.answered;
    const first = await run(1);
    expect("value" in first && first.value).toBe(1);
    expect(d.workers.counts.answered).toBe(answered + 1);
    const limits = (d.functions as unknown as { limits: { mutation: { acquire(): Promise<() => void> } } }).limits;
    const release = await limits.mutation.acquire();
    const again = run(1);
    const fresh = run(2).catch((e: unknown) => e);
    const replayed = await again;
    expect("replayed" in replayed && JSON.parse(replayed.replayed.result)).toBe(1);
    expect(await fresh).toBeInstanceOf(TooManyConcurrentRequestsError);
    release();
    expect((await d.query("q:count", { k: "p" })).value).toBe(1);
  }, 60_000);
});

// A session mutation's value crosses from the worker as text, where an `undefined` field is no field: a run that returned
// nothing must still read as one that ran (a replayed request is neither logged nor counted, and answers its record).
describe("a WebSocket mutation's value from a worker", () => {
  for (const [path, value] of [
    ["q:silent", undefined],
    ["q:nulled", null],
  ] as const)
    test(`${path} returns ${value}: the run answers it, and is logged and counted`, async () => {
      const d = await deployment({ workers: 1 });
      const answered = d.workers.counts.answered;
      const direct = await d.functions.runSessionMutation(path, { k: "a" }, { sessionId: "s", requestId: 1 });
      expect(d.workers.counts.answered).toBe(answered + 1);
      expect(Object.keys(direct).sort()).toEqual(["ts", "value"]);
      expect("value" in direct && direct.value).toBe(value);

      const ws = new WebSocket(`ws://127.0.0.1:${d.s.server.port}/api/1.0.0/sync`);
      const got: v1.ServerMessage[] = [];
      let wake = () => {};
      ws.onmessage = (m) => {
        got.push(v1.parseServerMessage(String(m.data)));
        wake();
      };
      await new Promise((r) => (ws.onopen = r));
      const sessionId = crypto.randomUUID();
      ws.send(
        v1.encodeClientMessage({ type: "Connect", sessionId, connectionCount: 0, lastCloseReason: null, clientTs: 0 }),
      );
      ws.send(v1.encodeClientMessage({ type: "Mutation", requestId: 0, udfPath: path, args: [{ k: "b" }] }));
      for (;;) {
        if (got.some((x) => x.type === "MutationResponse")) break;
        await new Promise<void>((r) => (wake = r));
      }
      const response = got.find((x) => x.type === "MutationResponse");
      ws.close();
      expect(d.workers.counts.answered).toBe(answered + 2);
      // The protocol's JSON has no undefined: nothing returned is `null` on the wire, as Convex's.
      expect(response).toMatchObject({ success: true, result: null });

      const logged = (await (
        await fetch(`http://127.0.0.1:${d.s.server.port}/api/stream_function_logs?cursor=0`, {
          headers: { authorization: `Bunvex ${KEY}` },
        })
      ).json()) as { entries: { identifier: string; udfType: string; kind: string }[] };
      expect(logged.entries.filter((e) => e.identifier === path).map((e) => [e.udfType, e.kind])).toEqual([
        ["Mutation", "Completion"],
        ["Mutation", "Completion"],
      ]);
      const metrics = await (await fetch(`http://127.0.0.1:${d.s.server.port}/metrics`)).text();
      expect(metrics).toContain('bunvex_udf_executions_total{udf_type="mutation"} 2\n');
    }, 60_000);
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
    // A system error (`isSystemError`): Convex's internal error, as for a terminated isolate.
    expect(r).toEqual({ code: "InternalServerError", message: "Your request couldn't be completed. Try again later." });
    expect(d.workers.counts.died).toBe(1);
    // The next call runs in-thread (none ready) and starts another worker; then calls run on it.
    expect((await d.query("q:counted")).value).toBe(20);
    for (let i = 0; i < 200 && d.workers.ready === 0; i++) await Bun.sleep(10);
    const answered = d.workers.counts.answered;
    expect((await d.query("q:version", { x: 7 })).value).toEqual(["v1", 7]);
    expect(d.workers.counts.answered).toBe(answered + 1);
  }, 60_000);

  test("a worker that dies under a mutation commits nothing, and the mutation fails as a system error", async () => {
    const d = await deployment({ workers: 1 });
    for (let i = 0; i < 20; i++) await d.mutation("q:add", { k: i, n: 0, body: "z" });
    const slow = d.mutation("q:slowAdd", { n: 100000 });
    await Bun.sleep(50);
    const threads = (d.workers as unknown as { threads: { worker: Worker }[] }).threads;
    threads[0]!.worker.terminate();
    expect(await slow).toEqual({
      code: "InternalServerError",
      message: "Your request couldn't be completed. Try again later.",
    });
    expect((await d.query("q:count", { k: "slow" })).value).toBe(0);
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

describe("the differential check's comparison", () => {
  const failed = (fields: Record<string, unknown>): string => {
    const e = Object.assign(new Error("unique() query returned more than one result"), fields);
    const o: CallOutcome = {
      id: 1,
      status: "failed",
      result: null,
      error: encodeCallError(e),
      report: null,
      reads: [],
      searchReads: [],
      identityObserved: false,
      observedTime: false,
      endCursor: null,
      documentsRead: 0,
      bytesRead: 0,
      writes: null,
      creation: 0,
      inThreadOnly: false,
    };
    return encodeCallOutcome(o);
  };
  const at = (line: number, app: string) => ({
    line,
    column: line + 1,
    originalLine: line + 2,
    originalColumn: line + 3,
    sourceURL: "/srv/packages/server/src/functions.ts",
    stack: `Error: x\n    at handler (${app})\n    at run (/srv/packages/server/src/functions.ts:${line}:9)`,
  });

  test("where in the server's code an error was thrown is not the outcome's", () => {
    // Coverage instruments the main thread's modules, not a worker's: the same throw is at other lines.
    expect(outcomeMismatch(failed(at(479, "app.js:12:79")), failed(at(2042, "app.js:12:79")))).toBeNull();
  });

  test("the app's own frames and the error's other fields are", () => {
    expect(outcomeMismatch(failed(at(479, "app.js:12:79")), failed(at(479, "app.js:13:79")))).toStartWith("error: ");
    expect(outcomeMismatch(failed({ code: 1 }), failed({ code: 2 }))).toStartWith("error: ");
  });
});

describe("the connections of a database server's store (STUDY-194 Q6, Q8)", () => {
  test("the main thread keeps a quarter, at least 8; the workers share the rest, at least 2 each, one per core", () => {
    expect(connectionSplit(128, 2, 4)).toEqual({ main: 32, workers: 2, each: 48 });
    expect(connectionSplit(128, 16, 4)).toEqual({ main: 32, workers: 4, each: 24 });
    expect(connectionSplit(16, 8, 8)).toEqual({ main: 8, workers: 4, each: 2 });
    expect(connectionSplit(10, 4, 4)).toEqual({ main: 8, workers: 1, each: 2 });
  });

  test("a pool too small for one worker's 2 stays whole: no worker starts", () => {
    expect(connectionSplit(9, 4, 4)).toBeNull();
    expect(connectionSplit(128, 0, 4)).toBeNull();
  });
});
