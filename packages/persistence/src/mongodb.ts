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
// Retention (PERSIST-01 C12–C14, STUDY-33): the document log reads `documents` by ts (a `{ts: 1}` index);
// prunes are `ts <= X` deletes per key, one unordered bulk write per batch; globals are documents of
// `persistence_globals` ({_id: key, v: JSON}). Each prune or global write first reads the lease and is
// refused unless it carries our epoch; a takeover in between can let one batch through, which deletes only
// versions superseded below a window the old holder had already published.
// Timeouts (STUDY-25 L3). Convex has no MongoDB driver; this one follows its Postgres driver: every call is
// bounded on the client side (30 s by default), per round trip, and a connection whose call timed out is
// never reused. The bound is the driver's own (socketTimeoutMS: a connection that waits longer for an answer
// is closed; connectTimeoutMS, serverSelectionTimeoutMS, waitQueueTimeoutMS for the other waits), plus a
// guard around each call, because the driver retries a timed-out read or transaction on its own (retryReads,
// withTransaction for up to 120 s), which would let one call wait several timeouts.
//
// Retries (STUDY-25 L4/L5; no Convex counterpart, so this follows Convex's SQL drivers). A read runs once more
// after a timeout (the driver's own retryReads already retries a read once on a network error, on another
// connection). A flush that fails with a timeout or an operational error (`operational` below: a network
// error, a server shutting down or stepping down) is transient: the committer retries it, and this driver
// keeps the group for that retry. Before re-running a group, the driver ends the failed attempt's session and
// reads the lease record: a group an earlier attempt did commit is acknowledged without writing (DV-124).
// Unlike the SQL stores, MongoDB has no unique key on the rows, so a group that landed after that read would be
// inserted twice, silently; the fence catches it instead (it also requires maxTs below the group's top) and the
// flush fails with `UnsureCommitError` (fail-stop, as Convex's duplicate key).
import {
  checkLayoutVersion,
  checkUnversionedTables,
  DanglingReferenceError,
  DatabaseTimeoutError,
  type DocLogRow,
  type DocPrune,
  type DocVersion,
  type DocWrite,
  type IndexEntryAt,
  type IndexedDoc,
  type IndexId,
  type IndexPrune,
  type IndexWrite,
  type InternalId,
  LAYOUT_VERSION,
  type Lease,
  type LeaseAcquire,
  LeaseLostError,
  type OpenOptions,
  opaqueToInspect,
  type Persistence,
  ReadOnlyError,
  type ReadOnlyFlag,
  type RetentionStore,
  renewTimeoutMs,
  retriedGroupLanded,
  retryOnce,
  scanLatest,
  type TabletId,
  UnsureCommitError,
  withTimeout,
} from "@bunvex/core/persistence";
import type { Collection, Db, MongoClient } from "mongodb";
import { loadPeer } from "./peer.ts";

// Timestamps are int64s (nanoseconds, above 2^53): the client decodes them as `bigint` (`useBigInt64`).
// A document version (`p`: its prev_ts) and an index entry version (`tb`: its document's table).
type DocRow = { t: TabletId; i: string; ts: bigint; j: string | null; p: bigint | null };
type IdxRow = { x: IndexId; k: string; ts: bigint; tb: TabletId | null; d: string | null };
const maxTs = (a: bigint, b: bigint) => (a > b ? a : b);

const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");

const STORE = "this MongoDB database";
/** bunvex's fields: how an unversioned store is recognised (a sample of each collection). */
const FIELDS = {
  documents: ["_id", "t", "i", "ts", "j", "p"],
  indexes: ["_id", "x", "k", "ts", "tb", "d"],
};

type LeaseDoc = {
  _id: string;
  epoch: number;
  holder: string | null;
  app: string | null;
  expiresAt: Date;
  maxTs: bigint;
};

/** Server codes of a server that is not serving: shutting down, stepping down, or not (or no longer) the
 *  primary — MongoDB's counterparts of the MySQL errors Convex calls operational. */
const OPERATIONAL_CODES = new Set([
  6, // HostUnreachable
  7, // HostNotFound
  89, // NetworkTimeout
  9001, // SocketException
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  10107, // NotWritablePrimary
  11600, // InterruptedAtShutdown
  11602, // InterruptedDueToReplStateChange
  13435, // NotPrimaryNoSecondaryOk
  13436, // NotPrimaryOrSecondary
]);
/** Driver errors of a lost connection or an unreachable server (subclasses included: MongoNetworkError covers
 *  MongoNetworkTimeoutError), and of a pool checkout that timed out (Convex lists "connection pool timed out"
 *  for MySQL). */
const OPERATIONAL_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoPoolClearedError",
  "MongoWaitQueueTimeoutError",
  "MongoServerClosedError",
  "MongoTopologyClosedError",
  "MongoStalePrimaryError",
]);

/** A lost connection or a server that is not serving (STUDY-25 L4): transient. */
export function operational(e: unknown): boolean {
  const x = e as { name?: unknown; code?: unknown } | null;
  if (!x || typeof x !== "object") return false;
  if (OPERATIONAL_CODES.has(x.code as number)) return true;
  if (typeof x.name === "string" && OPERATIONAL_NAMES.has(x.name)) return true;
  for (let p = Object.getPrototypeOf(x); p && p !== Error.prototype; p = Object.getPrototypeOf(p))
    if (OPERATIONAL_NAMES.has(p.constructor?.name)) return true;
  return false;
}

export class MongoPersistence implements Persistence, Lease, ReadOnlyFlag, RetentionStore {
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
    /** `indexes` and `meta` read at majority (PERSIST-01 C11): a log reader never sees a group that a
     *  failover could still roll back. */
    private idxMajority: Collection<IdxRow>,
    private metaMajority: Collection<any>,
    private docsMajority: Collection<DocRow>,
    private globals: Collection<{ _id: string; v: string }>,
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
      useBigInt64: true,
      ...(t ? { socketTimeoutMS: t, connectTimeoutMS: t, serverSelectionTimeoutMS: t, waitQueueTimeoutMS: t } : {}),
    });
    const call = <T>(fn: (progress: () => void) => Promise<T>) => withTimeout("MongoDB", timeoutMs, fn);
    try {
      // Every step is idempotent: the whole open runs once more after a timeout (STUDY-25 L5).
      const init = () =>
        call(async (progress) => {
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
            [docs, { ts: 1 }], // the document log (PERSIST-01 C12)
            [idx, { x: 1, k: 1, ts: -1 }],
            [idx, { x: 1, k: -1, ts: -1 }], // descending scans keep "newest version first" per key
            [idx, { ts: 1 }], // the log by ts (PERSIST-01 C11)
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
          const majority = { readConcern: { level: "majority" as const } };
          return new MongoPersistence(
            client,
            docs,
            idx,
            meta,
            app,
            timeoutMs,
            db.collection<IdxRow>("indexes", majority),
            db.collection<any>("meta", majority),
            db.collection<DocRow>("documents", majority),
            db.collection<{ _id: string; v: string }>("persistence_globals", majority),
          );
        });
      return await retryOnce(init, (e) => e instanceof DatabaseTimeoutError);
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

  /** A read: one call, run once more after a timeout (STUDY-25 L5; network errors: the driver's retryReads). */
  private read<T>(fn: (progress: () => void) => Promise<T>) {
    return retryOnce(
      () => this.call(fn),
      (e) => e instanceof DatabaseTimeoutError,
    );
  }

  /** A timeout or an operational error (STUDY-25 L4). */
  isTransient(e: unknown) {
    return e instanceof DatabaseTimeoutError || operational(e);
  }

  acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    return this.call((progress) => this.acquireLeaseIn(progress, opts));
  }

  private async acquireLeaseIn(progress: () => void, opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    // A store without a lease document: its durable prefix is the old commit marker, else the newest row.
    const found = await this.meta.findOne({ _id: "lease" });
    progress();
    if (!found) {
      const marker = (await this.meta.findOne({ _id: "commit" }))?.ts as bigint | undefined;
      progress();
      const newest = async (c: Collection<any>) =>
        ((
          await c
            .find({}, { projection: { ts: 1 } })
            .sort({ ts: -1 })
            .limit(1)
            .toArray()
        )[0]?.ts as bigint) ?? 0n;
      const top = marker ?? maxTs(await newest(this.docs), await newest(this.idx));
      progress();
      await this.meta
        .insertOne({ _id: "lease", epoch: 0, holder: null, app: null, expiresAt: new Date(0), maxTs: top })
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
        this.epoch = Number(won.epoch);
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

  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    for (const d of docs) this.docsBuf.push({ t: d.table, i: d.id, ts, j: d.json, p: d.prevTs });
    for (const e of idx) this.idxBuf.push({ x: e.index, k: hex(e.key), ts, tb: e.table, d: e.id });
  }

  async flush() {
    if (!this.docsBuf.length && !this.idxBuf.length) return;
    if (!this.epoch) throw new Error("flush without the store's lease (PERSIST-01 C7): acquireLease first");
    const docs = this.docsBuf;
    const idx = this.idxBuf;
    this.docsBuf = [];
    this.idxBuf = [];
    const retry = this.retrying;
    try {
      await this.flushGroup(docs, idx, retry);
      this.retrying = false;
    } catch (e) {
      // Keep the group: the committer retries a transient failure with the same rows at the same timestamps.
      this.docsBuf = docs.concat(this.docsBuf);
      this.idxBuf = idx.concat(this.idxBuf);
      this.retrying = true;
      throw e;
    }
  }

  /** Set once a flush failed and kept its group: the next flush is a retry of it. */
  private retrying = false;

  /** The session of the last failed flush: its transaction may still be open on the server. */
  private abandoned: unknown = null;

  private async flushGroup(docs: DocRow[], idx: IdxRow[], retry: boolean) {
    const top = maxTs(docs.at(-1)?.ts ?? 0n, idx.at(-1)?.ts ?? 0n);
    // A retry: end the failed attempt's transaction first. A transaction belongs to its session, not to a
    // connection, so the server keeps it (and its write on the lease document) open after the client dropped
    // the connection, for up to transactionLifetimeLimitSeconds (60 s); every retry would meet it as a write
    // conflict until then. Killing it is safe: if it committed already, nothing changes, and the lease read
    // below finds the group; if not, it aborts. (The attempt itself sends nothing more once it timed out:
    // `withTimeout`'s progress() throws, so `withTransaction` does not run its callback again.)
    if (this.abandoned) {
      const lsid = this.abandoned;
      await this.call(() => this.client.db("admin").command({ killSessions: [lsid] }));
      this.abandoned = null;
    }
    // Then the group may have landed although its attempt failed here (its answer was lost): it is there exactly
    // once, and acknowledged without writing (DV-124).
    if (retry) {
      const lease = await this.call(() => this.meta.findOne({ _id: "lease" }));
      if (retriedGroupLanded(lease && { epoch: Number(lease.epoch), maxTs: lease.maxTs }, this.epoch, top)) return;
    }
    const session = this.client.startSession();
    try {
      await this.call((progress) =>
        session.withTransaction(
          async () => {
            progress();
            // The fence first: nothing of the group commits unless the lease still carries our epoch. A
            // concurrent takeover makes this a write conflict (retried by withTransaction, then refused here).
            // It also refuses a group that is there already (maxTs reached its top under our epoch): an earlier
            // attempt's COMMIT that landed after the lease read above (STUDY-25 L4; MongoDB has no unique key
            // on the rows to refuse it). The bootstrap writes at ts 0 (STUDY-133 §5.2), which a new store's
            // lease already records.
            const f = await this.meta.updateOne(
              { _id: "lease", epoch: this.epoch, maxTs: top === 0n ? { $lte: 0n } : { $lt: top } },
              { $set: { maxTs: top } },
              { session },
            );
            if (f.matchedCount !== 1) {
              const lease = await this.meta.findOne({ _id: "lease" }, { session });
              if (lease && Number(lease.epoch) === this.epoch && (lease.maxTs as bigint) >= top)
                throw new UnsureCommitError(
                  `a retried flush (ts ≤ ${top}) found the lease's durable prefix at ${lease.maxTs}: an earlier attempt committed it`,
                );
              throw new LeaseLostError();
            }
            progress();
            if (docs.length) await this.docs.insertMany(docs, { session, ordered: false });
            progress();
            if (idx.length) await this.idx.insertMany(idx, { session, ordered: false });
            progress(); // COMMIT
          },
          { writeConcern: { w: "majority", j: true } },
        ),
      );
    } catch (e) {
      // Not ended: on a store that does not answer, ending the session (which aborts its transaction) would
      // wait too, and an ended session's id goes back to the driver's pool, to be reused by later calls that
      // the retry's killSessions would then hit. The retry ends its transaction instead.
      this.abandoned = session.id ?? null;
      throw e;
    }
    await session.endSession();
  }

  private latest(index: IndexId, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean) {
    return scanLatest(
      async (p) => {
        const rows = await this.read(() =>
          this.idx
            .find(
              { x: index, k: { $gte: hex(p.lo), $lt: hex(p.hi) }, ts: { $lte: ts } },
              { projection: { _id: 0, k: 1, ts: 1, d: 1 } },
            )
            .sort(desc ? { k: -1, ts: -1 } : { k: 1, ts: -1 })
            .limit(p.n)
            .toArray(),
        );
        return rows.map((r) => ({
          key: Buffer.from(r.k as string, "hex"),
          ts: r.ts as bigint,
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

  /**
   * The range's newest entry per key at `ts`, then every entry's document at the entry's own ts in one round
   * trip (Convex's exact-ts join, DV-67 reversed). A missing one rejects (PERSIST-01 C15).
   */
  async scan(
    table: TabletId,
    index: IndexId,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: bigint,
    limit: number,
    desc: boolean,
  ) {
    const entries = await this.latest(index, lo, hi, ts, limit, desc);
    if (!entries.length) return [];
    const rows = await this.read(() =>
      this.docs
        .find(
          { t: table, $or: entries.map((e) => ({ i: e.id, ts: e.ts })) },
          { projection: { _id: 0, i: 1, ts: 1, j: 1 } },
        )
        .toArray(),
    );
    const byKey = new Map(rows.map((r) => [`${r.i}\u0000${r.ts}`, r]));
    return entries.map((e): IndexedDoc => {
      const r = byKey.get(`${e.id}\u0000${e.ts}`);
      if (!r || r.j === null) throw new DanglingReferenceError(index, e.id, e.ts, !!r);
      return { id: e.id, ts: e.ts, json: r.j };
    });
  }

  async get(table: TabletId, id: InternalId, ts: bigint): Promise<DocVersion> {
    const r = await this.read(() =>
      this.docs.findOne({ t: table, i: id, ts: { $lte: ts } }, { sort: { ts: -1 }, projection: { j: 1, ts: 1 } }),
    );
    return r && r.j !== null ? { json: r.j, ts: BigInt(r.ts) } : null;
  }

  async getVersions(table: TabletId, ids: string[], ts: bigint) {
    const found = new Map<string, { json: string | null; ts: bigint }>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += VERSIONS_CHUNK) {
      const rows = await this.read(() =>
        this.docs
          .aggregate<{ _id: string; ts: bigint; j: string | null }>([
            { $match: { t: table, i: { $in: unique.slice(i, i + VERSIONS_CHUNK) }, ts: { $lte: ts } } },
            { $sort: { i: 1, ts: -1 } },
            { $group: { _id: "$i", ts: { $first: "$ts" }, j: { $first: "$j" } } },
          ])
          .toArray(),
      );
      for (const r of rows) found.set(r._id, { json: r.j, ts: BigInt(r.ts) });
    }
    return versionsInOrder(ids, found);
  }

  /** PERSIST-01 C12, the document log by ts. */
  async readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): Promise<DocLogRow[]> {
    if (limit <= 0) return [];
    return this.read(async (progress) => {
      const lease = await this.metaMajority.findOne({ _id: "lease" });
      progress();
      const durable = (lease?.maxTs as bigint | undefined) ?? (await this.metaMajority.findOne({ _id: "commit" }))?.ts;
      progress();
      const hi = durable !== undefined && durable < upToTs ? (durable as bigint) : upToTs;
      if (hi <= afterTs) return [];
      const out: DocLogRow[] = [];
      let commits = 0;
      let lastTs = -1n;
      const cursor = this.docsMajority
        .find({ ts: { $gt: afterTs, $lte: hi } }, { projection: { _id: 0, t: 1, i: 1, ts: 1, j: 1, p: 1 } })
        .sort({ ts: 1 })
        .batchSize(Math.min(Math.max(limit * 4 + 1, 101), 10_000));
      try {
        for await (const r of cursor) {
          progress();
          if (r.ts !== lastTs) {
            if (commits === limit) break;
            commits++;
            lastTs = r.ts;
          }
          out.push({ ts: r.ts, table: r.t, id: r.i, deleted: r.j === null, prevTs: r.p });
        }
      } finally {
        await cursor.close();
      }
      return out;
    });
  }

  /** Refused unless the lease carries our epoch (a plain read: see the header). */
  private async assertEpoch() {
    const lease = await this.read(() => this.meta.findOne({ _id: "lease" }));
    if (!this.epoch || lease === null || Number(lease.epoch) !== this.epoch) throw new LeaseLostError();
  }

  /** PERSIST-01 C17: index rows at their own ts, each replacing a row of the same key and ts (an upsert). */
  async writeIndexEntries(entries: IndexEntryAt[]) {
    if (!entries.length) return;
    await this.assertEpoch();
    await this.call(() =>
      this.idx.bulkWrite(
        entries.map((e) => {
          const row: IdxRow = { x: e.index, k: hex(e.key), ts: e.ts, tb: e.table, d: e.id };
          return { replaceOne: { filter: { x: row.x, k: row.k, ts: row.ts }, replacement: row, upsert: true } };
        }),
        { ordered: false, writeConcern: { w: "majority" } },
      ),
    );
  }

  /** PERSIST-01 C13. */
  async pruneIndexes(entries: IndexPrune[]) {
    if (!entries.length) return 0;
    await this.assertEpoch();
    const r = await this.call(() =>
      this.idx.bulkWrite(
        entries.map((e) => ({ deleteMany: { filter: { x: e.index, k: hex(e.key), ts: { $lte: e.ts } } } })),
        { ordered: false, writeConcern: { w: "majority" } },
      ),
    );
    return r.deletedCount;
  }

  async pruneDocuments(entries: DocPrune[]) {
    if (!entries.length) return 0;
    await this.assertEpoch();
    const r = await this.call(() =>
      this.docs.bulkWrite(
        entries.map((e) => ({ deleteMany: { filter: { t: e.table, i: e.id, ts: { $lte: e.ts } } } })),
        { ordered: false, writeConcern: { w: "majority" } },
      ),
    );
    return r.deletedCount;
  }

  /** PERSIST-01 C14. */
  async getGlobal(key: string): Promise<unknown> {
    const d = await this.read(() => this.globals.findOne({ _id: key }));
    return d ? JSON.parse(d.v) : null;
  }

  async setGlobal(key: string, value: unknown) {
    await this.assertEpoch();
    await this.call(() =>
      this.globals.updateOne(
        { _id: key },
        { $set: { v: JSON.stringify(value) } },
        { upsert: true, writeConcern: { w: "majority" } },
      ),
    );
  }

  async auditRowCount() {
    const [docs, idx] = await this.read(() => Promise.all([this.docs.countDocuments({}), this.idx.countDocuments({})]));
    return { docs: Number(docs), idx: Number(idx) };
  }

  /** The durable prefix (PERSIST-01 C5/C7): the lease document's maxTs, which every fenced flush sets; for a
   *  store never leased, the old commit marker. */
  maxTs(): Promise<bigint> {
    return this.read(async (progress) => {
      const lease = await this.meta.findOne({ _id: "lease" });
      if (lease) return BigInt(lease.maxTs);
      progress();
      return BigInt((await this.meta.findOne({ _id: "commit" }))?.ts ?? 0);
    });
  }

  async auditLiveDocs(table: TabletId, ts: bigint) {
    const [r] = await this.read(() =>
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
    return Number(r?.n ?? 0);
  }

  async auditRowsAt(ts: bigint) {
    const [docs, idx] = await this.read(() =>
      Promise.all([this.docs.countDocuments({ ts }), this.idx.countDocuments({ ts })]),
    );
    return { docs: Number(docs), idx: Number(idx) };
  }

  /** Closes the client; on a database that does not answer, gives up waiting after one timeout. */
  async close() {
    await this.call(() => this.client.close());
  }
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(MongoPersistence);

/** PERSIST-01 C16's answer in the ids' order (duplicates included), from the rows found per id. */
function versionsInOrder(ids: string[], found: Map<string, { json: string | null; ts: bigint }>) {
  return ids.map((id) => {
    const v = found.get(id);
    return v && v.json !== null ? { json: v.json, ts: v.ts } : null;
  });
}

/** Ids per `getVersions` statement: one round trip each, within every store's parameter limits. */
const VERSIONS_CHUNK = 1000;
