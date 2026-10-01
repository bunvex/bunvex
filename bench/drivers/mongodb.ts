// Driver module for the conformance suite: MongoDB at $MONGO_URL (a scratch database on a REPLICA SET — a
// single-node one is enough; fresh drops it).
import type { OpenOptions } from "@bunvex/core";
import { MongoPersistence } from "@bunvex/persistence/mongodb";
import { type Db, MongoClient } from "mongodb";

const raw = async <T>(f: (db: Db) => Promise<T>) => {
  const c = new MongoClient(process.env.MONGO_URL!, { appName: "conformance-probe" });
  await c.connect();
  try {
    return await f(c.db());
  } finally {
    await c.close();
  }
};

export async function open(fresh: boolean, opts: OpenOptions = {}) {
  return MongoPersistence.open(process.env.MONGO_URL!, { fresh, ...opts });
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

// K22: the version record is the `meta` document {_id: "layout"}, read and written here behind the driver's back.
export async function layoutVersion() {
  const d = await raw((db) => db.collection<any>("meta").findOne({ _id: "layout" }));
  return d ? d.version : null;
}
export async function setLayoutVersion(v: unknown) {
  await raw(async (db) => {
    if (v === null) await db.collection<any>("meta").deleteOne({ _id: "layout" });
    else await db.collection<any>("meta").updateOne({ _id: "layout" }, { $set: { version: v } }, { upsert: true });
  });
}
/** Another application's `documents` collection, with one document. */
export async function makeForeign() {
  await raw(async (db) => {
    await db.dropDatabase();
    await db.collection("documents").insertOne({ id: "a1", ts: 1, table_id: "t", json_value: "{}", prev_ts: null });
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
