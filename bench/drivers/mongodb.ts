// Driver module for the conformance suite: MongoDB at $MONGO_URL (a scratch database on a REPLICA SET — a
// single-node one is enough; fresh drops it).
import { MongoPersistence } from "@bunvex/persistence/mongodb";
import { MongoClient } from "mongodb";

export async function open(fresh: boolean) {
  return MongoPersistence.open(process.env.MONGO_URL!, { fresh });
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

/** K25: a store written before PERSIST-01 C11 has no ts index. */
export async function dropLogIndex() {
  const c = new MongoClient(process.env.MONGO_URL!);
  await c.connect();
  await c.db().collection("indexes").dropIndex("ts_1");
  await c.close();
}
export async function hasLogIndex() {
  const c = new MongoClient(process.env.MONGO_URL!);
  await c.connect();
  const have = await c.db().collection("indexes").listIndexes().toArray();
  await c.close();
  return have.some((i) => JSON.stringify(i.key) === JSON.stringify({ ts: 1 }));
}
/** K25: an index row above the durable prefix, written behind the driver's back. */
export async function strayLogRow(ts: number) {
  const c = new MongoClient(process.env.MONGO_URL!);
  await c.connect();
  await c.db().collection("indexes").insertOne({ x: 960, k: "ff", ts, d: "stray" });
  await c.close();
}
