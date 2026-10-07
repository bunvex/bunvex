// MongoDB (optional peer: `mongodb`) in the analogue of Convex's Postgres layout (STUDY-133 §5.6, Q6, DV-416;
// Convex has no MongoDB driver, so a store moves to or from Convex only by export and import):
//
//   documents            {_id: {ts, table_id, id}, json_value, deleted, prev_ts} — Convex's primary key as the _id;
//                        ids are 16-byte BinData (fixed length, so BinData's length-first order is byte order),
//                        timestamps int64 (`Long`, read back as `bigint`), json_value the JSON text or null
//   indexes              {_id: {index_id, key_prefix, key_sha256, ts}, key_suffix, deleted, table_id, document_id}
//                        — Convex's key split: key_prefix is the first 2500 bytes as lowercase hex (BinData would
//                        order by length first; hex strings order as the bytes do), key_suffix the rest
//                        (BinData), key_sha256 the SHA-256 of the whole key (hex)
//   persistence_globals  {_id: key, json_value}
//   leases               {_id: 1, ts}                Convex's lease row, inserted with ts 0 on every open
//   read_only            {_id: 1}                    Convex's flag
//
// A group is flushed in ONE multi-document transaction (w: majority, journaled), so a group is durable as a whole
// and the newest `_id.ts` of `documents` is the durable prefix (Convex's `max_ts`). Transactions need a replica
// set (a single-node one is enough): the driver refuses a standalone server (owner's decision, 2026-09-30).
//
// Single writer (PERSIST-01 C7), as Convex's lease by analogy (owner, 2026-10-05, Q3: "MongoDB follows"): the
// `leases` document's ts is its holder's start, in wall-clock nanoseconds. A start takes it at once if its ts is
// newer (the newest process wins); the previous holder fails its next write with `LeaseLostError`. Each flush's
// transaction ends with a write of the lease document that matches only our ts (Convex's `FOR SHARE` read at the
// end of the transaction): a takeover's update waits for that transaction, or makes it abort on a write conflict.
//
// Layout and read-only flag (PERSIST-01 C10): no layout record (DV-418); the open checks that the documents it
// finds in `documents` and `indexes` have this layout's fields, before writing anything, and refuses a read-only
// store. Retention (PERSIST-01 C12–C14, STUDY-33): the document log reads `documents` by `_id.ts`; prunes are
// `ts <= X` deletes per key, one unordered bulk write per batch, after a lease check (a takeover in between can
// let one batch through, which deletes only versions superseded below a window the old holder had published).
//
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
// keeps the group for that retry. Before re-running a group, the driver ends the failed attempt's session,
// checks that the lease is still ours and whether the group's rows are there: a group an earlier attempt did
// commit is acknowledged without writing (DV-124). One that lands after that read hits the unique `_id`:
// `UnsureCommitError` (fail-stop, as Convex's duplicate key).
import {
  checkStoreTables,
  DanglingReferenceError,
  DatabaseTimeoutError,
  type DocLogRow,
  type DocPrune,
  type DocVersion,
  type DocWrite,
  decodeGlobal,
  encodeGlobal,
  type IndexEntryAt,
  type IndexedDoc,
  type IndexId,
  type IndexPrune,
  type IndexWrite,
  type InternalId,
  internalIdBytes,
  internalIdString,
  keySha256Hex,
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
  retryOnce,
  type SplitRow,
  scanLatest,
  splitKey,
  splitPages,
  type TabletId,
  UnsureCommitError,
  wallClockNs,
  withTimeout,
} from "@bunvex/core/persistence";
import type { Collection, Db, MongoClient } from "mongodb";
import { loadPeer } from "./peer.ts";

/** A 16-byte id as stored (BinData, subtype 0); the driver accepts a Buffer and returns a `Binary`. */
type Bin = Buffer | { buffer: Uint8Array };
type DocKey = { ts: bigint; table_id: Bin; id: Bin };
type DocRow = { _id: DocKey; json_value: string | null; deleted: boolean; prev_ts: bigint | null };
type IdxKey = { index_id: Bin; key_prefix: string; key_sha256: string; ts: bigint };
type IdxRow = {
  _id: IdxKey;
  key_suffix: Bin | null;
  deleted: boolean;
  table_id: Bin | null;
  document_id: Bin | null;
};
type LeaseDoc = { _id: number; ts: bigint };

const hex = (k: Uint8Array) => Buffer.from(k.buffer, k.byteOffset, k.byteLength).toString("hex");
/** An internal id's 16 bytes, as BinData. */
const bin = (id: string) => Buffer.from(internalIdBytes(id));
/** A stored BinData's bytes. */
const bytesOf = (b: Bin): Uint8Array => (b instanceof Uint8Array ? b : b.buffer);
/** A stored id read back: its internal id string. */
const idOf = (b: Bin) => internalIdString(bytesOf(b));
/** A document's `_id`: its fields always in this order, so an `_id` equality matches. */
const docKey = (ts: bigint, table: TabletId, id: InternalId): DocKey => ({ ts, table_id: bin(table), id: bin(id) });

/** One `indexes` row: a tombstone has null `table_id` and `document_id`, as Convex writes it. */
function indexRow(e: IndexWrite, ts: bigint): IdxRow {
  const k = splitKey(e.key);
  return {
    _id: { index_id: bin(e.index), key_prefix: hex(k.prefix), key_sha256: keySha256Hex(e.key), ts },
    key_suffix: k.suffix ? Buffer.from(k.suffix) : null,
    deleted: e.id === null,
    table_id: e.id === null ? null : bin(e.table!),
    document_id: e.id === null ? null : bin(e.id),
  };
}

const STORE = "this MongoDB database";
/** This layout's fields: what the documents an existing store holds must have (C10). */
const FIELDS = {
  documents: ["_id", "json_value", "deleted", "prev_ts"],
  indexes: ["_id", "key_suffix", "deleted", "table_id", "document_id"],
};

// The collections' secondary indexes, built when missing. `indexes` has one per scan direction, each giving a
// key's versions newest first (the `_id` index orders a key's versions oldest first).
const BY_TABLE_AND_ID = { "_id.table_id": 1, "_id.id": 1, "_id.ts": -1 } as const;
const BY_TS = { "_id.ts": 1, "_id.table_id": 1, "_id.id": 1 } as const;
const BY_KEY_ASC = { "_id.index_id": 1, "_id.key_prefix": 1, "_id.key_sha256": 1, "_id.ts": -1 } as const;
const BY_KEY_DESC = { "_id.index_id": 1, "_id.key_prefix": -1, "_id.key_sha256": -1, "_id.ts": -1 } as const;

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
  /** PERSIST-01 C7 as Convex's lease, by analogy: the newest process wins (DV-413, DV-416). */
  readonly leaseScope = "newest";
  private docsBuf: DocRow[] = [];
  private idxBuf: IdxRow[] = [];
  /** The highest ts applied since the last flush (the group's top). */
  private top = 0n;
  /** Our lease's ts (our start, in wall-clock nanoseconds), 0n when we hold none. */
  private leaseTs = 0n;
  /** Leases taken by this handle, for `LeaseAcquire.epoch`. */
  private acquired = 0;
  /** The TTL the engine renews by (TTL/3): a lease check is bounded by a quarter of it (C8). */
  private ttlMs = 5000;
  private constructor(
    private client: MongoClient,
    private db: Db,
    private docs: Collection<DocRow>,
    private idx: Collection<IdxRow>,
    private leases: Collection<LeaseDoc>,
    private readOnly: Collection<{ _id: number }>,
    /** This instance's appName: a takeover held up by a writer paused inside its flush ends the other bunvex
     *  processes' open transactions, never ours. */
    private app: string,
    /** The client-side timeout of one round trip (STUDY-25 L3). */
    private timeoutMs: number,
    /** `documents` read at majority (PERSIST-01 C12): a log reader never sees a group that a failover could
     *  still roll back. */
    private docsMajority: Collection<DocRow>,
    private globals: Collection<{ _id: string; json_value: string }>,
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
          const readOnly = db.collection<{ _id: number }>("read_only");
          await MongoPersistence.checkStore(docs, idx, readOnly, opts, progress);
          // Indexes only when missing (STUDY-25 L1): every open should not take the locks of index builds.
          const want: [Collection<any>, Record<string, 1 | -1>][] = [
            [docs, BY_TABLE_AND_ID],
            [docs, BY_TS], // the document log (PERSIST-01 C12)
            [idx, BY_KEY_ASC],
            [idx, BY_KEY_DESC],
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
          // The lease document, which Convex inserts on every open (only when missing, so an open writes
          // nothing otherwise).
          const leases = db.collection<LeaseDoc>("leases");
          if (!(await leases.findOne({ _id: 1 }))) {
            progress();
            await leases.insertOne({ _id: 1, ts: 0n }, { writeConcern: { w: "majority" } }).catch((e) => {
              if ((e as { code?: number }).code !== 11000) throw e; // a concurrent open inserted it
            });
          }
          progress();
          const majority = { readConcern: { level: "majority" as const } };
          return new MongoPersistence(
            client,
            db,
            docs,
            idx,
            leases,
            readOnly,
            app,
            timeoutMs,
            db.collection<DocRow>("documents", majority),
            db.collection<{ _id: string; json_value: string }>("persistence_globals", majority),
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
   * PERSIST-01 C10, before anything is written: the documents found in `documents` and `indexes` must have this
   * layout's fields (an older bunvex layout or a stranger's is refused, untouched), and a store marked read-only
   * opens only with `allowReadOnly`. Refusing needs no lease: nothing is written.
   */
  private static async checkStore(
    docs: Collection<DocRow>,
    idx: Collection<IdxRow>,
    readOnly: Collection<{ _id: number }>,
    opts: OpenOptions,
    progress: () => void,
  ) {
    const found: Record<string, string[]> = {};
    for (const [name, c] of [
      ["documents", docs],
      ["indexes", idx],
    ] as const) {
      const one = await (c as Collection<any>).findOne({});
      progress();
      if (one) found[name] = Object.keys(one);
    }
    checkStoreTables(STORE, found, FIELDS, ["collection", "fields"]);
    const ro = await readOnly.findOne({});
    progress();
    if (ro && !opts.allowReadOnly) throw new ReadOnlyError(STORE);
  }

  /** Convex's `set_read_only`: no lease needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    await this.call(async () => {
      if (readOnly)
        await this.readOnly.updateOne(
          { _id: 1 },
          { $set: { _id: 1 } },
          { upsert: true, writeConcern: { w: "majority" } },
        );
      else await this.readOnly.deleteMany({}, { writeConcern: { w: "majority" } });
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

  /**
   * Convex's `Lease::acquire`, by analogy: the lease document takes our start ts if it is newer than the one there
   * (the newest process wins at once); otherwise another process started later, and holds it. There is no TTL.
   *
   * A writer inside a flush has written the lease document in its open transaction: our update waits for it.
   * A writer paused there (stopped, frozen) keeps it open until the server's transaction lifetime runs out, so
   * after a short wait the open transactions of other bunvex processes are ended: the paused writer's group
   * aborts, and it was never acknowledged.
   */
  acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    this.ttlMs = opts.ttlMs;
    return this.call(async (progress) => {
      for (let attempt = 0; ; attempt++) {
        const ts = wallClockNs();
        let won: boolean;
        try {
          const r = await this.leases.updateOne(
            { _id: 1, ts: { $lt: ts } },
            { $set: { ts } },
            { maxTimeMS: 1000, writeConcern: { w: "majority" } },
          );
          progress();
          won = r.matchedCount === 1;
        } catch (e) {
          if ((e as { code?: number }).code !== 50 || attempt >= 3) throw e; // 50: MaxTimeMSExpired
          await this.killOtherWriters();
          progress();
          continue;
        }
        if (!won) {
          const l = await this.leases.findOne({ _id: 1 });
          return { heldBy: `a process that took the lease later (lease ts ${l?.ts ?? "none"})`, expiresInMs: null };
        }
        this.leaseTs = ts;
        return { epoch: ++this.acquired };
      }
    });
  }

  /** End the open transactions of other bunvex processes (a writer paused inside its flush). */
  private async killOtherWriters() {
    const admin = this.client.db("admin");
    const ops = await admin
      .aggregate([
        { $currentOp: { allUsers: true, idleSessions: true } },
        { $match: { appName: { $regex: "^bunvex-", $ne: this.app }, transaction: { $exists: true } } },
      ])
      .toArray();
    const lsids = ops.map((o) => o.lsid).filter(Boolean);
    if (lsids.length) await admin.command({ killSessions: lsids }).catch(() => {});
  }

  /** Convex's `advisory_lease_check`: `LeaseLostError` once another process took the lease. No TTL to extend. */
  async renewLease() {
    const l = await this.call(() => this.leases.findOne({ _id: 1 }), renewTimeoutMs(this.timeoutMs, this.ttlMs));
    if (!l || l.ts !== this.leaseTs) throw new LeaseLostError();
  }

  /** As Convex: a lease is never handed back; the next process takes it at once. This one stops writing. */
  async releaseLease() {
    this.leaseTs = 0n;
  }

  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.top = ts;
    for (const d of docs)
      this.docsBuf.push({
        _id: docKey(ts, d.table, d.id),
        json_value: d.json,
        deleted: d.json === null,
        prev_ts: d.prevTs,
      });
    for (const e of idx) this.idxBuf.push(indexRow(e, ts));
  }

  async flush() {
    if (!this.docsBuf.length && !this.idxBuf.length) return;
    if (!this.leaseTs) throw new Error("flush without the store's lease (PERSIST-01 C7): acquireLease first");
    const docs = this.docsBuf;
    const idx = this.idxBuf;
    const top = this.top;
    this.docsBuf = [];
    this.idxBuf = [];
    const retry = this.retrying;
    try {
      await this.flushGroup(docs, idx, top, retry);
      this.retrying = false;
    } catch (e) {
      // Keep the group: the committer retries a transient failure with the same rows at the same timestamps.
      this.docsBuf = docs.concat(this.docsBuf);
      this.idxBuf = idx.concat(this.idxBuf);
      this.retrying = true;
      // 11000 on a retry: the group is there already, so an earlier attempt of it did commit.
      if (retry && (e as { code?: number }).code === 11000)
        throw new UnsureCommitError(
          `a retried flush (ts ≤ ${top}) found its rows already written by an earlier attempt`,
          { cause: e },
        );
      throw e;
    }
  }

  /** Set once a flush failed and kept its group: the next flush is a retry of it. */
  private retrying = false;

  /** The session of the last failed flush: its transaction may still be open on the server. */
  private abandoned: unknown = null;

  /**
   * Whether the group up to `top` committed (PERSIST-01 C9, DV-124): a group is one transaction, so its rows at
   * `top` are there exactly when it did. Only while the lease is still ours: otherwise `LeaseLostError`.
   */
  private async landed(top: bigint) {
    const [lease, row] = await this.call(() =>
      Promise.all([this.leases.findOne({ _id: 1 }), this.docs.findOne({ "_id.ts": top }, { projection: { _id: 1 } })]),
    );
    if (!lease || lease.ts !== this.leaseTs) throw new LeaseLostError();
    return row !== null;
  }

  private async flushGroup(docs: DocRow[], idx: IdxRow[], top: bigint, retry: boolean) {
    // A retry: end the failed attempt's transaction first. A transaction belongs to its session, not to a
    // connection, so the server keeps it open after the client dropped the connection, for up to
    // transactionLifetimeLimitSeconds (60 s); every retry would meet it as a write conflict until then. Killing
    // it is safe: if it committed already, nothing changes, and the check below finds the group; if not, it
    // aborts. (The attempt itself sends nothing more once it timed out: `withTimeout`'s progress() throws, so
    // `withTransaction` does not run its callback again.)
    if (this.abandoned) {
      const lsid = this.abandoned;
      await this.call(() => this.client.db("admin").command({ killSessions: [lsid] }));
      this.abandoned = null;
    }
    // Then the group may have landed although its attempt failed here (its answer was lost): it is there exactly
    // once, and acknowledged without writing (DV-124).
    if (retry && (await this.landed(top))) return;
    const session = this.client.startSession();
    try {
      await this.call((progress) =>
        session.withTransaction(
          async () => {
            progress();
            if (docs.length) await this.docs.insertMany(docs, { session, ordered: false });
            progress();
            if (idx.length) await this.idx.insertMany(idx, { session, ordered: false });
            progress();
            // The fence, at the end of the transaction as Convex's `lease_precond`: a write of the lease
            // document that matches only our ts. A takeover's update then waits for this transaction, or makes
            // it abort on a write conflict; one that came first leaves nothing to match, and nothing commits.
            const f = await this.leases.updateOne(
              { _id: 1, ts: this.leaseTs },
              { $set: { ts: this.leaseTs } },
              { session },
            );
            if (f.matchedCount !== 1) throw new LeaseLostError();
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

  /** The rows of `index` whose key prefix is in the bounds, at `ts`, in key order, each key's newest first. */
  private splitSource(index: IndexId, ts: bigint, desc: boolean) {
    const ix = bin(index);
    const toRow = (r: IdxRow): SplitRow => ({
      prefix: Buffer.from(r._id.key_prefix, "hex"),
      suffix: r.key_suffix === null ? null : bytesOf(r.key_suffix),
      ts: r._id.ts,
      deleted: r.deleted,
      id: r.document_id === null ? null : idOf(r.document_id),
    });
    return {
      page: async (b: { lo: Uint8Array; loStrict: boolean; hi: Uint8Array; hiInclusive: boolean; n: number }) =>
        (
          await this.read(() =>
            this.idx
              .find({
                "_id.index_id": ix,
                "_id.key_prefix": {
                  [b.loStrict ? "$gt" : "$gte"]: hex(b.lo),
                  [b.hiInclusive ? "$lte" : "$lt"]: hex(b.hi),
                },
                "_id.ts": { $lte: ts },
              })
              .sort(desc ? BY_KEY_DESC : BY_KEY_ASC)
              .hint(desc ? BY_KEY_DESC : BY_KEY_ASC)
              .limit(b.n)
              .toArray(),
          )
        ).map(toRow),
      group: async (prefix: Uint8Array) =>
        (
          await this.read(() =>
            this.idx.find({ "_id.index_id": ix, "_id.key_prefix": hex(prefix), "_id.ts": { $lte: ts } }).toArray(),
          )
        ).map(toRow),
    };
  }

  /**
   * The range's newest entry per key at `ts`, then every entry's document at the entry's own ts in one round
   * trip (Convex's exact-ts join). A missing one rejects (PERSIST-01 C15).
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
    const entries = await scanLatest(splitPages(this.splitSource(index, ts, desc), desc), lo, hi, limit, desc);
    if (!entries.length) return [];
    const rows = await this.read(() =>
      this.docs.find({ _id: { $in: entries.map((e) => docKey(e.ts, table, e.id)) } }).toArray(),
    );
    const byKey = new Map(rows.map((r) => [`${idOf(r._id.id)}\u0000${r._id.ts}`, r]));
    return entries.map((e): IndexedDoc => {
      const r = byKey.get(`${e.id}\u0000${e.ts}`);
      if (!r || r.deleted || r.json_value === null) throw new DanglingReferenceError(index, e.id, e.ts, !!r);
      return { id: e.id, ts: e.ts, json: r.json_value };
    });
  }

  async get(table: TabletId, id: InternalId, ts: bigint): Promise<DocVersion> {
    const r = await this.read(() =>
      this.docs.findOne(
        { "_id.table_id": bin(table), "_id.id": bin(id), "_id.ts": { $lte: ts } },
        { sort: { "_id.ts": -1 }, hint: BY_TABLE_AND_ID },
      ),
    );
    return r && !r.deleted && r.json_value !== null ? { json: r.json_value, ts: BigInt(r._id.ts) } : null;
  }

  async getVersions(table: TabletId, ids: string[], ts: bigint) {
    const found = new Map<string, { json: string | null; ts: bigint }>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += VERSIONS_CHUNK) {
      const rows = await this.read(() =>
        this.docs
          .aggregate<{ _id: Bin; ts: bigint; json_value: string | null; deleted: boolean }>([
            {
              $match: {
                "_id.table_id": bin(table),
                "_id.id": { $in: unique.slice(i, i + VERSIONS_CHUNK).map(bin) },
                "_id.ts": { $lte: ts },
              },
            },
            { $sort: { "_id.table_id": 1, "_id.id": 1, "_id.ts": -1 } },
            {
              $group: {
                _id: "$_id.id",
                ts: { $first: "$_id.ts" },
                json_value: { $first: "$json_value" },
                deleted: { $first: "$deleted" },
              },
            },
          ])
          .toArray(),
      );
      for (const r of rows) found.set(idOf(r._id), { json: r.deleted ? null : r.json_value, ts: BigInt(r.ts) });
    }
    return versionsInOrder(ids, found);
  }

  /** PERSIST-01 C12, the document log by ts: whole groups (each one transaction), read at majority. */
  async readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): Promise<DocLogRow[]> {
    if (limit <= 0 || upToTs <= afterTs) return [];
    return this.read(async (progress) => {
      const out: DocLogRow[] = [];
      let commits = 0;
      let lastTs = -1n;
      const cursor = this.docsMajority
        .find({ "_id.ts": { $gt: afterTs, $lte: upToTs } }, { projection: { json_value: 0 } })
        .sort(BY_TS)
        .hint(BY_TS)
        .batchSize(Math.min(Math.max(limit * 4 + 1, 101), 10_000));
      try {
        for await (const r of cursor) {
          progress();
          if (r._id.ts !== lastTs) {
            if (commits === limit) break;
            commits++;
            lastTs = r._id.ts;
          }
          out.push({
            ts: r._id.ts,
            table: idOf(r._id.table_id),
            id: idOf(r._id.id),
            deleted: r.deleted,
            prevTs: r.prev_ts,
          });
        }
      } finally {
        await cursor.close();
      }
      return out;
    });
  }

  /** Refused unless the lease document carries our ts (a plain read, Convex's advisory check). */
  private async assertLease() {
    const lease = await this.read(() => this.leases.findOne({ _id: 1 }));
    if (!this.leaseTs || lease === null || lease.ts !== this.leaseTs) throw new LeaseLostError();
  }

  /** PERSIST-01 C17: index rows at their own ts, each replacing a row of the same key and ts (Convex's
   *  `insert_overwrite_index`, an upsert by `_id`). */
  async writeIndexEntries(entries: IndexEntryAt[]) {
    if (!entries.length) return;
    await this.assertLease();
    await this.call(() =>
      this.idx.bulkWrite(
        entries.map((e) => {
          const row = indexRow(e, e.ts);
          return { replaceOne: { filter: { _id: row._id }, replacement: row, upsert: true } };
        }),
        { ordered: false, writeConcern: { w: "majority" } },
      ),
    );
  }

  /** PERSIST-01 C13: Convex's `delete_index`, by `(index_id, key_prefix, key_sha256)`. */
  async pruneIndexes(entries: IndexPrune[]) {
    if (!entries.length) return 0;
    await this.assertLease();
    const r = await this.call(() =>
      this.idx.bulkWrite(
        entries.map((e) => ({
          deleteMany: {
            filter: {
              "_id.index_id": bin(e.index),
              "_id.key_prefix": hex(splitKey(e.key).prefix),
              "_id.key_sha256": keySha256Hex(e.key),
              "_id.ts": { $lte: e.ts },
            },
          },
        })),
        { ordered: false, writeConcern: { w: "majority" } },
      ),
    );
    return r.deletedCount;
  }

  async pruneDocuments(entries: DocPrune[]) {
    if (!entries.length) return 0;
    await this.assertLease();
    const r = await this.call(() =>
      this.docs.bulkWrite(
        entries.map((e) => ({
          deleteMany: { filter: { "_id.table_id": bin(e.table), "_id.id": bin(e.id), "_id.ts": { $lte: e.ts } } },
        })),
        { ordered: false, writeConcern: { w: "majority" } },
      ),
    );
    return r.deletedCount;
  }

  /** PERSIST-01 C14. */
  async getGlobal(key: string): Promise<unknown> {
    const d = await this.read(() => this.globals.findOne({ _id: key }));
    return d ? decodeGlobal(d.json_value) : null;
  }

  async setGlobal(key: string, value: unknown) {
    await this.assertLease();
    await this.call(() =>
      this.globals.updateOne(
        { _id: key },
        { $set: { json_value: encodeGlobal(value) } },
        { upsert: true, writeConcern: { w: "majority" } },
      ),
    );
  }

  async auditRowCount() {
    const [docs, idx] = await this.read(() => Promise.all([this.docs.countDocuments({}), this.idx.countDocuments({})]));
    return { docs: Number(docs), idx: Number(idx) };
  }

  /** The durable prefix (PERSIST-01 C5): the newest `_id.ts` in `documents`, as Convex's `max_ts` (a group is
   *  one transaction, so it is whole). */
  maxTs(): Promise<bigint> {
    return this.read(async () => {
      const [r] = await this.docs
        .find({}, { projection: { _id: 1 } })
        .sort({ "_id.ts": -1 })
        .hint(BY_TS)
        .limit(1)
        .toArray();
      return r ? BigInt(r._id.ts) : 0n;
    });
  }

  async auditLiveDocs(table: TabletId, ts: bigint) {
    const [r] = await this.read(() =>
      this.docs
        .aggregate<{ n: number }>([
          { $match: { "_id.table_id": bin(table), "_id.ts": { $lte: ts } } },
          { $sort: { "_id.id": 1, "_id.ts": -1 } },
          { $group: { _id: "$_id.id", deleted: { $first: "$deleted" } } },
          { $match: { deleted: false } },
          { $count: "n" },
        ])
        .toArray(),
    );
    return Number(r?.n ?? 0);
  }

  async auditRowsAt(ts: bigint) {
    const [docs, idx] = await this.read(() =>
      Promise.all([this.docs.countDocuments({ "_id.ts": ts }), this.idx.countDocuments({ "_id.ts": ts })]),
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
