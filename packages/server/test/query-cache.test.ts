// The query cache over HTTP (STUDY-08 D8, DV-63): identical concurrent requests run the query once, and
// identities stay apart while they do (B13).
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { startIssuer } from "./issuer.ts";

const stops: (() => void)[] = [];
/** What `m:list` waits for before answering: a test holds it so that concurrent requests overlap. */
let hold: Promise<void> = Promise.resolve();
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup() {
  const issuer = await startIssuer();
  stops.push(issuer.stop);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_tag", ["tag"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await engine.indexesReady(); // enabling an index empties the cache
  const runs = { list: 0, whoami: 0, boom: 0 };
  const functions = new Functions(engine).register("m", {
    list: query(async ({ db }, { tag }: { tag: string }) => {
      runs.list++;
      console.log(`listing ${tag}`);
      await hold;
      return db
        .query("items")
        .withIndex("by_tag", (q) => q.eq("tag", tag))
        .collect();
    }),
    whoami: query(async ({ auth }) => {
      runs.whoami++;
      await hold;
      return (await auth.getUserIdentity())?.subject ?? null;
    }),
    boom: query(async () => {
      runs.boom++;
      throw new Error("boom");
    }),
    add: mutation(async ({ db }, { tag }: { tag: string }) => db.insert("items", { tag })),
  });
  const { server, stop } = createServer({
    engine,
    functions,
    port: 0,
    redactLogsToClient: false,
    auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
  });
  stops.push(stop);
  const call = async (kind: string, path: string, args: unknown = {}, token?: string, ts?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`http://127.0.0.1:${server.port}/api/${kind}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path, args, ts }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { issuer, engine, runs, call };
}

describe("the HTTP query cache", () => {
  test("64 concurrent identical queries run once; every response carries the result and its log lines", async () => {
    const { engine, runs, call } = await setup();
    await call("mutation", "m:add", { tag: "a" });
    const misses = engine.stats.cacheMisses;
    hold = new Promise((r) => setTimeout(r, 200)); // the first run lasts until every request has arrived
    const rs = await Promise.all(Array.from({ length: 64 }, () => call("query", "m:list", { tag: "a" })));
    hold = Promise.resolve();
    expect(runs.list).toBe(1);
    expect(engine.stats.cacheMisses - misses).toBe(1);
    for (const r of rs) {
      expect(r.status).toBe(200);
      expect((r.body.value as unknown[]).length).toBe(1);
      expect(r.body.logLines).toEqual(["[LOG] 'listing a'"]);
    }
  });

  test("different arguments run apart", async () => {
    const { runs, call } = await setup();
    hold = new Promise((r) => setTimeout(r, 100));
    await Promise.all(["a", "b", "a", "b", "c"].map((tag) => call("query", "m:list", { tag })));
    hold = Promise.resolve();
    expect(runs.list).toBe(3);
  });

  test("concurrent callers of a query that reads the identity each get their own answer (B13)", async () => {
    const { issuer, runs, call } = await setup();
    const tokens = { ada: await issuer.sign({ sub: "ada" }), bob: await issuer.sign({ sub: "bob" }) };
    const who = ["ada", "bob", "ada", "bob", "ada", "bob"] as const;
    hold = new Promise((r) => setTimeout(r, 100));
    const rs = await Promise.all(who.map((u) => call("query", "m:whoami", {}, tokens[u])));
    hold = Promise.resolve();
    expect(rs.map((r) => r.body.value)).toEqual([...who]);
    expect(runs.whoami).toBe(2);
    expect((await call("query", "m:whoami")).body.value).toBe(null);
  });

  test("a query that throws: every caller gets the error, and nothing is cached", async () => {
    const { engine, runs, call } = await setup();
    const rs = await Promise.all(Array.from({ length: 8 }, () => call("query", "m:boom")));
    for (const r of rs) expect(String(r.body.errorMessage)).toContain("boom");
    expect(runs.boom).toBe(8); // as Convex: the waiters of a failed run plan again, one at a time
    expect(engine.cache.size).toBe(0);
  });

  test("a write into the read-set is seen by the next request; a write elsewhere is served from cache", async () => {
    const { runs, call } = await setup();
    await call("query", "m:list", { tag: "a" });
    await call("mutation", "m:add", { tag: "b" });
    await call("query", "m:list", { tag: "a" });
    expect(runs.list).toBe(1);
    await call("mutation", "m:add", { tag: "a" });
    expect(((await call("query", "m:list", { tag: "a" })).body.value as unknown[]).length).toBe(1);
    expect(runs.list).toBe(2);
  });

  test("query_at_ts is answered from the cache when the cached result is valid at that ts", async () => {
    const { runs, call } = await setup();
    await call("query", "m:list", { tag: "a" });
    await call("mutation", "m:add", { tag: "b" });
    const ts = (await call("query_ts", "")).body.ts as string;
    expect(v1.decodeU64(ts)).toBeGreaterThan(0n);
    const r = await call("query_at_ts", "m:list", { tag: "a" }, undefined, ts);
    expect(r.body.value).toEqual([]);
    expect(runs.list).toBe(1);
  });
});
