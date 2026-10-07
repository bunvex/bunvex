// MongoDB in the analogue of Convex's Postgres layout (STUDY-133 PR 7, §5.6, DV-416): the field types of every
// document, the key split and the newest-wins lease. Runs only when MONGO_URL is set (a scratch database on a
// replica set: it is dropped), e.g.
//   MONGO_URL="mongodb://127.0.0.1:57017/bunvex_t?replicaSet=rs0&directConnection=true" bun test bench/mongodb-layout.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { internalIdString, LayoutError, LeaseLostError } from "@bunvex/core/persistence";
import { MongoPersistence } from "@bunvex/persistence/mongodb";
import { v } from "@bunvex/values";
import { type Db, MongoClient } from "mongodb";

const MONGO_URL = process.env.MONGO_URL;

describe.if(!!MONGO_URL)("MongoDB in the layout (MONGO_URL)", () => {
  let client: MongoClient;
  let db: Db;
  const engines: Engine[] = [];
  const open = () => MongoPersistence.open(MONGO_URL!, {});
  beforeEach(async () => {
    client ??= await new MongoClient(MONGO_URL!, { useBigInt64: true, appName: "layout-test" }).connect();
    db = client.db();
    await db.dropDatabase();
  });
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.close().catch(() => {});
  });
  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  test("ids are 16-byte BinData, timestamps int64, a delete stores null; key_prefix is hex, key_sha256 hashes the whole key", async () => {
    const schema = defineSchema({ items: defineTable({ s: v.string(), n: v.number() }).index("by_s", ["s"]) });
    const e = await new Engine(schema, await open()).init();
    engines.push(e);
    const long = "x".repeat(3000); // its key is longer than the 2500-byte prefix
    const a = (await e.mutation((d) => d.insert("items", { s: "a", n: 1 }))) as string;
    const b = (await e.mutation((d) => d.insert("items", { s: long, n: 2 }))) as string;
    await e.mutation((d) => d.patch(a as never, { n: 3 }));
    await e.mutation((d) => d.delete(b as never));
    const table = e.catalog.table("items");
    const byS = table.indexes.get("by_s")!;
    const tableBin = Buffer.from(table.id, "base64url");
    // Every timestamp is stored as a BSON int64 (`long`), never a double.
    expect(await db.collection("documents").countDocuments({ "_id.ts": { $not: { $type: "long" } } })).toBe(0);
    expect(await db.collection("indexes").countDocuments({ "_id.ts": { $not: { $type: "long" } } })).toBe(0);
    const docs = await db
      .collection<any>("documents")
      .find({ "_id.table_id": tableBin })
      .sort({ "_id.ts": 1 })
      .toArray();
    expect(docs.length).toBe(4);
    for (const d of docs) {
      expect(d._id.id.buffer.length).toBe(16);
      expect(d._id.id.sub_type).toBe(0);
      expect(internalIdString(d._id.table_id.buffer)).toBe(table.id);
      expect(typeof d._id.ts).toBe("bigint");
    }
    const deleted = docs.find((d) => d.deleted === true)!;
    expect(deleted.json_value).toBeNull();
    const patched = docs.find((d) => d.prev_ts !== null && d.deleted === false)!;
    expect(JSON.parse(patched.json_value)).toMatchObject({ _id: a, s: "a", n: 3 });
    expect(typeof patched.prev_ts).toBe("bigint");
    const rows = await db
      .collection<any>("indexes")
      .find({ "_id.index_id": Buffer.from(byS.id, "base64url") })
      .toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.key_suffix !== null)).toBe(true);
    for (const r of rows) {
      expect(r._id.key_prefix).toMatch(/^([0-9a-f]{2})+$/);
      const prefix = Buffer.from(r._id.key_prefix, "hex");
      expect(prefix.length).toBeLessThanOrEqual(2500);
      const full = Buffer.concat([prefix, r.key_suffix ? Buffer.from(r.key_suffix.buffer) : Buffer.alloc(0)]);
      expect(r._id.key_sha256).toBe(createHash("sha256").update(full).digest("hex"));
      if (r.deleted) expect([r.table_id, r.document_id]).toEqual([null, null]);
      else {
        expect(internalIdString(r.table_id.buffer)).toBe(table.id);
        expect(r.document_id.buffer.length).toBe(16);
      }
    }
    expect((await e.query((d) => d.query("items").withIndex("by_s").collect())).map((d) => d.n)).toEqual([3]);
    // The lease document holds our start in nanoseconds, as Convex's `leases` row.
    const lease = await db.collection<any>("leases").findOne({ _id: 1 });
    expect(typeof lease.ts).toBe("bigint");
  });

  test("the lease: a second store takes it at once, and the first one's flush is refused, writing nothing", async () => {
    const first = await open();
    const second = await open();
    try {
      expect("epoch" in (await first.acquireLease({ holder: "a", ttlMs: 30_000 }))).toBe(true);
      expect("epoch" in (await second.acquireLease({ holder: "b", ttlMs: 30_000 }))).toBe(true);
      const id = internalIdString(new Uint8Array(16).fill(7));
      const table = internalIdString(new Uint8Array(16).fill(8));
      const index = internalIdString(new Uint8Array(16).fill(9));
      const ts = (await first.maxTs()) + 1n;
      first.apply(
        ts,
        [{ table, id, json: `{"x":1}`, prevTs: null }],
        [{ index, key: new Uint8Array([0x10, 0x6b, 0]), table, id }],
      );
      let err: unknown;
      try {
        await first.flush();
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(LeaseLostError);
      expect(await db.collection("documents").countDocuments({})).toBe(0);
      expect(await db.collection("indexes").countDocuments({})).toBe(0);
      let renew: unknown;
      try {
        await first.renewLease();
      } catch (x) {
        renew = x;
      }
      expect(renew).toBeInstanceOf(LeaseLostError);
      await second.renewLease();
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("a store in bunvex's previous MongoDB layout is refused, untouched", async () => {
    await db.collection("documents").insertOne({ t: "t", i: "a1", ts: 1, j: "{}", p: null });
    let err: unknown;
    try {
      await (await open()).close();
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(LayoutError);
    expect((await db.listCollections().toArray()).map((c) => c.name)).toEqual(["documents"]);
    expect(await db.collection("documents").countDocuments({})).toBe(1);
  });
});
if (!MONGO_URL) console.log("mongodb-layout: set MONGO_URL to a scratch database on a replica set to run these tests");
