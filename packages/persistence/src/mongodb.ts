// MongoDB (optional peer: `mongodb`): the same two logical collections (documents, indexes). Three
// driver-local rules make it satisfy PERSIST-01:
//
//   C2 ordering — BinData compares by LENGTH first, which breaks byte order ("b" < "aa"). Keys are stored as
//      lowercase hex strings, whose (binary-collation) string order IS the byte order.
//   C4 atomicity — a group is flushed in ONE multi-document transaction (w: majority, journaled).
//   C7 single writer — the lease is one document, `meta` {_id: "lease"} (epoch, holder, expiresAt on the
//      server's clock, maxTs). Each flush's transaction first updates it only if our epoch is current, and
//      records the group's top as the durable prefix; a mismatch aborts the whole group.
//
// Transactions need a replica set (a single-node one is enough): the driver refuses a standalone server
// (owner's decision, 2026-09-30; STUDY-24 §4.4). Stores written by earlier versions used a commit marker
// (`meta` {_id: "commit"}) and rows written before it; they are read as such, and the rows a crash left
// above the marker are deleted — under the lease only, never by a mere open.
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L6/L7): `meta` {_id: "layout", version} and
// `meta` {_id: "read_only"}. Open checks both before writing anything (index builds included) and refuses a
// foreign, future or read-only store; a new store's version record is written under the lease.
// Timeouts (STUDY-25 L3). Convex has no MongoDB driver; this one follows its Postgres driver: every call is
// bounded on the client side (30 s by default), per round trip, and a connection whose call timed out is
// never reused. The bound is the driver's own (socketTimeoutMS: a connection that waits longer for an answer
// is closed; connectTimeoutMS, serverSelectionTimeoutMS, waitQueueTimeoutMS for the other waits), plus a
// guard around each call, because the driver retries a timed-out read or transaction on its own (retryReads,
// withTransaction for up to 120 s), which would let one call wait several timeouts.
import {
  checkLayoutVersion,
  checkUnversionedTables,
  type DocWrite,
  type IndexWrite,
  LAYOUT_VERSION,
  type Lease,
  type LeaseAcquire,
  LeaseLostError,
  type OpenOptions,
  type Persistence,
  ReadOnlyError,
  type ReadOnlyFlag,
  renewTimeoutMs,
  type ScanDocs,
  scanLatest,
  withTimeout,
} from "@bunvex/core/persistence";
import type { Collection, Db, MongoClient } from "mongodb";
import { loadPeer } from "./peer.ts";

type DocRow = { t: number; i: string; ts: number; j: string | null };
type IdxRow = { x: number; k: string; ts: number; d: string | null };

const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");

const STORE = "this MongoDB database";
/** bunvex's fields: how an unversioned store is recognised (a sample of each collection). */
const FIELDS = {
  documents: ["_id", "t", "i", "ts", "j"],
  indexes: ["_id", "x", "k", "ts", "d"],
};

type LeaseDoc = {
  _id: string;
  epoch: number;
  holder: string | null;
  app: string | null;
  expiresAt: Date;
  maxTs: number;
};

export class MongoPersistence implements Persistence, ScanDocs, Lease, ReadOnlyFlag {
  private docsBuf: DocRow[] = [];
  private idxBuf: IdxRow[] = [];
  /** Our lease's epoch, 0 when we hold none. */
  private epoch = 0;
  private ttlMs = 0;
  private constructor(
    private client: MongoClient,
    private docs: Collection<DocRow>,
    private idx: Collection<IdxRow>,
    private meta: Collection<any>,
    /** This instance's appName, recorded in the lease: a successor that finds us paused inside a flush
     *  after our lease expired ends exactly our sessions. */
    private app: string,
    /** The client-side timeout of one round trip (STUDY-25 L3). */
    private timeoutMs: number,
  ) {}

  /**
   * `timeoutMs` (default 30 000, as Convex's Postgres driver; the MongoDB driver's own defaults for connecting
   * and selecting a server are 30 s too): how long one round trip to the database may take before the call
   * fails with `DatabaseTimeoutError`; the driver closes the connection it was waiting on (STUDY-25 L3). 0
   * disables it.
   */
  static async open(url: string, opts: { fresh?: boolean; pool?: number; timeoutMs?: number } & OpenOptions = {}) {
    const { MongoClient: Client } = await loadPeer<typeof import("mongodb")>("mongodb", "mongodb");
    const app = `bunvex-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const t = timeoutMs > 0 && timeoutMs < Infinity ? timeoutMs : 0;
    const client = new Client(url, {
      maxPoolSize: opts.pool ?? 16,
      appName: app,
      ...(t ? { socketTimeoutMS: t, connectTimeoutMS: t, serverSelectionTimeoutMS: t, waitQueueTimeoutMS: t } : {}),
    });
    const call = <T>(fn: (progress: () => void) => Promise<T>) => withTimeout("MongoDB", timeoutMs, fn);
    try {
      return await call(async (progress) => {
        await client.connect();
        progress();
        const db: Db = client.db();
        const hello = await db.admin().command({ hello: 1 });
        progress();
        if (!hello.setName)
          throw new Error(
            "bunvex needs MongoDB as a replica set (a single-node one is enough: start mongod with --replSet and run rs.initiate()); a standalone server cannot run the transactions a flush needs",
          );
        if (opts.fresh) await db.dropDatabase();
        progress();
        const docs = db.collection<DocRow>("documents");
        const idx = db.collection<IdxRow>("indexes");
        const meta = db.collection<any>("meta");
        await MongoPersistence.checkStore(docs, idx, meta, opts, progress);
        // Indexes only when missing (STUDY-25 L1): every open should not take the locks of index builds.
        const want: [Collection<any>, Record<string, 1 | -1>][] = [
          [docs, { t: 1, i: 1, ts: -1 }],
          [idx, { x: 1, k: 1, ts: -1 }],
          [idx, { x: 1, k: -1, ts: -1 }], // descending scans keep "newest version first" per key
        ];
        for (const [c, key] of want) {
          const have = await c
            .listIndexes()
            .toArray()
            .catch(() => []);
          progress();
          if (!have.some((i) => JSON.stringify(i.key) === JSON.stringify(key))) await c.createIndex(key);
          progress();
        }
        return new MongoPersistence(client, docs, idx, meta, app, timeoutMs);
      });
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  /** One database call, bounded per round trip (`progress()` marks the end of one). */
  private call<T>(fn: (progress: () => void) => Promise<T>, ms = this.timeoutMs) {
    return withTimeout("MongoDB", ms, fn);
  }

  /**
   * PERSIST-01 C10, before anything is written: the recorded layout version must be this bunvex's; a store
   * without one must hold bunvex's fields (written before C10: the same layout) or nothing; and a store
   * marked read-only opens only with `allowReadOnly`. Refusing needs no lease: nothing is written.
   */
  private static async checkStore(
    docs: Collection<DocRow>,
    idx: Collection<IdxRow>,
    meta: Collection<any>,
    opts: OpenOptions,
    progress: () => void,
  ) {
    const flags = await meta.find({ _id: { $in: ["layout", "read_only"] } }).toArray();
    progress();
    const layout = flags.find((f) => f._id === "layout");
    if (layout) checkLayoutVersion(layout.version, STORE);
    else {
      const found: Record<string, string[]> = {};
      for (const [name, c] of [
        ["documents", docs],
        ["indexes", idx],
      ] as const) {
        const one = await (c as Collection<any>).findOne({});
        progress();
        if (one) found[name] = Object.keys(one);
      }
      checkUnversionedTables(STORE, found, FIELDS, ["collection", "fields"]);
    }
    if (flags.some((f) => f._id === "read_only") && !opts.allowReadOnly) throw new ReadOnlyError(STORE);
  }

  /** Convex's `set_read_only`: no lease needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    await this.call(async () => {
      if (readOnly)
        await this.meta.updateOne(
          { _id: "read_only" },
          { $set: { since: new Date() } },
          { upsert: true, writeConcern: { w: "majority" } },
        );
      else await this.meta.deleteOne({ _id: "read_only" }, { writeConcern: { w: "majority" } });
    });
  }

  acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    return this.call((progress) => this.acquireLeaseIn(progress, opts));
  }

  private async acquireLeaseIn(progress: () => void, opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    // A store without a lease document: its durable prefix is the old commit marker, else the newest row.
    const found = await this.meta.findOne({ _id: "lease" });
    progress();
    if (!found) {
      const marker = (await this.meta.findOne({ _id: "commit" }))?.ts as number | undefined;
      progress();
      const newest = async (c: Collection<any>) =>
        ((
          await c
            .find({}, { projection: { ts: 1 } })
            .sort({ ts: -1 })
            .limit(1)
            .toArray()
        )[0]?.ts as number) ?? 0;
      const maxTs = marker ?? Math.max(await newest(this.docs), await newest(this.idx));
      progress();
      await this.meta
        .insertOne({ _id: "lease", epoch: 0, holder: null, app: null, expiresAt: new Date(0), maxTs })
        .catch((e) => {
          if ((e as { code?: number }).code !== 11000) throw e; // a concurrent first acquire created it
        });
      progress();
    }
    for (let attempt = 0; ; attempt++) {
      let won: LeaseDoc | null;
      try {
        won = await this.meta.findOneAndUpdate(
          { _id: "lease", $or: [{ holder: null }, { $expr: { $lte: ["$expiresAt", "$$NOW"] } }] },
          [
            {
              $set: {
                epoch: { $add: ["$epoch", 1] },
                holder: opts.holder,
                app: this.app,
                expiresAt: { $add: ["$$NOW", opts.ttlMs] },
              },
            },
          ],
          { returnDocument: "after", maxTimeMS: 1000, writeConcern: { w: "majority" } },
        );
        progress();
      } catch (e) {
        // A holder's open flush transaction wrote the lease document: our write waits for it (up to the
        // server's transaction lifetime). Look below, then retry.
        if ((e as { code?: number }).code !== 50 || attempt >= 3) throw e; // 50: MaxTimeMSExpired
        won = null;
        const [s] = await this.meta
          .aggregate([
            { $match: { _id: "lease" } },
            { $project: { holder: 1, app: 1, expired: { $lte: ["$expiresAt", "$$NOW"] } } },
          ])
          .toArray();
        progress();
        // Expired, yet still in a transaction on the lease: a paused (stopped, frozen) process mid-flush.
        // End its sessions; its uncommitted group aborts, and it was never acknowledged.
        if (s?.expired && s.app) await this.killSessionsOf(s.app as string);
        progress();
        continue;
      }
      if (won) {
        this.epoch = won.epoch;
        this.ttlMs = opts.ttlMs;
        // PERSIST-01 C10: a new (or pre-C10) store gets its layout version now, under the lease; one stamped in
        // the meantime by another bunvex is checked again, before any recovery below touches its rows.
        await this.meta.updateOne(
          { _id: "layout" },
          { $setOnInsert: { version: LAYOUT_VERSION } },
          { upsert: true, writeConcern: { w: "majority" } },
        );
        progress();
        const layout = await this.meta.findOne({ _id: "layout" });
        progress();
        try {
          checkLayoutVersion(layout?.version, STORE);
        } catch (e) {
          await this.releaseLease();
          throw e;
        }
        // Rows above the durable prefix are the remains of an interrupted flush of an earlier version
        // (commit-marker stores): delete them now that no one else can be writing.
        await this.docs.deleteMany({ ts: { $gt: won.maxTs } });
        progress();
        await this.idx.deleteMany({ ts: { $gt: won.maxTs } });
        return { epoch: this.epoch };
      }
      const [s] = await this.meta
        .aggregate([
          { $match: { _id: "lease" } },
          { $project: { holder: 1, ms: { $max: [0, { $subtract: ["$expiresAt", "$$NOW"] }] } } },
        ])
        .toArray();
      return { heldBy: s.holder as string, expiresInMs: Number(s.ms) };
    }
  }

  private async killSessionsOf(app: string) {
    const admin = this.client.db("admin");
    const ops = await admin
      .aggregate([{ $currentOp: { allUsers: true, idleSessions: true } }, { $match: { appName: app } }])
      .toArray();
    const lsids = ops.map((o) => o.lsid).filter(Boolean);
    if (lsids.length) await admin.command({ killSessions: lsids }).catch(() => {});
  }

  /** Bounded by a quarter of the TTL (`renewTimeoutMs`, STUDY-25 L3). */
  async renewLease() {
    const r = await this.call(
      () =>
        this.meta.updateOne({ _id: "lease", epoch: this.epoch }, [
          { $set: { expiresAt: { $add: ["$$NOW", this.ttlMs] } } },
        ]),
      renewTimeoutMs(this.timeoutMs, this.ttlMs),
    );
    if (r.matchedCount !== 1) throw new LeaseLostError();
  }

  async releaseLease() {
    if (!this.epoch) return;
    await this.call(() => this.meta.updateOne({ _id: "lease", epoch: this.epoch }, { $set: { holder: null } }));
    this.epoch = 0;
  }

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    for (const d of docs) this.docsBuf.push({ t: d.table, i: d.id, ts, j: d.json });
    for (const e of idx) this.idxBuf.push({ x: e.index, k: hex(e.key), ts, d: e.id });
  }

  async flush() {
    if (!this.docsBuf.length && !this.idxBuf.length) return;
    if (!this.epoch) throw new Error("flush without the store's lease (PERSIST-01 C7): acquireLease first");
    const docs = this.docsBuf;
    const idx = this.idxBuf;
    this.docsBuf = [];
    this.idxBuf = [];
    const top = Math.max(docs.at(-1)?.ts ?? 0, idx.at(-1)?.ts ?? 0);
    const session = this.client.startSession();
    let ok = false;
    try {
      await this.call((progress) =>
        session.withTransaction(
          async () => {
            progress();
            // The fence first: nothing of the group commits unless the lease still carries our epoch. A
            // concurrent takeover makes this a write conflict (retried by withTransaction, then refused here).
            const f = await this.meta.updateOne(
              { _id: "lease", epoch: this.epoch },
              { $set: { maxTs: top } },
              { session },
            );
            if (f.matchedCount !== 1) throw new LeaseLostError();
            progress();
            if (docs.length) await this.docs.insertMany(docs, { session, ordered: false });
            progress();
            if (idx.length) await this.idx.insertMany(idx, { session, ordered: false });
            progress(); // COMMIT
          },
          { writeConcern: { w: "majority", j: true } },
        ),
      );
      ok = true;
    } finally {
      // After a failure, not awaited: on a store that does not answer, ending the session (which aborts its
      // transaction) would wait too, and the flush has already failed.
      const ended = session.endSession();
      if (ok) await ended;
      else ended.catch(() => {});
    }
  }

  private latest(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    return scanLatest(
      async (p) => {
        const rows = await this.call(() =>
          this.idx
            .find(
              { x: index, k: { $gte: hex(p.lo), $lt: hex(p.hi) }, ts: { $lte: ts } },
              { projection: { _id: 0, k: 1, d: 1 } },
            )
            .sort(desc ? { k: -1, ts: -1 } : { k: 1, ts: -1 })
            .limit(p.n)
            .toArray(),
        );
        return rows.map((r) => ({
          key: Buffer.from(r.k as string, "hex"),
          deleted: r.d === null,
          id: r.d as string | null,
        }));
      },
      lo,
      hi,
      limit,
      desc,
    );
  }

  scan(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    return this.latest(index, lo, hi, ts, limit, desc);
  }

  async get(table: number, id: string, ts: number) {
    const r = await this.call(() =>
      this.docs.findOne({ t: table, i: id, ts: { $lte: ts } }, { sort: { ts: -1 }, projection: { j: 1 } }),
    );
    return r ? r.j : null;
  }

  async scanDocs(
    table: number,
    index: number,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: number,
    limit: number,
    desc: boolean,
  ) {
    const ids = await this.latest(index, lo, hi, ts, limit, desc);
    if (!ids.length) return [];
    // One round trip for every document: newest version <= ts of each id.
    const rows = await this.call(() =>
      this.docs
        .aggregate<{ _id: string; j: string | null }>([
          { $match: { t: table, i: { $in: ids }, ts: { $lte: ts } } },
          { $sort: { i: 1, ts: -1 } },
          { $group: { _id: "$i", j: { $first: "$j" } } },
        ])
        .toArray(),
    );
    const byId = new Map(rows.map((r) => [r._id, r.j]));
    const out: string[] = [];
    for (const id of ids) {
      const j = byId.get(id);
      if (j) out.push(j);
    }
    return out;
  }

  /** The durable prefix (PERSIST-01 C5/C7): the lease document's maxTs, which every fenced flush sets; for a
   *  store never leased, the old commit marker. */
  maxTs() {
    return this.call(async (progress) => {
      const lease = await this.meta.findOne({ _id: "lease" });
      if (lease) return lease.maxTs as number;
      progress();
      return ((await this.meta.findOne({ _id: "commit" }))?.ts as number) ?? 0;
    });
  }

  async auditLiveDocs(table: number, ts: number) {
    const [r] = await this.call(() =>
      this.docs
        .aggregate<{ n: number }>([
          { $match: { t: table, ts: { $lte: ts } } },
          { $sort: { i: 1, ts: -1 } },
          { $group: { _id: "$i", j: { $first: "$j" } } },
          { $match: { j: { $ne: null } } },
          { $count: "n" },
        ])
        .toArray(),
    );
    return r?.n ?? 0;
  }

  /** Closes the client; on a database that does not answer, gives up waiting after one timeout. */
  async close() {
    await this.call(() => this.client.close());
  }
}
