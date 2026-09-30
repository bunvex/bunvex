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
