// MySQL in Convex's v5 layout (STUDY-133 PR 6, §1.7): the schema, the bytes of every column, the v1 and v0
// document encodings, the key split and Convex's lease. Runs only when MYSQL_URL is set (an EMPTY scratch
// database: its tables are dropped), e.g.
//   docker exec s133-my mysql -uroot -pbunvex -e "create database bunvex_t"
//   MYSQL_URL=mysql://root:bunvex@127.0.0.1:53306/bunvex_t DO_NOT_REQUIRE_SSL=1 bun test bench/mysql-layout.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { internalIdString, LeaseLostError } from "@bunvex/core/persistence";
import { decodeDocument, MysqlPersistence } from "@bunvex/persistence/mysql";
import { v } from "@bunvex/values";
import mysql from "mysql2/promise";

const MYSQL_URL = process.env.MYSQL_URL;
const tls = () => ({ requireSsl: !process.env.DO_NOT_REQUIRE_SSL });
const FIXTURE = `${import.meta.dir}/../packages/persistence/test/fixtures/mysql-reference-schema.json`;
const TABLES = ["documents", "indexes", "leases", "persistence_globals", "read_only"];

describe.if(!!MYSQL_URL)("MySQL in Convex's v5 layout (MYSQL_URL)", () => {
  let admin: mysql.Connection;
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params))[0] as any[];
  const drop = () => q(`drop table if exists ${TABLES.join(", ")}, bunvex_lease`);
  const schemaOf = async () => ({
    columns: await q(
      `select table_name as \`table\`, column_name as \`column\`, column_type as type, is_nullable as nullable,
         column_default as \`default\`, character_set_name as charset, collation_name as collation
       from information_schema.columns where table_schema = database() and table_name in (?)
       order by table_name, ordinal_position`,
      [TABLES],
    ),
    indexes: await q(
      `select table_name as \`table\`, index_name as name, seq_in_index as seq, column_name as \`column\`,
         sub_part as subPart, non_unique as nonUnique
       from information_schema.statistics where table_schema = database() and table_name in (?)
       order by table_name, index_name, seq_in_index`,
      [TABLES],
    ),
    tables: await q(
      `select table_name as \`table\`, row_format as rowFormat from information_schema.tables
       where table_schema = database() and table_name in (?) order by table_name`,
      [TABLES],
    ),
  });
  const reference = async () => {
    const { create: _, ...rest } = await Bun.file(FIXTURE).json();
    return rest;
  };
  // v1 unless a test says otherwise: these tests check v1's bytes (the default, v0, has its own test).
  const open = (documentEncoding: 0 | 1 = 1) => MysqlPersistence.open(MYSQL_URL!, 4, { ...tls(), documentEncoding });
  const engines: Engine[] = [];
  beforeEach(async () => {
    admin ??= await mysql.createConnection(MYSQL_URL!);
    await drop();
  });
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.close().catch(() => {});
  });
  afterAll(async () => {
    await drop();
    await admin?.end();
  });

  test("a fresh store's schema is the one the Convex binary created", async () => {
    await (await open()).close();
    expect(JSON.parse(JSON.stringify(await schemaOf()))).toEqual(await reference());
  });

  test("ids are 16 bytes, documents are v1, a delete is empty, key_sha256 hashes the whole key", async () => {
    const schema = defineSchema({ items: defineTable({ s: v.string(), n: v.number() }).index("by_s", ["s"]) });
    const e = await new Engine(schema, await open()).init();
    engines.push(e);
    const long = "x".repeat(3000); // its key is longer than the 2500-byte prefix
    const a = (await e.mutation((db) => db.insert("items", { s: "a", n: 1 }))) as string;
    const b = (await e.mutation((db) => db.insert("items", { s: long, n: 2 }))) as string;
    await e.mutation((db) => db.patch(a, { n: 3 }));
    await e.mutation((db) => db.delete(b));
    const table = e.catalog.table("items");
    const byS = table.indexes.get("by_s")!;
    const docs = await q(
      `select id, table_id, ts, json_value, deleted, prev_ts from documents where table_id = ? order by ts`,
      [Buffer.from(table.id, "base64url")],
    );
    expect(docs.length).toBe(4);
    for (const d of docs) {
      expect(d.id.length).toBe(16);
      expect(internalIdString(d.table_id)).toBe(table.id);
      if (!d.deleted) expect(d.json_value[0]).toBe(0x01); // v1
    }
    const live = docs.filter((d) => !d.deleted).map((d) => ({ d, doc: JSON.parse(decodeDocument(d.json_value)!) }));
    const aId = internalIdString(live.find((x) => x.doc._id === a)!.d.id);
    const bId = internalIdString(live.find((x) => x.doc._id === b)!.d.id);
    const patched = live.find((x) => internalIdString(x.d.id) === aId && x.d.prev_ts !== null)!;
    expect(patched.doc).toMatchObject({ _id: a, s: "a", n: 3 });
    const deleted = docs.find((d) => internalIdString(d.id) === bId && d.deleted)!;
    expect(deleted.json_value.length).toBe(0);
    const rows = await q(
      `select key_prefix, key_suffix, key_sha256, deleted, table_id, document_id from indexes where index_id = ?`,
      [Buffer.from(byS.id, "base64url")],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.key_suffix !== null)).toBe(true);
    for (const r of rows) {
      const full = Buffer.concat([r.key_prefix, r.key_suffix ?? Buffer.alloc(0)]);
      expect(Buffer.from(r.key_sha256).toString("hex")).toBe(createHash("sha256").update(full).digest("hex"));
      expect(r.key_prefix.length).toBeLessThanOrEqual(2500);
      if (r.deleted) expect([r.table_id, r.document_id]).toEqual([null, null]);
      else {
        expect(internalIdString(r.table_id)).toBe(table.id);
        expect(r.document_id.length).toBe(16);
      }
    }
    // The long key reads back through the index while live, and is gone once deleted.
    expect(
      (
        await e.query((db) =>
          db
            .query("items")
            .withIndex("by_s", (q) => q.eq("s", long))
            .collect(),
        )
      ).length,
    ).toBe(0);
    expect((await e.query((db) => db.query("items").withIndex("by_s").collect())).map((d) => d.n)).toEqual([3]);
  });

  test("by default (no MYSQL_DOCUMENT_ENCODING) documents are written as v0, the JSON text (DV-414)", async () => {
    const saved = process.env.MYSQL_DOCUMENT_ENCODING;
    delete process.env.MYSQL_DOCUMENT_ENCODING;
    try {
      const schema = defineSchema({ items: defineTable({ n: v.number() }) });
      const e = await new Engine(schema, await MysqlPersistence.open(MYSQL_URL!, 4, tls())).init();
      engines.push(e);
      await e.mutation((db) => db.insert("items", { n: 7 }));
      const rows = await q("select json_value from documents");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => [0x7b, 0x6e].includes(Buffer.from(r.json_value)[0]!))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.MYSQL_DOCUMENT_ENCODING = saved;
    }
  });

  test("v0 documents (JSON text, `null` when deleted) read back, mixed with v1", async () => {
    const schema = defineSchema({ items: defineTable({ n: v.number() }).index("by_n", ["n"]) });
    let e = await new Engine(schema, await open(0)).init();
    const a = (await e.mutation((db) => db.insert("items", { n: 1 }))) as string;
    const b = (await e.mutation((db) => db.insert("items", { n: 2 }))) as string;
    await e.mutation((db) => db.delete(b));
    await e.close();
    const v0 = await q(`select json_value, deleted from documents where json_value like '{%' or json_value = 'null'`);
    expect(v0.some((r) => Buffer.from(r.json_value).toString() === "null" && r.deleted)).toBe(true);
    e = await new Engine(schema, await open(1)).init();
    engines.push(e);
    await e.mutation((db) => db.patch(a, { n: 5 }));
    await e.mutation((db) => db.insert("items", { n: 6 }));
    expect((await e.query((db) => db.query("items").withIndex("by_n").collect())).map((d) => d.n)).toEqual([5, 6]);
    expect(((await e.query((db) => db.get(a))) as unknown as { n: number }).n).toBe(5);
  });

  test("a store made from the reference statements (Convex's DDL, no rows) opens and works", async () => {
    const { create } = (await Bun.file(FIXTURE).json()) as { create: string[] };
    for (const statement of create) await q(statement);
    const schema = defineSchema({ items: defineTable({ n: v.number() }) });
    let e = await new Engine(schema, await open()).init();
    await e.mutation((db) => db.insert("items", { n: 7 }));
    await e.close();
    e = await new Engine(schema, await open()).init();
    engines.push(e);
    expect((await e.query((db) => db.query("items").collect())).map((d) => d.n)).toEqual([7]);
    expect(JSON.parse(JSON.stringify(await schemaOf()))).toEqual(await reference());
  });

  test("Convex's lease: a second store takes it at once, and the first one's flush is refused, writing nothing", async () => {
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
      const [n] = await q(`select (select count(*) from documents) as d, (select count(*) from indexes) as i`);
      expect([Number(n.d), Number(n.i)]).toEqual([0, 0]);
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
});
if (!MYSQL_URL) console.log("mysql-layout: set MYSQL_URL to an empty scratch database to run these tests");
