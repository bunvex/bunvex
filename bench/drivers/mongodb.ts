// Driver module for the conformance suite: MongoDB at $MONGO_URL (a scratch database on a REPLICA SET — a
// single-node one is enough; fresh drops it).
import { MongoPersistence } from "@bunvex/persistence/mongodb";
import { MongoClient } from "mongodb";

export async function open(fresh: boolean) {
  if (fresh) await endBunvexSessions();
  return MongoPersistence.open(process.env.MONGO_URL!, { fresh });
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
