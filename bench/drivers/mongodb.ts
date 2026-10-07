// Driver module for the conformance suite: MongoDB at $MONGO_URL (a scratch database on a REPLICA SET — a
// single-node one is enough; fresh drops it).
import type { OpenOptions } from "@bunvex/core";
import { MongoPersistence } from "@bunvex/persistence/mongodb";
import { type Db, MongoClient } from "mongodb";

const raw = async <T>(f: (db: Db) => Promise<T>) => {
  const c = new MongoClient(process.env.MONGO_URL!, { appName: "conformance-probe", useBigInt64: true });
  await c.connect();
  try {
    return await f(c.db());
  } finally {
    await c.close();
  }
};

export async function open(fresh: boolean, opts: OpenOptions = {}) {
  if (fresh) await endBunvexSessions();
  return MongoPersistence.open(process.env.MONGO_URL!, { fresh, ...opts });
}

/** A fresh open drops the database, which waits for any transaction still open on it: a killed child's
 *  lives on until the server's transaction lifetime (60 s) runs out, longer than a call's timeout (30 s).
 *  End the sessions of earlier bunvex processes first, as a takeover does (the suite kills its children). */
async function endBunvexSessions() {
  const c = new MongoClient(process.env.MONGO_URL!, { appName: "conformance-probe" });
  await c.connect();
  const admin = c.db("admin");
  const ops = await admin
    .aggregate([
      { $currentOp: { allUsers: true, idleSessions: true } },
      { $match: { appName: { $regex: "^bunvex-" }, lsid: { $exists: true } } },
    ])
    .toArray();
  const lsids = ops.map((o) => o.lsid);
  if (lsids.length) await admin.command({ killSessions: lsids }).catch(() => {});
  await c.close();
}

/** K14: a bunvex writer is inside a flush, i.e. has a transaction open. */
export async function writerInsideFlush() {
  const c = new MongoClient(process.env.MONGO_URL!, { appName: "conformance-probe" });
  await c.connect();
  const ops = await c
    .db("admin")
    .aggregate([
      { $currentOp: { allUsers: true, idleSessions: true } },
      { $match: { appName: { $regex: "^bunvex-" }, transaction: { $exists: true } } },
    ])
    .toArray();
  await c.close();
  return ops.length > 0;
}

// K22, the reference form (STUDY-133 §5.6; there is no reference system's store to copy: the layout's own
// description).
/** An empty store in the layout: its collections, their indexes and the lease document, nothing else. */
export async function makeReferenceStore() {
  await endBunvexSessions();
  await raw(async (db) => {
    await db.dropDatabase();
    for (const name of ["documents", "indexes", "leases", "read_only", "persistence_globals"])
      await db.createCollection(name);
    await db.collection("documents").createIndex({ "_id.table_id": 1, "_id.id": 1, "_id.ts": -1 });
    await db.collection("documents").createIndex({ "_id.ts": 1, "_id.table_id": 1, "_id.id": 1 });
    await db
      .collection("indexes")
      .createIndex({ "_id.index_id": 1, "_id.key_prefix": 1, "_id.key_sha256": 1, "_id.ts": -1 });
    await db
      .collection("indexes")
      .createIndex({ "_id.index_id": 1, "_id.key_prefix": -1, "_id.key_sha256": -1, "_id.ts": -1 });
    await db.collection<any>("leases").insertOne({ _id: 1, ts: 0n });
  });
}
/** bunvex's previous MongoDB layout (`t`, `i`, `ts`, `j`, `p`), with one document. */
export async function makeForeign() {
  await endBunvexSessions();
  await raw(async (db) => {
    await db.dropDatabase();
    await db.collection("documents").insertOne({ t: "t", i: "a1", ts: 1, j: "{}", p: null });
  });
}
export async function foreignIntact() {
  return raw(async (db) => {
    const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
    const n = await db.collection("documents").countDocuments();
    const ix = await db.collection("documents").listIndexes().toArray();
    return names.join() === "documents" && n === 1 && ix.length === 1;
  });
}

/** K20: where the store listens (a single host), and an open through a proxy with a given call timeout. */
export function target() {
  const u = new URL(process.env.MONGO_URL!);
  return { host: u.hostname, port: Number(u.port || 27017) };
}
export async function openThrough(via: { host: string; port: number }, opts: { timeoutMs: number }) {
  // A direct connection: through the replica set's own member list, the driver would bypass the proxy.
  const u = new URL(process.env.MONGO_URL!);
  u.hostname = via.host;
  u.port = String(via.port);
  u.searchParams.delete("replicaSet");
  u.searchParams.set("directConnection", "true");
  // The driver's server monitor is not a call: its streaming check legitimately waits up to the heartbeat
  // (10 s by default) plus the connect timeout. A 1 s heartbeat keeps that wait inside the bound K20 checks
  // for the connections of timed-out calls.
  u.searchParams.set("heartbeatFrequencyMS", "1000");
  return MongoPersistence.open(u.toString(), { timeoutMs: opts.timeoutMs });
}
