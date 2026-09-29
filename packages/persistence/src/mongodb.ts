// MongoDB (optional peer: `mongodb`): the same two logical collections (documents, indexes), on a store that is not SQL and has
// no multi-collection atomicity outside transactions (which need a replica set). Two driver-local rules
// make it satisfy PERSIST-01:
//
//   C2 ordering — BinData compares by LENGTH first, which breaks byte order ("b" < "aa"). Keys are stored as
//      lowercase hex strings, whose (binary-collation) string order IS the byte order.
//   C4 atomicity — a COMMIT MARKER: a group's rows are written first, then `meta.commit.ts` with j:true. The
//      journal is sequential, so once the marker is journaled every row before it is too. maxTs() is the
//      marker; on open, rows above it (a flush interrupted by a crash) are deleted before any new commit
//      could reuse their ts.
import type { DocWrite, IndexWrite, Persistence, ScanDocs } from "@bunvex/core/persistence";
import type { Collection, Db, MongoClient } from "mongodb";
import { loadPeer } from "./peer.ts";

type DocRow = { t: number; i: string; ts: number; j: string | null };
type IdxRow = { x: number; k: string; ts: number; d: string | null };

const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");

export class MongoPersistence implements Persistence, ScanDocs {
  private docsBuf: DocRow[] = [];
  private idxBuf: IdxRow[] = [];
  private constructor(
    private client: MongoClient,
    private docs: Collection<DocRow>,
    private idx: Collection<IdxRow>,
    private meta: Collection<{ _id: string; ts: number }>,
    private marker: number,
  ) {}

  static async open(url: string, opts: { fresh?: boolean; pool?: number } = {}) {
    const { MongoClient: Client } = await loadPeer<typeof import("mongodb")>("mongodb", "mongodb");
    const client = new Client(url, { maxPoolSize: opts.pool ?? 16 });
    await client.connect();
    const db: Db = client.db();
    if (opts.fresh) await db.dropDatabase();
    const docs = db.collection<DocRow>("documents");
    const idx = db.collection<IdxRow>("indexes");
    const meta = db.collection<{ _id: string; ts: number }>("meta");
    await docs.createIndex({ t: 1, i: 1, ts: -1 });
    await idx.createIndex({ x: 1, k: 1, ts: -1 });
    await idx.createIndex({ x: 1, k: -1, ts: -1 }); // descending scans keep "newest version first" per key
    const m = (await meta.findOne({ _id: "commit" }))?.ts ?? 0;
    // Recovery: anything above the marker is the remains of an interrupted flush.
    await docs.deleteMany({ ts: { $gt: m } });
    await idx.deleteMany({ ts: { $gt: m } });
    return new MongoPersistence(client, docs, idx, meta, m);
  }

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    for (const d of docs) this.docsBuf.push({ t: d.table, i: d.id, ts, j: d.json });
    for (const e of idx) this.idxBuf.push({ x: e.index, k: hex(e.key), ts, d: e.id });
  }

  async flush() {
    if (!this.docsBuf.length && !this.idxBuf.length) return;
    const docs = this.docsBuf;
    const idx = this.idxBuf;
    this.docsBuf = [];
    this.idxBuf = [];
    const top = Math.max(docs.at(-1)?.ts ?? 0, idx.at(-1)?.ts ?? 0);
    // Rows unjournaled, in parallel; then the marker, journaled (it waits for everything before it).
    await Promise.all([
      docs.length ? this.docs.insertMany(docs, { ordered: false, writeConcern: { w: 1 } }) : null,
      idx.length ? this.idx.insertMany(idx, { ordered: false, writeConcern: { w: 1 } }) : null,
    ]);
    await this.meta.updateOne(
      { _id: "commit" },
      { $max: { ts: top } },
      { upsert: true, writeConcern: { w: 1, j: true } },
    );
    this.marker = top;
  }

  private async latest(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    const rows = await this.idx
      .find({ x: index, k: { $gte: hex(lo), $lt: hex(hi) }, ts: { $lte: ts } }, { projection: { _id: 0, k: 1, d: 1 } })
      .sort(desc ? { k: -1, ts: -1 } : { k: 1, ts: -1 })
      .limit(limit * 4)
      .toArray();
    const out: string[] = [];
    let last: string | null = null;
    for (const r of rows) {
      if (r.k === last) continue; // an older version of a key already decided
      last = r.k;
      if (r.d !== null) out.push(r.d);
      if (out.length >= limit) break;
    }
    return out;
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

  maxTs() {
    return this.marker;
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
