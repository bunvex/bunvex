// The subscriptions inspector over the admin routes (STUDY-131 AD-25, STUDY-149's follow-up): the snapshots mapped
// to the contract, and the follow loop on `/api/debug/invalidations` — from now on, its cursor, abort, back-off and
// reported failures, a refusal that stops it, catching up after a failure or a server restart, and no request while
// the deployment is disconnected.
import { describe, expect, test } from "bun:test";
import type { ConnectionStatus, DataSourceError, InvalidationEvent, Json } from "@bunvex/dashboard/data-source";
import { AdminHttp } from "../src/admin-http.ts";
import { Inspector, queryCacheOf, subscriptionsOf } from "../src/inspector.ts";

const URL_BASE = "http://127.0.0.1:3210";

const keyBound = (values: Json[], after = false) => ({
  kind: "key" as const,
  values,
  after,
  text: `[${values.map((v) => JSON.stringify(v)).join(", ")}${after ? ", …" : ""}]`,
});

/** An invalidation as the server's feed sends it. */
const feedEntry = (seq: number, path = "messages:list") => ({
  kind: "invalidation" as const,
  seq,
  at: 1_700_000_000_000 + seq,
  commitTs: 1000 + seq,
  source: "messages:send",
  table: "messages",
  index: "messages.by_creation_time",
  key: keyBound([1_700_000_000_000 + seq, `id${seq}`]),
  sentAfterMs: 0.5,
  path,
  argsDigest: "0123456789ab",
});

/**
 * The server's follow feed, as `SyncInspector.after` answers: entries after `cursor` at once, or a wait up to
 * `timeoutMs` for the next; `newCursor` the last entry's `seq` (the path filter applied after), else the cursor.
 */
class FakeFeed {
  seq = 0;
  entries: ReturnType<typeof feedEntry>[] = [];
  /** Every request's path and query, in order. */
  readonly asked: string[] = [];
  /** Requests aborted while waiting. */
  aborted = 0;
  /** Answers given instead of the feed's, first in first out. */
  readonly failures: (() => Response | Promise<Response>)[] = [];
  private waiters = new Set<() => void>();
  readonly http: AdminHttp;

  constructor() {
    this.http = new AdminHttp({ url: URL_BASE, adminKey: "local|k", fetch: (u, init) => this.fetch(u, init) });
  }

  push(path = "messages:list") {
    this.seq++;
    this.entries.push(feedEntry(this.seq, path));
    for (const w of [...this.waiters]) w();
  }

  /** A new server: its feed starts again at 1. */
  restart() {
    this.seq = 0;
    this.entries = [];
  }

  /** Requests waiting on the server now. */
  get waiting() {
    return this.waiters.size;
  }

  private async fetch(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input);
    this.asked.push(`${url.pathname}${url.search}`);
    // a network round trip is a task, never a microtask: a loop that spins still lets timers run
    await new Promise((r) => setTimeout(r, 0));
    const failure = this.failures.shift();
    if (failure) return failure();
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? 60_000);
    const path = url.searchParams.get("path");
    const signal = init?.signal ?? undefined;
    let found = this.entries.filter((e) => e.seq > cursor);
    if (found.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        this.waiters.add(done);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          this.aborted++;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      found = this.entries.filter((e) => e.seq > cursor);
    }
    const newCursor = found.at(-1)?.seq ?? cursor;
    return Response.json({ entries: found.filter((e) => !path || e.path.includes(path)), newCursor });
  }
}

/** One later task: every timer already due runs first (the fake feed's round trip is one such task). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Waits for `f`, a task at a time. The bound counts tasks, not milliseconds: a loaded machine runs them slower,
 * never fewer, so it only ends a test that would wait forever.
 */
async function until<T>(f: () => T | undefined | false, what: string, tasks = 5000): Promise<T> {
  for (let i = 0; i < tasks; i++) {
    const x = f();
    if (x) return x;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Lets the loop run as far as it goes (it asks nothing more after this many round trips), for a "nothing happens". */
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

/**
 * The loop's timers, driven by the test: a 0 ms one (the first tick) runs on a later task, as `setTimeout`'s; the
 * others (the back-offs) only when `fire` says, so no back-off ever ends on the clock.
 */
function manualTimers() {
  const pending = new Set<{ fn: () => void; ms: number }>();
  const after = (fn: () => void, ms: number) => {
    if (ms === 0) {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    }
    const timer = { fn, ms };
    pending.add(timer);
    return () => void pending.delete(timer);
  };
  return {
    after,
    /** The waits scheduled and not ended, in ms. */
    pending: () => [...pending].map((t) => t.ms),
    /** Ends every wait scheduled. */
    fire() {
      for (const t of [...pending]) {
        pending.delete(t);
        t.fn();
      }
    },
  };
}

/** A promise the test resolves. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

/** A watcher's deliveries and errors. */
function follower() {
  const events: InvalidationEvent[] = [];
  const errors: DataSourceError[] = [];
  return {
    events,
    errors,
    onEvents: (e: InvalidationEvent[]) => events.push(...e),
    onError: (e: DataSourceError) => errors.push(e),
    seqs: () => events.map((e) => e.seq),
  };
}

describe("the snapshots", () => {
  test("subscriptions: the server's shape mapped to the contract's (its `validAt` left out), the path filter sent", async () => {
    const server = {
      ts: 42,
      historySize: 8,
      sessions: [
        {
          sessionId: "s1",
          identity: "user",
          queries: [
            {
              queryId: 0,
              path: "messages:list",
              argsDigest: "0123456789ab",
              ts: 41,
              validAt: 42,
              cached: false,
              lastRunAt: 1_700_000_000_000,
              result: "value",
              documentsRead: 3,
              bytesRead: 120,
              readSet: [
                {
                  index: "messages.by_author",
                  fields: ["author", "_creationTime", "_id"],
                  lo: keyBound(["ana"]),
                  hi: keyBound(["ana"], true),
                  text: '[["ana"], ["ana", …])',
                },
                {
                  index: "messages.by_id",
                  fields: ["_id"],
                  lo: { kind: "min", text: "-∞" },
                  hi: { kind: "raw", hex: "ff00", text: "0xff00" },
                  text: "[-∞, 0xff00)",
                },
              ],
              history: [
                { ...feedEntry(7), path: undefined, argsDigest: undefined },
                { kind: "rerun", reason: "newSubscriber", at: 1_700_000_000_000 },
              ],
            },
          ],
        },
      ],
      totals: { sessions: 2, queries: 1 },
    };
    let asked = "";
    let headers: unknown;
    const http = new AdminHttp({
      url: URL_BASE,
      adminKey: "local|k",
      fetch: async (u, init) => {
        asked = u;
        headers = init?.headers;
        return Response.json(server);
      },
    });
    const s = await new Inspector(http).getSubscriptions({ path: "messages:" });
    expect(asked).toBe(`${URL_BASE}/api/debug/subscriptions?path=messages%3A`);
    expect(headers).toEqual({ Authorization: "Bunvex local|k", "Bunvex-Client": "dashboard-0.0.0" });
    const q = s.sessions[0]!.queries[0]!;
    expect(q).not.toHaveProperty("validAt");
    expect(q.readSet[0]!.lo).toEqual(keyBound(["ana"]));
    expect(q.readSet[1]!.hi).toEqual({ kind: "raw", hex: "ff00", text: "0xff00" });
    expect(q.history[0]).toEqual({
      kind: "invalidation",
      seq: 7,
      at: 1_700_000_000_007,
      commitTs: 1007,
      source: "messages:send",
      table: "messages",
      index: "messages.by_creation_time",
      key: keyBound([1_700_000_000_007, "id7"]),
      sentAfterMs: 0.5,
    });
    expect(s).toEqual(subscriptionsOf(server as never));
    expect(s.totals).toEqual({ sessions: 2, queries: 1 });
    await new Inspector(http).getSubscriptions();
    expect(asked).toBe(`${URL_BASE}/api/debug/subscriptions`);
  });

  test("the query cache: every miss reason (0 when the server leaves one out), the limit sent", async () => {
    const server = {
      entries: 2,
      bytes: 300,
      maxBytes: 1 << 20,
      hits: 5,
      misses: 3,
      missReasons: { new: 2, invalidated: 1 },
      waits: 1,
      evictions: 0,
      matching: 2,
      biggest: [
        {
          path: "messages:list",
          argsDigest: "0123456789ab",
          shared: true,
          state: "ready",
          size: 200,
          originalTs: 40,
          tokenTs: 42,
          observedTime: false,
          readSet: [],
        },
        { path: "messages:count", argsDigest: "ba9876543210", shared: false, state: "running", size: 100, ts: 42 },
      ],
    };
    let asked = "";
    const http = new AdminHttp({
      url: URL_BASE,
      adminKey: "local|k",
      fetch: async (u) => {
        asked = u;
        return Response.json(server);
      },
    });
    const c = await new Inspector(http).getQueryCache({ path: "messages", limit: 5 });
    expect(asked).toBe(`${URL_BASE}/api/debug/query_cache?path=messages&limit=5`);
    expect(c.missReasons).toEqual({ new: 2, evicted: 0, invalidated: 1, expired: 0, snapshot: 0 });
    expect(c).not.toHaveProperty("waits");
    expect(c.biggest).toEqual([
      {
        path: "messages:list",
        argsDigest: "0123456789ab",
        shared: true,
        state: "ready",
        size: 200,
        originalTs: 40,
        tokenTs: 42,
        readSet: [],
      },
      { path: "messages:count", argsDigest: "ba9876543210", shared: false, state: "running", size: 100 },
    ]);
    expect(queryCacheOf(server as never)).toEqual(c);
  });

  test("a refusal is the contract's `unauthorized`", async () => {
    const http = new AdminHttp({
      url: URL_BASE,
      adminKey: "local|k",
      fetch: async () => Response.json({ code: "Forbidden", message: "may not view metrics" }, { status: 403 }),
    });
    const e = await new Inspector(http).getSubscriptions().then(
      () => null,
      (x: DataSourceError) => x,
    );
    expect([e?.code, e?.message]).toEqual(["unauthorized", "may not view metrics"]);
  });
});

describe("following invalidations", () => {
  test("from now on: the feed's position first, then each answer's newCursor; never synchronously", async () => {
    const feed = new FakeFeed();
    feed.push();
    feed.push();
    const f = follower();
    const inspector = new Inspector(feed.http);
    const off = inspector.watchInvalidations({ path: "messages" }, f.onEvents, f.onError);
    expect(feed.asked).toEqual([]);
    await until(() => feed.waiting === 1, "the follow request");
    expect(feed.asked).toEqual([
      "/api/debug/invalidations?cursor=0&timeoutMs=0&path=messages",
      "/api/debug/invalidations?cursor=2&timeoutMs=60000&path=messages",
    ]);
    feed.push();
    feed.push("other:fn");
    feed.push();
    await until(() => feed.waiting === 1 && f.seqs().includes(5), "the deliveries");
    // only what came after the call, in order; the other function's left out by the server, its seq still passed
    expect(f.seqs()).toEqual([3, 5]);
    expect(feed.asked.at(-1)).toBe("/api/debug/invalidations?cursor=5&timeoutMs=60000&path=messages");
    expect(f.events[0]).toEqual({
      kind: "invalidation",
      seq: 3,
      at: 1_700_000_000_003,
      commitTs: 1003,
      source: "messages:send",
      table: "messages",
      index: "messages.by_creation_time",
      key: keyBound([1_700_000_000_003, "id3"]),
      sentAfterMs: 0.5,
      path: "messages:list",
      argsDigest: "0123456789ab",
    });
    off();
    expect(f.errors).toEqual([]);
  });

  test("stopping aborts the request in flight; nothing is asked or delivered after", async () => {
    const feed = new FakeFeed();
    const f = follower();
    const off = new Inspector(feed.http).watchInvalidations({}, f.onEvents, f.onError);
    await until(() => feed.waiting === 1, "the follow request");
    const asked = feed.asked.length;
    off();
    await until(() => feed.aborted === 1, "the abort");
    feed.push();
    await settle();
    expect([feed.asked.length, f.events.length, f.errors.length]).toEqual([asked, 0, 0]);
    // stopped before its first request: none goes out
    const off2 = new Inspector(feed.http).watchInvalidations({}, f.onEvents, f.onError);
    off2();
    await settle();
    expect(feed.asked.length).toBe(asked);
  });

  test("failures back off, are reported after 5 in a row, and what came meanwhile is delivered after", async () => {
    const feed = new FakeFeed();
    const f = follower();
    const backoffs: number[] = [];
    const off = new Inspector(feed.http, {
      backoff: (n) => {
        backoffs.push(n);
        return 1;
      },
    }).watchInvalidations({}, f.onEvents, f.onError);
    await until(() => feed.waiting === 1, "the follow request");
    for (let i = 0; i < 6; i++) feed.failures.push(() => new Response("down", { status: 503 }));
    feed.push(); // answers the waiting request: seq 1
    await until(() => f.seqs().length === 1, "seq 1");
    // the next six requests fail; meanwhile seq 2 and 3 land
    feed.push();
    feed.push();
    await until(() => backoffs.length === 6, "six failures");
    await until(() => f.seqs().length === 3, "the missed ones");
    expect(backoffs).toEqual([1, 2, 3, 4, 5, 6]);
    // the sixth in a row is reported, the five before it are not
    expect(f.errors.map((e) => [e.code, e.message])).toEqual([["unavailable", "down"]]);
    expect(f.seqs()).toEqual([1, 2, 3]);
    // after the failures, the position is asked again (everything at once), then followed from it
    await until(() => feed.waiting === 1, "following again");
    expect(feed.asked.slice(-2)).toEqual([
      "/api/debug/invalidations?cursor=0&timeoutMs=0",
      "/api/debug/invalidations?cursor=3&timeoutMs=60000",
    ]);
    off();
  });

  test("a server that restarted (its feed behind ours) is followed from its own position", async () => {
    const feed = new FakeFeed();
    const f = follower();
    const off = new Inspector(feed.http, { backoff: () => 1 }).watchInvalidations({}, f.onEvents, f.onError);
    await until(() => feed.waiting === 1, "the follow request");
    for (let i = 0; i < 5; i++) feed.push();
    await until(() => f.seqs().length === 5 && feed.waiting === 1, "seq 1–5");
    // the server goes away and comes back with a new feed holding two invalidations
    feed.failures.push(() => {
      throw new TypeError("connection refused");
    });
    feed.restart();
    feed.push();
    feed.push();
    await until(() => f.seqs().length === 7, "the new server's two");
    expect(f.seqs()).toEqual([1, 2, 3, 4, 5, 1, 2]);
    await until(() => feed.waiting === 1, "following again");
    feed.push();
    await until(() => f.seqs().length === 8, "seq 3 of the new server");
    expect(f.seqs().at(-1)).toBe(3);
    off();
  });

  test("a refusal stops the loop and is reported at once", async () => {
    const feed = new FakeFeed();
    const f = follower();
    feed.failures.push(() => Response.json({ code: "Forbidden", message: "may not view metrics" }, { status: 403 }));
    const off = new Inspector(feed.http, { backoff: () => 1 }).watchInvalidations({}, f.onEvents, f.onError);
    await until(() => f.errors.length === 1, "the refusal");
    await settle();
    expect(f.errors[0]!.code).toBe("unauthorized");
    expect(feed.asked.length).toBe(1);
    off();
  });

  test("while disconnected: the request is aborted, nothing is asked; on return, what came meanwhile", async () => {
    const feed = new FakeFeed();
    const f = follower();
    let tell: (s: ConnectionStatus) => void = () => {};
    let watching = 0;
    const off = new Inspector(feed.http, {
      connection: (onStatus) => {
        tell = onStatus;
        watching++;
        return () => {
          watching--;
        };
      },
    }).watchInvalidations({}, f.onEvents, f.onError);
    tell("unknown");
    await until(() => feed.waiting === 1, "the follow request");
    feed.push();
    await until(() => f.seqs().length === 1 && feed.waiting === 1, "seq 1");
    tell("disconnected");
    await until(() => feed.aborted === 1, "the request aborted");
    const asked = feed.asked.length;
    feed.push();
    feed.push();
    await settle();
    expect(feed.asked.length).toBe(asked);
    expect(f.seqs()).toEqual([1]);
    tell("connected");
    await until(() => f.seqs().length === 3, "the missed ones");
    expect(f.seqs()).toEqual([1, 2, 3]);
    expect(f.errors).toEqual([]);
    await until(() => feed.waiting === 1, "following again");
    expect(feed.asked.slice(asked)).toEqual([
      "/api/debug/invalidations?cursor=0&timeoutMs=0",
      "/api/debug/invalidations?cursor=3&timeoutMs=60000",
    ]);
    off();
    expect(watching).toBe(0);
  });

  test("a back-off ends when the connection comes back", async () => {
    const feed = new FakeFeed();
    const f = follower();
    const timers = manualTimers();
    let tell: (s: ConnectionStatus) => void = () => {};
    const off = new Inspector(feed.http, {
      backoff: () => 60_000,
      after: timers.after,
      connection: (onStatus) => {
        tell = onStatus;
        return () => {};
      },
    }).watchInvalidations({}, f.onEvents, f.onError);
    await until(() => feed.waiting === 1, "the follow request");
    feed.failures.push(() => {
      throw new TypeError("connection refused");
    });
    feed.push();
    // the back-off itself scheduled, not a request seen going out: the failure has landed
    await until(() => f.seqs().length === 1 && timers.pending().length === 1, "a failure, then the back-off");
    expect(timers.pending()).toEqual([60_000]);
    feed.push();
    tell("disconnected");
    await settle();
    // still in its back-off: nothing asked while disconnected
    expect([feed.asked.length, timers.pending()]).toEqual([3, [60_000]]);
    tell("connected");
    // the minute never passes (the test's timers): only the connection's return can end it
    await until(() => f.seqs().length === 2, "seq 2, without the back-off's minute");
    expect(timers.pending()).toEqual([]);
    expect(f.errors).toEqual([]);
    off();
  });

  test("a request cut by a disconnection is no failure, even when the connection is back before it lands", async () => {
    const feed = new FakeFeed();
    const f = follower();
    const timers = manualTimers();
    const backoffs: number[] = [];
    let tell: (s: ConnectionStatus) => void = () => {};
    const off = new Inspector(feed.http, {
      backoff: (n) => {
        backoffs.push(n);
        return 60_000;
      },
      after: timers.after,
      connection: (onStatus) => {
        tell = onStatus;
        return () => {};
      },
    }).watchInvalidations({}, f.onEvents, f.onError);
    await until(() => feed.waiting === 1, "the follow request");
    // the next request is held on its way, then fails as an aborted fetch does
    const held = gate();
    let arrived = false;
    feed.failures.push(async () => {
      arrived = true;
      await held.opened;
      throw new DOMException("aborted", "AbortError");
    });
    feed.push();
    await until(() => f.seqs().length === 1 && arrived, "the next request in flight");
    // a blip: the request is aborted, and the connection is back before its rejection reaches the loop
    feed.push();
    tell("disconnected");
    tell("connected");
    held.open();
    // caught up at once: no back-off (whose wake-up has already passed), no failure counted
    await until(() => f.seqs().length === 2 && feed.waiting === 1, "seq 2, then following again");
    expect([backoffs, timers.pending(), f.errors]).toEqual([[], [], []]);
    expect(feed.asked.slice(-2)).toEqual([
      "/api/debug/invalidations?cursor=0&timeoutMs=0",
      "/api/debug/invalidations?cursor=2&timeoutMs=60000",
    ]);
    off();
  });

  test("close stops every loop", async () => {
    const feed = new FakeFeed();
    const f = follower();
    const inspector = new Inspector(feed.http);
    inspector.watchInvalidations({}, f.onEvents, f.onError);
    inspector.watchInvalidations({ path: "x" }, f.onEvents, f.onError);
    await until(() => feed.waiting === 2, "two follow requests");
    inspector.close();
    await until(() => feed.aborted === 2, "both aborted");
    feed.push();
    await settle();
    expect(f.events).toEqual([]);
  });
});
