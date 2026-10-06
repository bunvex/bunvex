// The engine's side of PERSIST-01 C7 (single writer): it takes the store's lease before reading maxTs,
// refuses to open a store another process holds, renews the lease, stops the committer when it is lost,
// and releases it on close. The driver side is checked on real stores by the conformance suite (K10–K18).
import { afterEach, describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { CommitterStoppedError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import {
  type DocWrite,
  type IndexWrite,
  type Lease,
  type LeaseAcquire,
  LeaseHeldError,
  LeaseLostError,
  type Persistence,
} from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One store, as several processes see it: shared data and one lease record on the store's clock. */
class Store {
  lease = { epoch: 0, holder: null as string | null, expiresAt: 0 };
  calls: string[] = [];
  constructor(readonly data: MemoryPersistence) {}
  static async create() {
    return new Store(await MemoryPersistence.open(null, { durable: false }));
  }
  connect() {
    return new LeasedConnection(this);
  }
}

/** A driver connection implementing C7 over the shared store (the fence is the epoch check in flush). */
class LeasedConnection implements Persistence, Lease {
  private epoch = 0;
  private ttl = 0;
  constructor(private store: Store) {}
  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    this.store.calls.push("acquire");
    const l = this.store.lease;
    const now = Date.now();
    if (l.holder !== null && l.expiresAt > now) return { heldBy: l.holder, expiresInMs: l.expiresAt - now };
    l.epoch++;
    l.holder = opts.holder;
    l.expiresAt = now + opts.ttlMs;
    this.epoch = l.epoch;
    this.ttl = opts.ttlMs;
    return { epoch: l.epoch };
  }
  async renewLease() {
    this.store.calls.push("renew");
    if (this.store.lease.epoch !== this.epoch) throw new LeaseLostError();
    this.store.lease.expiresAt = Date.now() + this.ttl;
  }
  async releaseLease() {
    this.store.calls.push("release");
    if (this.store.lease.epoch === this.epoch) this.store.lease.holder = null;
  }
  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.store.data.apply(ts, docs, idx);
  }
  async flush() {
    if (this.store.lease.epoch !== this.epoch) throw new LeaseLostError();
    await this.store.data.flush();
  }
  scan(index: number, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean) {
    return this.store.data.scan(index, lo, hi, ts, limit, desc);
  }
  get(table: number, id: string, ts: bigint) {
    return this.store.data.get(table, id, ts);
  }
  maxTs() {
    this.store.calls.push("maxTs");
    return this.store.data.maxTs();
  }
  close() {}
}

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
});
const open = async (store: Store, lease?: { ttlMs?: number; waitMs?: number }) => {
  const e = new Engine(schema, store.connect(), { lease });
  engines.push(e);
  return e.init();
};
const insert = (e: Engine) => e.mutation((db) => db.insert("items", { n: 1 }));

describe("the store's lease (PERSIST-01 C7)", () => {
  test("init takes the lease before it reads maxTs", async () => {
    const store = await Store.create();
    await open(store);
    expect(store.calls.slice(0, 2)).toEqual(["acquire", "maxTs"]);
  });

  test("a second engine on a held store fails init with who holds it and when it expires", async () => {
    const store = await Store.create();
    await open(store, { ttlMs: 5000 });
    const err = await open(store).catch((e) => e);
    expect(err).toBeInstanceOf(LeaseHeldError);
    expect(err.heldBy).toMatch(/:\d+:/); // host:pid:random
    expect(err.expiresInMs).toBeGreaterThan(0);
    expect(err.expiresInMs).toBeLessThanOrEqual(5000);
    expect(err.message).toContain(err.heldBy);
  });

  test("the lease is renewed: the holder keeps it past its TTL", async () => {
    const store = await Store.create();
    const a = await open(store, { ttlMs: 150 });
    await sleep(500);
    expect(await open(store).catch((e) => e)).toBeInstanceOf(LeaseHeldError);
    await insert(a); // still the writer
  });

  test("close releases the lease: another engine opens at once", async () => {
    const store = await Store.create();
    const a = await open(store, { ttlMs: 60_000 });
    await insert(a);
    await a.close();
    const b = await open(store);
    expect(await b.query((db) => db.query("items").collect())).toHaveLength(1);
  });

  test("with waitMs, a second engine waits for the lease and then opens", async () => {
    const store = await Store.create();
    const a = await open(store, { ttlMs: 60_000 });
    setTimeout(() => a.close(), 200);
    const t0 = Date.now();
    const b = await open(store, { waitMs: 5000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    await insert(b);
  });

  test("with waitMs, a lease that stays held fails init once the wait runs out", async () => {
    const store = await Store.create();
    await open(store, { ttlMs: 60_000 });
    expect(await open(store, { waitMs: 300 }).catch((e) => e)).toBeInstanceOf(LeaseHeldError);
  });

  test("a lost lease stops the committer: later mutations are refused, onFatal fires once", async () => {
    const store = await Store.create();
    const a = await open(store, { ttlMs: 150 });
    const fatal: Error[] = [];
    a.committer.onFatal((e) => fatal.push(e));
    // another process takes the store (as after a pause longer than the TTL)
    store.lease.holder = null;
    await store.connect().acquireLease({ holder: "other", ttlMs: 60_000 });
    await sleep(200); // the next renewal (every TTL/3) finds the epoch gone
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toBeInstanceOf(CommitterStoppedError);
    expect((fatal[0].cause as Error) instanceof LeaseLostError).toBe(true);
    expect(await insert(a).catch((e) => e)).toBeInstanceOf(CommitterStoppedError);
  });

  test("a flush fenced by the store (lost lease between renewals) stops the committer the same way", async () => {
    const store = await Store.create();
    const a = await open(store, { ttlMs: 60_000 });
    store.lease.epoch++; // taken over; the renewal has not run yet
    expect(await insert(a).catch((e) => e)).toBeInstanceOf(CommitterStoppedError);
    expect(a.committer.stopped?.cause).toBeInstanceOf(LeaseLostError);
  });

  test("a renewal the store never answers stops the committer once the TTL runs out (STUDY-25 L3)", async () => {
    const store = await Store.create();
    const conn = store.connect();
    const e = new Engine(schema, conn, { lease: { ttlMs: 150 } });
    engines.push(e);
    await e.init();
    const fatal: Error[] = [];
    e.committer.onFatal((err) => fatal.push(err));
    conn.renewLease = () => new Promise<void>(() => {}); // a hung connection: no answer, no error
    const t0 = Date.now();
    while (!fatal.length && Date.now() - t0 < 2000) await sleep(10);
    expect(fatal).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(150 + 2 * 50 + 100); // TTL + up to two renewal periods + slack
    expect((fatal[0].cause as Error) instanceof LeaseLostError).toBe(true);
    expect(await insert(e).catch((err) => err)).toBeInstanceOf(CommitterStoppedError);
  });

  test("a driver without a lease opens as before", async () => {
    const e = new Engine(schema, await MemoryPersistence.open(null, { durable: false }));
    engines.push(e);
    await e.init();
    await insert(e);
  });
});
