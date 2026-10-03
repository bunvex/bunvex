// Splaying of wide invalidations (STUDY-08 §3.5, DV-64), as Convex's `advance_log`: when one commit invalidates
// more than 200 subscriptions (session queries), each is notified after a uniform random delay in
// [0, count × 5 ms]. Sessions run in process (no sockets) on a fake clock and a seeded random.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { type SplayOptions, type SplayTimers, SyncSession, splayOptions } from "../src/sync.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A clock that only moves when told to; timers fire in due order. */
class FakeTimers implements SplayTimers {
  t = 0;
  private seq = 0;
  readonly pending = new Map<number, { due: number; fn: () => void }>();
  now() {
    return this.t;
  }
  set(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.pending.set(id, { due: this.t + ms, fn });
    return id;
  }
  clear(h: unknown) {
    this.pending.delete(h as number);
  }
  /** Fire every timer due at the earliest due time; returns that time, or null when none is pending. */
  fireNext(): number | null {
    let due = Number.POSITIVE_INFINITY;
    for (const p of this.pending.values()) due = Math.min(due, p.due);
    if (due === Number.POSITIVE_INFINITY) return null;
    this.t = due;
    for (const [id, p] of [...this.pending]) {
      if (p.due !== due) continue;
      this.pending.delete(id);
      p.fn();
    }
    return due;
  }
  dues() {
    return [...this.pending.values()].map((p) => p.due);
  }
}

/** xorshift32 in [0, 1): a deterministic stand-in for the CSPRNG. */
function seeded(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
}

async function until(f: () => boolean, what: string) {
  for (let i = 0; i < 1000; i++) {
    if (f()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Frame = { at: number; m: v1.ServerMessage };

/** `gated` waits on this; `close()` lets it finish. Open by default. */
const gate = {
  wait: Promise.resolve(),
  close() {
    let open!: () => void;
    this.wait = new Promise<void>((r) => (open = r));
    return () => {
      this.wait = Promise.resolve();
      open();
    };
  },
};

async function setup(splay: Partial<SplayOptions> = {}) {
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()), b: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    count: query(async ({ db }, { table }: { table: "a" | "b" }) => (await db.query(table).collect()).length),
    // A second key over the same table: one write invalidates both.
    countAgain: query(async ({ db }) => (await db.query("a").collect()).length),
    insert: mutation(({ db }, { table }: { table: "a" | "b" }) => db.insert(table, {})),
    // Holds its run open until the test releases it.
    gated: query(async ({ db }) => {
      const n = (await db.query("a").collect()).length;
      await gate.wait;
      return n;
    }),
  });
  const timers = new FakeTimers();
  const { sync, stop } = createServer({
    engine,
    functions,
    port: 0,
    subscriptionSplay: { random: seeded(42), timers, ...splay },
  });
  stops.push(stop);

  type Client = { s: SyncSession; frames: Frame[]; transitions: () => Frame[] };
  /** `n` sessions, each subscribed to `queries`; resolves once each has its first transition. */
  const open = async (n: number, queries: { udfPath: string; args?: Record<string, unknown> }[]) => {
    const out: Client[] = [];
    for (let i = 0; i < n; i++) {
      const s = new SyncSession(sync);
      const frames: Frame[] = [];
      s.open({
        send: (f: string) => frames.push({ at: timers.now(), m: v1.parseServerMessage(f) }),
        getBufferedAmount: () => 0,
        close() {},
      } as never);
      s.message(
        v1.encodeClientMessage({
          type: "Connect",
          sessionId: crypto.randomUUID(),
          connectionCount: 0,
          lastCloseReason: null,
          clientTs: 0,
        }),
      );
      s.message(
        v1.encodeClientMessage({
          type: "ModifyQuerySet",
          baseVersion: 0,
          newVersion: 1,
          modifications: queries.map((q, j) => ({
            type: "Add" as const,
            queryId: j,
            udfPath: q.udfPath,
            args: [(q.args ?? {}) as v1.JSONValue],
          })),
        }),
      );
      out.push({ s, frames, transitions: () => frames.filter((f) => f.m.type === "Transition") });
    }
    await until(() => out.every((c) => c.transitions().length === 1), "the first transitions");
    return out;
  };
  const insert = (table: "a" | "b" = "a") => functions.runMutation("m:insert", { table });
  /** Fire the timers one due time at a time, letting each woken session send its transition. */
  const drain = async (clients: Client[], expected: number) => {
    const sent = () => clients.reduce((k, c) => k + c.transitions().length, 0);
    const base = sent();
    let woken = 0;
    for (;;) {
      const before = timers.pending.size;
      if (timers.fireNext() === null) break;
      woken += before - timers.pending.size;
      await until(() => sent() >= base + woken, `the transitions woken at ${timers.t} ms`);
    }
    expect(sent() - base).toBe(expected);
  };
  return { sync, timers, open, insert, drain };
}

async function waitForSecond<C extends { transitions: () => Frame[] }>(cs: C[]) {
  await until(() => cs.some((c) => c.transitions().length >= 2), "a second transition");
  return cs.find((c) => c.transitions().length >= 2) as C;
}

const value = (t: Frame) =>
  (t.m as v1.Transition).modifications.flatMap((m) => (m.type === "QueryUpdated" ? [m.value] : []));

describe("splaying wide invalidations (STUDY-08 §3.5)", () => {
  test("up to the threshold (200 subscriptions) nothing is delayed", async () => {
    const { timers, open, insert, sync } = await setup();
    const clients = await open(200, [{ udfPath: "m:count", args: { table: "a" } }]);
    await insert();
    expect(timers.pending.size).toBe(0);
    await until(() => clients.every((c) => c.transitions().length === 2), "every transition at once");
    expect(clients.every((c) => c.transitions()[1].at === 0 && value(c.transitions()[1])[0] === 1)).toBe(true);
    expect(sync.stats.splayed).toBe(0);
  });

  test("above it every invalidated session still gets its transition, each within count × 5 ms, spread out", async () => {
    const { timers, open, insert, drain, sync } = await setup();
    const clients = await open(201, [{ udfPath: "m:count", args: { table: "a" } }]);
    await insert();
    // One delayed notification per session; none has its transition yet.
    expect(timers.pending.size).toBe(201);
    expect(sync.stats.splayed).toBe(201);
    await Bun.sleep(5);
    expect(clients.every((c) => c.transitions().length === 1)).toBe(true);
    const bound = 201 * 5;
    expect(timers.dues().every((d) => d >= 0 && d <= bound)).toBe(true);

    await drain(clients, 201);
    const at = clients.map((c) => c.transitions()[1].at);
    expect(clients.every((c) => value(c.transitions()[1])[0] === 1)).toBe(true);
    expect(Math.max(...at)).toBeLessThanOrEqual(bound);
    // Spread over the window, not all at once: many distinct times, reaching its upper half.
    expect(new Set(at).size).toBeGreaterThan(100);
    expect(Math.max(...at)).toBeGreaterThan(bound / 2);
    expect(at.filter((t) => t === 0).length).toBeLessThan(5);
  });

  test("the count is of subscriptions (session queries), not sessions or keys: 67 sessions × 3 queries are splayed", async () => {
    const { timers, open, insert, drain } = await setup();
    // Two queries on the same key and one on another key, per session: 67 sessions, 134 (session, key)
    // pairs, but 201 subscriptions, as Convex counts them (one per session query).
    const queries = [{ udfPath: "m:count", args: { table: "a" } }, { udfPath: "m:countAgain" }];
    const clients = await open(67, [queries[0], queries[0], queries[1]]);
    await insert();
    // A session wakes once, at the earliest of its queries' delays.
    expect(timers.pending.size).toBe(67);
    expect(timers.dues().every((d) => d <= 201 * 5)).toBe(true);
    await drain(clients, 67);
    expect(clients.every((c) => value(c.transitions()[1]).join() === "1,1,1")).toBe(true);
  });

  test("a session's own mutation is not delayed: its covering transition follows at once, and only once", async () => {
    const { timers, open, drain } = await setup();
    const clients = await open(201, [{ udfPath: "m:count", args: { table: "a" } }]);
    const [me, ...others] = clients;
    me.s.message(
      v1.encodeClientMessage({ type: "Mutation", requestId: 0, udfPath: "m:insert", args: [{ table: "a" }] }),
    );
    // The commit is splayed for everyone (201 > 200), the mutating session included…
    await until(() => me.frames.some((f) => f.m.type === "MutationResponse"), "the mutation's response");
    // …but the transition that follows its mutation runs at once, at the fake clock's 0, and covers the write.
    await until(() => me.transitions().length === 2, "the mutating session's transition");
    const res = me.frames.find((f) => f.m.type === "MutationResponse")!.m as v1.MutationResponse;
    const t = me.transitions()[1];
    expect(t.at).toBe(0);
    expect((t.m as v1.Transition).endVersion.ts >= (res.success ? res.ts : 0n)).toBe(true);
    expect(value(t)[0]).toBe(1);
    expect(others.every((c) => c.transitions().length === 1)).toBe(true);
    // Its pending delayed notification was dropped: it gets no second, empty transition.
    expect(timers.pending.size).toBe(200);
    await drain(clients, 200);
    expect(me.transitions().length).toBe(2);
  });

  test("closing a session while its notification is pending leaves no timer and sends nothing", async () => {
    const { timers, open, insert, drain, sync } = await setup();
    const clients = await open(201, [{ udfPath: "m:count", args: { table: "a" } }]);
    await insert();
    expect(timers.pending.size).toBe(201);
    const closing = clients.slice(0, 50);
    for (const c of closing) c.s.close();
    expect(timers.pending.size).toBe(151);
    expect(sync.sessions.size).toBe(151);
    await drain(clients, 151);
    expect(closing.every((c) => c.transitions().length === 1)).toBe(true);
    expect(timers.pending.size).toBe(0);
  });

  test("a query whose notification is pending is not counted again by the next commit", async () => {
    const { timers, open, insert, drain, sync } = await setup();
    const clients = await open(201, [{ udfPath: "m:count", args: { table: "a" } }]);
    await insert();
    const dues = timers.dues().sort();
    await insert();
    expect(sync.stats.splayed).toBe(201);
    expect(timers.dues().sort()).toEqual(dues);
    // One transition each, covering both writes.
    await drain(clients, 201);
    expect(clients.every((c) => value(c.transitions()[1])[0] === 2)).toBe(true);
  });

  test("a commit below the threshold during a pending splay still notifies its other sessions at once", async () => {
    const { timers, open, insert, drain } = await setup();
    const wide = await open(201, [{ udfPath: "m:count", args: { table: "a" } }]);
    const narrow = await open(3, [{ udfPath: "m:count", args: { table: "b" } }]);
    await insert("a");
    await insert("b");
    await until(() => narrow.every((c) => c.transitions().length === 2), "the narrow sessions' transitions");
    expect(narrow.every((c) => c.transitions()[1].at === 0)).toBe(true);
    expect(timers.pending.size).toBe(201);
    await drain(wide, 201);
  });

  test("a commit during a transition into a query it reran is not splayed: a new subscription is invalid at once", async () => {
    const { timers, open, insert, drain, sync } = await setup({ threshold: 0 });
    const [a, b] = await open(2, [{ udfPath: "m:gated" }]);
    await insert(); // splayed: both sessions wait for their timers
    expect(timers.pending.size).toBe(2);
    const release = gate.close();
    const runsBefore = sync.stats.executions;
    // Wake the first session: its transition reruns the query, which reads at the commit's ts and waits.
    timers.fireNext();
    await until(() => sync.stats.executions > runsBefore, "the rerun to start");
    // A second commit lands while the rerun is held: the session is subscribed to it again, so it is
    // counted and splayed (the other session's query is still pending and is not)…
    await insert();
    expect(timers.pending.size).toBe(2);
    release();
    const woken = [a, b].find((c) => c.transitions().length === 2) ?? (await waitForSecond([a, b]));
    // …but its result is already stale, so the next transition follows at once, with the second write.
    await until(() => woken.transitions().length === 3, "the follow-up transition");
    expect(value(woken.transitions()[1])).toEqual([1]);
    expect(value(woken.transitions()[2])).toEqual([2]);
    expect(timers.pending.size).toBe(1);
    await drain([a, b], 1);
  });

  test("settings: Convex's knob names in the environment, options over them, Convex's defaults", () => {
    expect(splayOptions({}, {})).toMatchObject({ threshold: 200, multiplierMs: 5 });
    expect(
      splayOptions(
        {},
        { SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD: "10", SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER: "2" },
      ),
    ).toMatchObject({ threshold: 10, multiplierMs: 2 });
    expect(splayOptions({ threshold: 3 }, { SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD: "10" }).threshold).toBe(3);
    expect(() => splayOptions({}, { SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER: "-1" })).toThrow(
      "SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER",
    );
    const r = splayOptions().random;
    for (let i = 0; i < 2000; i++) {
      const x = r();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  test("each subscription draws its own delay, uniform over 0..=window; the session wakes at the earliest", async () => {
    const draws = [0.95, 0.25];
    const { timers, open, insert, drain } = await setup({ threshold: 1, random: () => draws.shift() ?? 0.5 });
    const clients = await open(1, [
      { udfPath: "m:count", args: { table: "a" } },
      { udfPath: "m:count", args: { table: "a" } },
    ]);
    await insert();
    // Window 2 × 5 = 10 ms: floor(0.95 × 11) = 10 and floor(0.25 × 11) = 2.
    expect(timers.dues()).toEqual([2]);
    await drain(clients, 1);

    // The window's end is included, as `random_range(0..=splay_amt_millis)`.
    const top = await setup({ threshold: 0, random: () => 0.9999 });
    const [one] = await top.open(1, [{ udfPath: "m:count", args: { table: "a" } }]);
    await top.insert();
    expect(top.timers.dues()).toEqual([5]);
    await top.drain([one], 1);
  });

  test("a lower threshold from the options applies", async () => {
    const { timers, open, insert, drain } = await setup({ threshold: 2, multiplierMs: 10 });
    const clients = await open(3, [{ udfPath: "m:count", args: { table: "a" } }]);
    await insert();
    expect(timers.pending.size).toBe(3);
    expect(timers.dues().every((d) => d <= 30)).toBe(true);
    await drain(clients, 3);
  });
});
