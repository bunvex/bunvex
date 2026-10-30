// A session reruns only the queries a commit invalidated (STUDY-184 §5.6 Q4), as Convex's sync worker: its
// `need_fetch` takes the queries whose subscription is gone, and `extend_validity` asks the subscription, which the
// subscription worker keeps current (crates/sync/src/state.rs, crates/sync/src/worker.rs,
// crates/database/src/subscription.rs). The sync hub keeps each watched key's latest execution's validity as commits
// land, so neither a transition nor a reuse scans the write log for a query nothing wrote into.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import type { Execution, SyncHub } from "../src/sync.ts";
import { add, history, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "cd".repeat(32);
const NAME = "rerun-invalidated-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 3 });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** A gate a query run waits on while it is closed: `close()` returns its release. */
function gate() {
  let open: Promise<void> = Promise.resolve();
  return {
    wait: () => open,
    close() {
      const { promise, resolve } = Promise.withResolvers<void>();
      open = promise;
      return () => {
        open = Promise.resolve();
        resolve();
      };
    },
  };
}

async function setup(writeLogRetentionNs?: bigint) {
  const engine = await new Engine(
    defineSchema({ docs: defineTable(v.any()).index("by_g", ["g"]) }),
    await MemoryPersistence.open(null, { durable: false }),
    {
      instanceName: NAME,
      instanceSecret: SECRET,
      ...(writeLogRetentionNs === undefined ? {} : { writeLogRetention: { maxRetentionNs: writeLogRetentionNs } }),
    },
  ).init();
  const held = gate();
  const runs: string[] = [];
  const group = (db: any, g: number) =>
    db
      .query("docs")
      .withIndex("by_g", (q: any) => q.eq("g", g))
      .collect();
  const functions = new Functions(engine).register("m", {
    // The values of group g, and who ran it.
    group: query(async ({ db }, { g }: { g: number }) => {
      runs.push(`group ${g}`);
      return (await group(db, g)).map((d: { n: number }) => d.n);
    }),
    // The same, waiting on the gate after reading.
    held: query(async ({ db }, { g }: { g: number }) => {
      const out = (await group(db, g)).map((d: { n: number }) => d.n);
      runs.push(`held ${g}`);
      await held.wait();
      return out;
    }),
    whoami: query(async ({ auth }) => {
      runs.push("whoami");
      return (await auth.getUserIdentity()) === null ? "nobody" : "someone";
    }),
    page: query(({ db }, { paginationOpts }: { paginationOpts: { numItems: number; cursor: string | null } }) =>
      db
        .query("docs")
        .withIndex("by_g", (q) => q.eq("g", 1))
        .paginate(paginationOpts),
    ),
    put: mutation(({ db }, { g, n }: { g: number; n: number }) => db.insert("docs", { g, n })),
  } as never);
  // A commit listener that runs before the sync hub's: what it sees of validity is what code in the commit's own
  // publication would see.
  const early: ((sync: SyncHub) => void)[] = [];
  engine.committer.onCommit(() => {
    for (const f of early) f(s.sync);
  }, "early");
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const client = async (ts?: bigint) => {
    const c = await v1Client(syncUrl(s.server.port), crypto.randomUUID(), ts);
    stops.push(() => c.ws.close());
    return c;
  };
  const put = (g: number, n: number) => engine.mutation((db) => db.insert("docs", { g, n }));
  // Every check of a result against the write log, counted.
  const committer = engine.committer;
  const scans = { n: 0 };
  for (const name of ["changedBetween", "earliestChange"] as const) {
    if (typeof committer[name] !== "function") continue;
    const f = committer[name].bind(committer) as (...a: unknown[]) => unknown;
    (committer as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
      scans.n++;
      return f(...a);
    };
  }
  return { engine, sync: s.sync, client, put, runs, held, scans, early };
}

const settle = () => Bun.sleep(30);

test("a commit reruns only the queries it wrote into, and no query's result is checked against the write log", async () => {
  const { client, put, runs, scans, sync } = await setup();
  const c = await client();
  c.modify(Array.from({ length: 20 }, (_, g) => add(g, "m:group", { g })));
  await c.transition(0);
  await settle();
  runs.length = 0;
  scans.n = 0;
  const executions = sync.stats.executions;
  await put(3, 30);
  await c.until(() => history(c.transitions(), 3).length === 2);
  await settle();
  expect(history(c.transitions(), 3)).toEqual([[], [30]]);
  // Only group 3 ran, and the other 19 were known valid without a look at the log.
  expect(runs).toEqual(["group 3"]);
  expect(sync.stats.executions - executions).toBe(1);
  // Not even the rerun's own: the hub dropped its stale result from the query cache when it matched the commit
  // (STUDY-08 §7), so the rerun misses at once.
  expect(scans.n).toBe(0);
  // The transition carries group 3 alone.
  const last = c.transitions().at(-1)!;
  expect(last.modifications.map((m) => m.queryId)).toEqual([3]);
});

test("a commit that lands while a query reruns is in the next transition, at once", async () => {
  const { client, put, held, sync } = await setup();
  const c = await client();
  c.modify([add(1, "m:held", { g: 1 })]);
  await c.transition(0);
  const release = held.close();
  const executions = sync.stats.executions;
  await put(1, 10); // the rerun starts, reads [10] and waits
  await c.until(() => sync.stats.executions > executions);
  await put(1, 11); // lands during the rerun, into what it read
  release();
  await c.until(() => history(c.transitions(), 1).length === 3);
  expect(history(c.transitions(), 1)).toEqual([[], [10], [10, 11]]);
  const ts = c.transitions().map((t) => t.endVersion.ts);
  expect([...ts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ts);
});

test("sessions sharing a query: each gets the new result once, and one run serves both", async () => {
  const { client, put, sync, runs } = await setup();
  const [a, b] = [await client(), await client()];
  a.modify([add(1, "m:group", { g: 5 })]);
  b.modify([add(7, "m:group", { g: 5 })]);
  await Promise.all([a.transition(0), b.transition(0)]);
  await settle();
  runs.length = 0;
  const executions = sync.stats.executions;
  await put(5, 1);
  await a.until(() => history(a.transitions(), 1).length === 2);
  await b.until(() => history(b.transitions(), 7).length === 2);
  await put(5, 2);
  await a.until(() => history(a.transitions(), 1).length === 3);
  await b.until(() => history(b.transitions(), 7).length === 3);
  await settle();
  expect(history(a.transitions(), 1)).toEqual([[], [1], [1, 2]]);
  expect(history(b.transitions(), 7)).toEqual([[], [1], [1, 2]]);
  expect(sync.stats.executions - executions).toBe(2);
  expect(runs).toEqual(["group 5", "group 5"]);
});

test("a subscriber that arrives later reuses a result still valid, and reruns one a commit invalidated", async () => {
  const { client, put, sync } = await setup();
  const a = await client();
  a.modify([add(1, "m:group", { g: 2 })]);
  await a.transition(0);
  await put(9, 1); // writes elsewhere
  let executions = sync.stats.executions;
  const b = await client();
  b.modify([add(1, "m:group", { g: 2 })]);
  await b.transition(0);
  expect(sync.stats.executions - executions).toBe(0);
  // Invalidate it, and subscribe a third before the first two have rerun it.
  await put(2, 4);
  const c = await client();
  c.modify([add(1, "m:group", { g: 2 })]);
  await c.until(() => history(c.transitions(), 1).length === 1);
  expect(history(c.transitions(), 1)).toEqual([[4]]);
  await a.until(() => history(a.transitions(), 1).length === 2);
  await b.until(() => history(b.transitions(), 1).length === 2);
  executions = sync.stats.executions;
  await settle();
  expect(sync.stats.executions - executions).toBe(0);
});

test("a query added mid-session runs alone; the others are not rerun", async () => {
  const { client, put, runs } = await setup();
  const c = await client();
  c.modify([add(1, "m:group", { g: 1 }), add(2, "m:group", { g: 2 })]);
  await c.transition(0);
  await put(1, 1);
  await c.until(() => history(c.transitions(), 1).length === 2);
  await settle();
  runs.length = 0;
  c.modify([add(3, "m:group", { g: 3 })]);
  await c.until(() => history(c.transitions(), 3).length === 1);
  await settle();
  expect(runs).toEqual(["group 3"]);
  expect(
    c
      .transitions()
      .at(-1)!
      .modifications.map((m) => m.queryId),
  ).toEqual([3]);
});

test("a session reconnecting at a ts it observed gets its results at that ts or later", async () => {
  const { client, put } = await setup();
  const a = await client();
  a.modify([add(1, "m:group", { g: 1 })]);
  await a.transition(0);
  await put(1, 1);
  const t = await a.until(() => a.transitions().find((x) => history([x], 1).length > 0 && x !== a.transitions()[0]));
  const b = await client(t.endVersion.ts);
  b.modify([add(1, "m:group", { g: 1 })]);
  const first = await b.until(() => b.transitions().find((x) => x.modifications.length > 0));
  expect(first.endVersion.ts >= t.endVersion.ts).toBe(true);
  expect(history([first], 1)).toEqual([[1]]);
});

test("an identity change reruns every query of the session; one that read no identity reuses its shared result", async () => {
  const { client, runs } = await setup();
  const c = await client();
  c.modify([add(1, "m:whoami"), add(2, "m:group", { g: 1 })]);
  await c.transition(0);
  await settle();
  runs.length = 0;
  c.send({ type: "Authenticate", tokenType: "Admin", value: KEY, baseVersion: 0 });
  await c.until(() => c.transitions().length >= 2);
  await settle();
  // Both were asked again (`identityChange`); only the one that read the identity ran.
  expect(runs).toEqual(["whoami"]);
  // An admin has no user identity: the same result, so no modification is sent (Convex's `same_result`).
  expect(history(c.transitions(), 1)).toEqual(["nobody"]);
});

test("a paginated query reruns when a row lands in its page, and not for a row elsewhere", async () => {
  const { client, put, sync } = await setup();
  await put(1, 1);
  const c = await client();
  c.modify([add(1, "m:page", { paginationOpts: { numItems: 5, cursor: null } }), add(2, "m:group", { g: 9 })]);
  await c.transition(0);
  await put(1, 2);
  const next = await c.until(() => c.transitions().find((t, i) => i > 0 && t.modifications.length > 0));
  const page = (m: v1.StateModification) =>
    (m as unknown as { value: { page: { n: number }[] } }).value.page.map((d) => d.n);
  expect(page(next.modifications.find((m) => m.queryId === 1)!)).toEqual([1, 2]);
  expect(next.modifications.map((m) => m.queryId)).toEqual([1]);
  await settle();
  const executions = sync.stats.executions;
  await put(9, 3);
  await c.until(() => history(c.transitions(), 2).length === 2);
  await settle();
  expect(
    c
      .transitions()
      .at(-1)!
      .modifications.map((m) => m.queryId),
  ).toEqual([2]);
  expect(sync.stats.executions - executions).toBe(1);
  // Its page grows again with the next row of its group: its journal's key is tracked too.
  await put(1, 4);
  await c.until(() => history(c.transitions(), 1).length === 3);
  expect(
    page(
      c
        .transitions()
        .at(-1)!
        .modifications.find((m) => m.queryId === 1)!,
    ),
  ).toEqual([1, 2, 4]);
});

test("a subscription nothing wrote into stays valid after the write log no longer reaches its ts", async () => {
  // A 1 ms write log: Convex's subscription worker keeps a subscription's validity current as it reads the log,
  // so a query's result does not age out; only what nobody tracked would need the log.
  const { client, put, runs } = await setup(1_000_000n);
  const c = await client();
  c.modify([add(1, "m:group", { g: 1 }), add(2, "m:group", { g: 2 })]);
  await c.transition(0);
  await settle();
  for (let i = 0; i < 3; i++) {
    await put(9, i);
    await Bun.sleep(3);
  }
  runs.length = 0;
  await put(2, 1);
  await c.until(() => history(c.transitions(), 2).length === 2);
  await settle();
  expect(runs).toEqual(["group 2"]);
  expect(history(c.transitions(), 1)).toEqual([[]]);
});

test("validity: a result no longer tracked is checked against the log once, and a commit not yet matched is seen", async () => {
  const { client, put, sync, engine, early } = await setup();
  const c = await client();
  c.modify([add(1, "m:group", { g: 1 })]);
  await c.transition(0);
  const tracked = [...(sync as unknown as { latest: Map<string, Execution> }).latest.values()][0]!;
  // The same run, as an execution no key tracks (a session's result that another run replaced).
  const untracked: Execution = { ...tracked, validity: undefined };
  await put(9, 1);
  const t1 = engine.committer.visibleTs;
  expect(sync.validAt(untracked, t1)).toBe(true);
  expect(untracked.validity).toMatchObject({ invalidAt: null, validThrough: t1 });
  await put(1, 2);
  const t2 = engine.committer.visibleTs;
  expect(sync.validAt(untracked, t2)).toBe(false);
  expect(untracked.validity?.invalidAt).toBe(t2);
  expect(sync.validAt(untracked, t1)).toBe(true); // still valid before the commit that changed it
  // A listener before the hub's, during the publication of a commit into the tracked result's reads: the hub has
  // not matched it yet, and the write log says so.
  await c.until(() => history(c.transitions(), 1).length === 2);
  const latest = [...(sync as unknown as { latest: Map<string, Execution> }).latest.values()][0]!;
  const seen: boolean[] = [];
  early.push((hub) => seen.push(hub.validAt(latest, engine.committer.visibleTs)));
  await put(9, 4); // elsewhere: still valid, known from the log
  await put(1, 3); // into its reads
  expect(seen).toEqual([true, false]);
  expect(latest.validity?.invalidAt).not.toBeNull();
});
