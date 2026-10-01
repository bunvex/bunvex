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
import {
  type DocWrite,
  groupLog,
  type IndexWrite,
  type Lease,
  type LeaseAcquire,
  LeaseLostError,
  type LogCommit,
  type LogRow,
  type Persistence,
  type ScanDocs,
  scanLatest,
} from "@bunvex/core/persistence";
import type { Collection, Db, MongoClient } from "mongodb";
import { loadPeer } from "./peer.ts";

type DocRow = { t: number; i: string; ts: number; j: string | null };
type IdxRow = { x: number; k: string; ts: number; d: string | null };

const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");

type LeaseDoc = {
  _id: string;
  epoch: number;
  holder: string | null;
  app: string | null;
  expiresAt: Date;
  maxTs: number;
};

export class MongoPersistence implements Persistence, ScanDocs, Lease {
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
    /** `indexes` and `meta` read at majority (PERSIST-01 C11): a log reader never sees a group that a
     *  failover could still roll back. */
    private idxMajority: Collection<IdxRow>,
    private metaMajority: Collection<any>,
  ) {}

  static async open(url: string, opts: { fresh?: boolean; pool?: number } = {}) {
    const { MongoClient: Client } = await loadPeer<typeof import("mongodb")>("mongodb", "mongodb");
    const app = `bunvex-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
    const client = new Client(url, { maxPoolSize: opts.pool ?? 16, appName: app });
    await client.connect();
    const db: Db = client.db();
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName) {
      await client.close();
      throw new Error(
        "bunvex needs MongoDB as a replica set (a single-node one is enough: start mongod with --replSet and run rs.initiate()); a standalone server cannot run the transactions a flush needs",
      );
    }
    if (opts.fresh) await db.dropDatabase();
    const docs = db.collection<DocRow>("documents");
    const idx = db.collection<IdxRow>("indexes");
    const meta = db.collection<any>("meta");
    // Indexes only when missing (STUDY-25 L1): every open should not take the locks of index builds.
    const want: [Collection<any>, Record<string, 1 | -1>][] = [
      [docs, { t: 1, i: 1, ts: -1 }],
      [idx, { x: 1, k: 1, ts: -1 }],
      [idx, { x: 1, k: -1, ts: -1 }], // descending scans keep "newest version first" per key
      [idx, { ts: 1 }], // the log by ts (PERSIST-01 C11)
    ];
    for (const [c, key] of want) {
      const have = await c
        .listIndexes()
        .toArray()
        .catch(() => []);
      if (!have.some((i) => JSON.stringify(i.key) === JSON.stringify(key))) await c.createIndex(key);
    }
    const majority = { readConcern: { level: "majority" as const } };
    return new MongoPersistence(
      client,
      docs,
      idx,
      meta,
      app,
      db.collection<IdxRow>("indexes", majority),
      db.collection<any>("meta", majority),
    );
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    // A store without a lease document: its durable prefix is the old commit marker, else the newest row.
    if (!(await this.meta.findOne({ _id: "lease" }))) {
      const marker = (await this.meta.findOne({ _id: "commit" }))?.ts as number | undefined;
      const newest = async (c: Collection<any>) =>
        ((
          await c
            .find({}, { projection: { ts: 1 } })
            .sort({ ts: -1 })
            .limit(1)
            .toArray()
        )[0]?.ts as number) ?? 0;
      const maxTs = marker ?? Math.max(await newest(this.docs), await newest(this.idx));
      await this.meta
        .insertOne({ _id: "lease", epoch: 0, holder: null, app: null, expiresAt: new Date(0), maxTs })
        .catch((e) => {
          if ((e as { code?: number }).code !== 11000) throw e; // a concurrent first acquire created it
        });
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
        // Expired, yet still in a transaction on the lease: a paused (stopped, frozen) process mid-flush.
        // End its sessions; its uncommitted group aborts, and it was never acknowledged.
        if (s?.expired && s.app) await this.killSessionsOf(s.app as string);
        continue;
      }
      if (won) {
        this.epoch = won.epoch;
        this.ttlMs = opts.ttlMs;
        // Rows above the durable prefix are the remains of an interrupted flush of an earlier version
        // (commit-marker stores): delete them now that no one else can be writing.
        await this.docs.deleteMany({ ts: { $gt: won.maxTs } });
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

  async renewLease() {
    const r = await this.meta.updateOne({ _id: "lease", epoch: this.epoch }, [
      { $set: { expiresAt: { $add: ["$$NOW", this.ttlMs] } } },
    ]);
    if (r.matchedCount !== 1) throw new LeaseLostError();
  }

  async releaseLease() {
    if (!this.epoch) return;
    await this.meta.updateOne({ _id: "lease", epoch: this.epoch }, { $set: { holder: null } });
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
    try {
      await session.withTransaction(
        async () => {
          // The fence first: nothing of the group commits unless the lease still carries our epoch. A
          // concurrent takeover makes this a write conflict (retried by withTransaction, then refused here).
          const f = await this.meta.updateOne(
            { _id: "lease", epoch: this.epoch },
            { $set: { maxTs: top } },
            { session },
          );
          if (f.matchedCount !== 1) throw new LeaseLostError();
          if (docs.length) await this.docs.insertMany(docs, { session, ordered: false });
          if (idx.length) await this.idx.insertMany(idx, { session, ordered: false });
        },
        { writeConcern: { w: "majority", j: true } },
      );
    } finally {
      await session.endSession();
    }
  }

  private latest(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    return scanLatest(
      async (p) => {
        const rows = await this.idx
          .find(
            { x: index, k: { $gte: hex(p.lo), $lt: hex(p.hi) }, ts: { $lte: ts } },
            { projection: { _id: 0, k: 1, d: 1 } },
          )
          .sort(desc ? { k: -1, ts: -1 } : { k: 1, ts: -1 })
          .limit(p.n)
          .toArray();
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
    const r = await this.docs.findOne(
      { t: table, i: id, ts: { $lte: ts } },
      { sort: { ts: -1 }, projection: { j: 1 } },
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
    const rows = await this.docs
      .aggregate<{ _id: string; j: string | null }>([
        { $match: { t: table, i: { $in: ids }, ts: { $lte: ts } } },
        { $sort: { i: 1, ts: -1 } },
        { $group: { _id: "$i", j: { $first: "$j" } } },
      ])
      .toArray();
    const byId = new Map(rows.map((r) => [r._id, r.j]));
    const out: string[] = [];
    for (const id of ids) {
      const j = byId.get(id);
      if (j) out.push(j);
    }
    return out;
  }

  /**
   * PERSIST-01 C11. The bound is the lease document's maxTs (the durable prefix, written in the same
   * transaction as each group; for a store never leased, the old commit marker). Rows come from the ts
   * index in order and are cut into commits; the read stops at the first row of commit `limit + 1`.
   */
  async readLog(afterTs: number, upToTs: number, limit: number): Promise<LogCommit[]> {
    if (limit <= 0) return [];
    const lease = await this.metaMajority.findOne({ _id: "lease" });
    const durable = (lease?.maxTs as number | undefined) ?? (await this.metaMajority.findOne({ _id: "commit" }))?.ts;
    const hi = Math.min(upToTs, durable ?? upToTs);
    if (hi <= afterTs) return [];
    const rows: LogRow[] = [];
    let commits = 0;
    let lastTs = -1;
    const cursor = this.idxMajority
      .find({ ts: { $gt: afterTs, $lte: hi } }, { projection: { _id: 0, x: 1, k: 1, ts: 1, d: 1 } })
      .sort({ ts: 1 })
      // Batches sized to the request: the driver's default getMore takes up to 16 MB, i.e. the whole rest of
      // the log, for the one row that tells us commit `limit` is complete.
      .batchSize(Math.min(Math.max(limit * 4 + 1, 101), 10_000));
    try {
      for await (const r of cursor) {
        if (r.ts !== lastTs) {
          if (commits === limit) break;
          commits++;
          lastTs = r.ts;
        }
        rows.push({ ts: r.ts, index: r.x, key: Buffer.from(r.k, "hex"), id: r.d });
      }
    } finally {
      await cursor.close();
    }
    if (!rows.length) return [];
    const [prev] = await this.idxMajority
      .find({ ts: { $lte: afterTs } }, { projection: { _id: 0, ts: 1 } })
      .sort({ ts: -1 })
      .limit(1)
      .toArray();
    return groupLog(rows, prev?.ts ?? 0);
  }

  /** The durable prefix (PERSIST-01 C5/C7): the lease document's maxTs, which every fenced flush sets; for a
   *  store never leased, the old commit marker. */
  async maxTs() {
    const lease = await this.meta.findOne({ _id: "lease" });
    if (lease) return lease.maxTs as number;
    return ((await this.meta.findOne({ _id: "commit" }))?.ts as number) ?? 0;
  }

  async auditLiveDocs(table: number, ts: number) {
    const [r] = await this.docs
      .aggregate<{ n: number }>([
        { $match: { t: table, ts: { $lte: ts } } },
        { $sort: { i: 1, ts: -1 } },
        { $group: { _id: "$i", j: { $first: "$j" } } },
        { $match: { j: { $ne: null } } },
        { $count: "n" },
      ])
      .toArray();
    return r?.n ?? 0;
  }

  async close() {
    await this.client.close();
  }
}
