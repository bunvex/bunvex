// The deployment's topology (STUDY-131 §11, AD-04 — a bunvex addition). `/api/debug/topology` answers the
// dashboard contract's `Topology` for this process: one leader with its connections, subscriptions, query cache,
// commits per second and a minute of samples, and the store with its driver and lease — read from counters the
// server keeps. What it does not know is null, never made up. Admin only, with ViewMetrics.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, LeaseLostError, type Persistence } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { TOPOLOGY_ROUTE, topologyRoute } from "../src/debug-routes.ts";
import { adminCallerOf, Functions, mutation, query } from "../src/functions.ts";
import { SERVER_VERSION } from "../src/health.ts";
import { createServer } from "../src/server.ts";
import { TOPOLOGY_HISTORY } from "../src/topology.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "5d".repeat(32);
const NAME = "topology-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** A memory store dressed as another driver: its lease scope and name (the engine reads nothing else). */
function dressed(p: Persistence, as: { driver?: string | undefined; leaseScope?: string; renewDelayMs?: number }) {
  Object.defineProperty(p, "driver", { value: as.driver });
  if (as.leaseScope) Object.defineProperty(p, "leaseScope", { value: as.leaseScope });
  if (as.renewDelayMs !== undefined) {
    const lease = p as unknown as { renewLease(): Promise<void> };
    lease.renewLease = () => Bun.sleep(as.renewDelayMs!);
  }
  return p;
}

async function setup(store?: (p: Persistence) => Persistence, lease?: { ttlMs: number }) {
  const persistence = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(
    defineSchema({ messages: defineTable({ body: v.string() }) }),
    store ? store(persistence) : persistence,
    { instanceName: NAME, instanceSecret: SECRET, ...(lease ? { lease } : {}) },
  ).init();
  const functions = new Functions(engine).register("m", {
    list: query(({ db }) => db.query("messages").collect()),
    send: mutation(({ db }, { body }: { body: string }) => db.insert("messages", { body })),
  });
  const s = createServer({ engine, functions, port: 0, onFatal: () => {} });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const get = async (key: string | null = KEY) => {
    const r = await fetch(`${api}${TOPOLOGY_ROUTE}`, { headers: key ? { authorization: `Bunvex ${key}` } : {} });
    return { status: r.status, body: (await r.json()) as any };
  };
  const client = async () => {
    const c = await v1Client(syncUrl(s.server.port));
    stops.push(() => c.ws.close());
    return c;
  };
  const httpQuery = () =>
    fetch(`${api}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:list", args: {}, format: "json" }),
    }).then((r) => r.json());
  return { engine, functions, s, get, client, httpQuery };
}

test("one node on a memory store: the leader alone, its store behind a file lock", async () => {
  const t = await setup();
  const before = Date.now();
  const { status, body } = await t.get();
  expect(status).toBe(200);
  const holder = t.engine.leaseState!.holder;
  expect(body.time).toBeGreaterThanOrEqual(before);
  expect(body.nodes).toHaveLength(1);
  const [n] = body.nodes;
  expect(n).toMatchObject({
    id: holder,
    role: "leader",
    state: "ok",
    version: SERVER_VERSION,
    memoryLimitBytes: null,
    connections: 0,
    subscriptions: 0,
    scheduler: true,
    actionsRunning: 0,
    history: [],
  });
  expect(n.lag).toBeUndefined();
  expect(n.startedAt).toBeLessThanOrEqual(before);
  expect(n.memoryBytes).toBeGreaterThan(0);
  expect(n.cache).toMatchObject({ entries: 0, bytes: 0, maxBytes: t.engine.cache.maxBytes, evictions: 0 });
  expect(n.cache.maxEntries).toBeUndefined(); // the LRU is bounded by bytes, as Convex's
  expect(body.store).toEqual({
    driver: "memory",
    singleNode: true,
    leaseHolder: holder,
    leaseExpiresAt: null,
    leaseTtlMs: null,
    latencyMs: null, // a file lock's renewal never reaches a store
    sizeBytes: null,
    connections: null,
  });
  expect(body.events).toEqual([]);
});

test("a client that connects and subscribes shows on the node, and leaves it again", async () => {
  const t = await setup();
  const c = await t.client();
  c.modify([add(1, "m:list", {})]);
  await c.transition(0);
  const on = (await t.get()).body.nodes[0];
  expect(on.connections).toBe(1);
  expect(on.subscriptions).toBe(1);
  c.ws.close();
  await c.closed;
  for (let i = 0; i < 100 && (await t.get()).body.nodes[0].connections !== 0; i++) await Bun.sleep(10);
  expect((await t.get()).body.nodes[0]).toMatchObject({ connections: 0, subscriptions: 0 });
});

test("samples: commits per second, the cache's hit rate and invalidations, CPU; a minute of history", async () => {
  const t = await setup();
  t.s.topology.sample(); // a window with nothing in it
  let n = (await t.get()).body.nodes[0];
  expect(n.history).toHaveLength(1);
  expect(n.history[0]).toMatchObject({ lagMs: null, connections: 0, cacheHitRate: null, invalidationsPerSecond: 0 });
  expect(n.commitsPerSecond).toBe(0);
  // a miss, a hit, a write into what the cached result read, then a miss found invalidated
  await t.httpQuery();
  await t.httpQuery();
  await t.functions.runMutation("m:send", { body: "hi" });
  await t.httpQuery();
  await Bun.sleep(20);
  t.s.topology.sample();
  n = (await t.get()).body.nodes[0];
  const last = n.history.at(-1);
  expect(last.cacheHitRate).toBeCloseTo(1 / 3, 3);
  expect(last.invalidationsPerSecond).toBeGreaterThan(0);
  expect(n.cache.hitRate).toBe(last.cacheHitRate);
  expect(n.cache.invalidationsPerSecond).toBe(last.invalidationsPerSecond);
  expect(n.commitsPerSecond).toBeGreaterThan(0);
  expect(n.cpu).toBe(last.cpu);
  expect(n.cpu >= 0 && n.cpu <= 1).toBe(true);
  expect(n.cache.entries).toBe(1);
  expect(n.cache.bytes).toBe(t.engine.cache.bytes);
  expect(n.history[0].time).toBeLessThanOrEqual(last.time);
  expect("commitsPerSecond" in last).toBe(false);
  for (let i = 0; i < TOPOLOGY_HISTORY + 3; i++) t.s.topology.sample();
  expect((await t.get()).body.nodes[0].history).toHaveLength(TOPOLOGY_HISTORY);
});

test("a store others could share: the lease, its holder taking it as an event, the renewal's round trip", async () => {
  const t = await setup((p) => dressed(p, { driver: "postgres", leaseScope: "newest", renewDelayMs: 3 }), {
    ttlMs: 60,
  });
  const holder = t.engine.leaseState!.holder;
  for (let i = 0; i < 100 && t.engine.leaseState!.renewalMs === null; i++) await Bun.sleep(10);
  const { body } = await t.get();
  expect(body.store).toMatchObject({
    driver: "postgres",
    singleNode: false,
    leaseHolder: holder,
    leaseExpiresAt: null, // Convex's lease has no expiry (DV-413)
    leaseTtlMs: null,
  });
  expect(body.store.latencyMs).toBeGreaterThanOrEqual(2);
  expect(body.events).toEqual([
    { id: "lease-1", time: t.engine.leaseState!.acquiredAt, kind: "lease_acquired", node: holder },
  ]);
  expect(body.nodes[0].id).toBe(holder);
});

test("a stopped committer: the node is down and holds no lease", async () => {
  const t = await setup((p) => dressed(p, { driver: "mysql", leaseScope: "newest" }));
  t.engine.committer.fail(new LeaseLostError());
  const { body } = await t.get();
  expect(body.nodes[0].state).toBe("down");
  expect(body.store.leaseHolder).toBeNull();
});

test("a driver of another package is `other`", async () => {
  const t = await setup((p) => dressed(p, { driver: undefined }));
  expect((await t.get()).body.store.driver).toBe("other");
});

test("refused without an admin key and without ViewMetrics; a read-only key may look", async () => {
  const t = await setup();
  expect((await t.get(null)).status).toBe(403);
  expect((await t.get(READ_ONLY)).status).toBe(200);
  const noMetrics = adminCallerOf(
    { kind: "admin", memberId: 1, readOnly: true, allowedOps: ["ViewData"], issuedS: 0 },
    null,
  );
  const url = new URL(`http://x${TOPOLOGY_ROUTE}`);
  expect(() =>
    topologyRoute({ functions: t.functions, topology: t.s.topology }, url, new Request(url.href), noMetrics),
  ).toThrow("(deployment:metrics:view)");
  // another method, or another path, is not this route
  const post = new Request(url.href, { method: "POST" });
  expect(topologyRoute({ functions: t.functions, topology: t.s.topology }, url, post, noMetrics)).toBeNull();
});
