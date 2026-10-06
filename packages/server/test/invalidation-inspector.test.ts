// The subscriptions and invalidation inspector (STUDY-131 AD-25, a bunvex addition). `/api/debug/subscriptions`
// shows each live query's read set with its bounds read back to values, and the last invalidations of its
// execution (commit ts, write source, table, the written key decoded, the delay until the new result was
// sent) in a ring of `invalidationHistory` (0: nothing recorded); reruns with no invalidation carry their
// reason. `/api/debug/query_cache` shows the HTTP query cache; `/api/debug/invalidations` follows the
// invalidations. All need an admin key with ViewMetrics.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { debugRoute } from "../src/debug-routes.ts";
import { adminCallerOf, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "7c".repeat(32);
const NAME = "inspector-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup(invalidationHistory?: number) {
  const engine = await new Engine(
    defineSchema({
      messages: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]),
    }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    byAuthor: query(({ db }, { author }: { author: string }) =>
      db
        .query("messages")
        .withIndex("by_author", (q) => q.eq("author", author))
        .collect(),
    ),
    count: query(async ({ db }) => (await db.query("messages").collect()).length),
    send: mutation(({ db }, { author, body }: { author: string; body: string }) =>
      db.insert("messages", { author, body }),
    ),
  });
  const s = createServer({
    engine,
    functions,
    port: 0,
    ...(invalidationHistory === undefined ? {} : { invalidationHistory }),
  });
  stops.push(() => s.stop());
  const api = `http://127.0.0.1:${s.server.port}`;
  const get = async (path: string, key: string | null = KEY) => {
    const r = await fetch(`${api}${path}`, { headers: key ? { authorization: `Bunvex ${key}` } : {} });
    return { status: r.status, body: (await r.json()) as any };
  };
  const client = async () => {
    const c = await v1Client(syncUrl(s.server.port));
    stops.push(() => c.ws.close());
    return c;
  };
  const send = (author: string, body: string) => functions.runMutation("m:send", { author, body });
  return { engine, functions, get, client, send, s };
}

const queriesOf = (body: any) => body.sessions.flatMap((s: any) => s.queries);

test("a live query's read set: the index range read back to its values", async () => {
  const t = await setup();
  await t.send("ana", "hi");
  const c = await t.client();
  c.modify([add(1, "m:byAuthor", { author: "ana" })]);
  await c.transition(0);
  const { status, body } = await t.get("/api/debug/subscriptions");
  expect(status).toBe(200);
  const [q] = queriesOf(body);
  expect(q).toMatchObject({ queryId: 1, path: "m:byAuthor", cached: false, result: "value", documentsRead: 1 });
  expect(q.argsDigest).toMatch(/^[0-9a-f]{12}$/);
  expect(q.bytesRead).toBeGreaterThan(0);
  const range = q.readSet.find((r: any) => r.index === "messages.by_author");
  expect(range.fields).toEqual(["author", "_creationTime", "_id"]);
  expect(range.lo).toMatchObject({ kind: "key", values: ["ana"], after: false });
  expect(range.hi).toMatchObject({ kind: "key", values: ["ana"], after: true });
  expect(range.text).toBe('[["ana"], ["ana", …])');
  // the first run of a key nobody else had: a new subscriber, no invalidation
  expect(q.history).toEqual([{ kind: "rerun", reason: "newSubscriber", at: expect.any(Number) }]);
});

test("a mutation's invalidation: its commit, source, table and key decoded, and the delay until sent", async () => {
  const t = await setup();
  const c = await t.client();
  c.modify([add(1, "m:byAuthor", { author: "ana" })]);
  await c.transition(0);
  // a write outside the range invalidates nothing
  await t.send("bob", "no");
  await t.send("ana", "yes");
  await c.transition(1);
  const ts = t.engine.committer.visibleTs;
  await c.until(() => true);
  const [q] = queriesOf((await t.get("/api/debug/subscriptions")).body);
  const inv = q.history.filter((h: any) => h.kind === "invalidation");
  expect(inv).toHaveLength(1);
  expect(inv[0]).toMatchObject({
    commitTs: Number(ts),
    source: "m:send",
    table: "messages",
    index: "messages.by_author",
  });
  expect(inv[0].key.values[0]).toBe("ana");
  expect(inv[0].key.values).toHaveLength(3); // the author, the _creationTime, the written document's id
  expect(typeof inv[0].key.values[2]).toBe("string");
  expect(inv[0].sentAfterMs).toBeGreaterThanOrEqual(0);
  // the follow feed has it too, after cursor 0
  const feed = (await t.get("/api/debug/invalidations?cursor=0&timeoutMs=0")).body;
  expect(feed.entries.map((e: any) => [e.path, e.source, e.key.values[0]])).toEqual([["m:byAuthor", "m:send", "ana"]]);
  expect(feed.newCursor).toBe(feed.entries[0].seq);
  expect((await t.get(`/api/debug/invalidations?cursor=${feed.newCursor}&timeoutMs=0`)).body.entries).toEqual([]);
});

test("follow: a waiting request returns as soon as an invalidation lands; a path filter", async () => {
  const t = await setup();
  const c = await t.client();
  c.modify([add(1, "m:byAuthor", { author: "ana" }), add(2, "m:count")]);
  await c.transition(0);
  const pending = t.get("/api/debug/invalidations?cursor=0&timeoutMs=5000&path=count");
  await Bun.sleep(20);
  await t.send("zed", "x");
  const got = (await pending).body;
  expect(got.entries.map((e: any) => e.path)).toEqual(["m:count"]);
  const filtered = (await t.get("/api/debug/subscriptions?path=byAuthor")).body;
  expect(queriesOf(filtered).map((q: any) => q.path)).toEqual(["m:byAuthor"]);
});

test("the ring keeps the last N; 0 records nothing", async () => {
  const t = await setup(3);
  const c = await t.client();
  c.modify([add(1, "m:count")]);
  await c.transition(0);
  for (let i = 0; i < 6; i++) {
    await t.send("ana", `m${i}`);
    await c.transition(i + 1);
  }
  const [q] = queriesOf((await t.get("/api/debug/subscriptions")).body);
  expect(q.history).toHaveLength(3);
  const commits = q.history.map((h: any) => h.commitTs);
  expect(commits).toEqual([...commits].sort((a: number, b: number) => b - a)); // newest first
  expect(commits[0]).toBe(Number(t.engine.committer.visibleTs));
  expect((await t.get("/api/debug/subscriptions")).body.historySize).toBe(3);

  const off = await setup(0);
  const d = await off.client();
  d.modify([add(1, "m:count")]);
  await d.transition(0);
  await off.send("ana", "x");
  await d.transition(1);
  const body = (await off.get("/api/debug/subscriptions")).body;
  expect(body.historySize).toBe(0);
  expect(queriesOf(body)[0].history).toEqual([]);
  expect(queriesOf(body)[0].readSet.length).toBeGreaterThan(0); // the read set is still shown
  expect((await off.get("/api/debug/invalidations?cursor=0&timeoutMs=0")).body.entries).toEqual([]);
});

test("a second subscriber reuses the run: cached, and no rerun recorded", async () => {
  const t = await setup();
  const a = await t.client();
  a.modify([add(1, "m:count")]);
  await a.transition(0);
  const b = await t.client();
  b.modify([add(7, "m:count")]);
  await b.transition(0);
  const qs = queriesOf((await t.get("/api/debug/subscriptions")).body);
  expect(qs.map((q: any) => [q.queryId, q.cached]).sort()).toEqual([
    [1, false],
    [7, true],
  ]);
  // one execution key: one history, one new subscriber
  expect(qs[0].history.filter((h: any) => h.kind === "rerun")).toHaveLength(1);
});

test("the query cache: counters, misses by reason, the biggest entries with their read sets", async () => {
  const t = await setup();
  await t.send("ana", "hi");
  await t.functions.runQuery("m:byAuthor", { author: "ana" });
  await t.functions.runQuery("m:byAuthor", { author: "ana" }); // a hit
  await t.send("ana", "again");
  await t.functions.runQuery("m:byAuthor", { author: "ana" }); // invalidated
  const { status, body } = await t.get("/api/debug/query_cache?path=byAuthor");
  expect(status).toBe(200);
  expect(body.hits).toBeGreaterThanOrEqual(1);
  expect(body.missReasons).toMatchObject({ new: 1, invalidated: 1 });
  expect(body.entries).toBeGreaterThanOrEqual(1);
  const [e] = body.biggest;
  expect(e).toMatchObject({ path: "m:byAuthor", state: "ready", shared: true });
  expect(e.readSet.find((r: any) => r.index === "messages.by_author").lo.values).toEqual(["ana"]);
});

test("a miss after an eviction says so", async () => {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { cacheMaxBytes: 900 },
  ).init();
  const q = (n: number) => engine.query(async (db) => (await db.query("items").collect()).length + n, `k${n}`);
  await q(1);
  await q(2);
  await q(3); // pushes k1 out
  await q(1);
  expect(engine.cache.evictions).toBeGreaterThan(0);
  expect(engine.cache.misses.evicted).toBeGreaterThanOrEqual(1);
});

test("refused without an admin key and without ViewMetrics", async () => {
  const t = await setup();
  for (const p of ["subscriptions", "query_cache", "invalidations?cursor=0&timeoutMs=0"]) {
    const anon = await t.get(`/api/debug/${p}`, null);
    expect(anon.status).toBe(403);
    expect((await t.get(`/api/debug/${p}`, READ_ONLY)).status).toBe(200);
  }
  const noMetrics = adminCallerOf(
    { kind: "admin", memberId: 1, readOnly: true, allowedOps: ["ViewData"], issuedS: 0 },
    null,
  );
  const ctx = { engine: t.engine, functions: t.functions, sync: t.s.sync };
  const url = new URL("http://x/api/debug/subscriptions");
  await expect(debugRoute(ctx, url, new Request(url.href), noMetrics)).rejects.toThrow("(deployment:metrics:view)");
});
