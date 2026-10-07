// Postgres in Convex's layout (STUDY-133 PR 5, §1.6): the schema, the bytes of every column, the key split and
// Convex's lease. Runs only when PG_URL is set (an EMPTY scratch database: its tables are dropped), e.g.
//   docker exec s133-pg psql -U postgres -c "create database bunvex_t"
//   PG_URL=postgres://postgres:bunvex@127.0.0.1:55432/bunvex_t DO_NOT_REQUIRE_SSL=1 bun test bench/postgres-layout.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { internalIdString, LeaseLostError } from "@bunvex/core/persistence";
import { PostgresPersistence } from "@bunvex/persistence/postgres";
import { v } from "@bunvex/values";
import postgres from "postgres";

const PG_URL = process.env.PG_URL;
const tls = () => ({ requireSsl: !process.env.DO_NOT_REQUIRE_SSL });
const FIXTURE = `${import.meta.dir}/../packages/persistence/test/fixtures/postgres-reference-schema.json`;
const TABLES = ["documents", "indexes", "leases", "read_only", "persistence_globals"];

type Schema = {
  columns: { table: string; column: string; type: string; nullable: string; default: string | null }[];
  indexes: { name: string; def: string }[];
};

describe.if(!!PG_URL)("Postgres in Convex's layout (PG_URL)", () => {
  const admin = postgres(PG_URL ?? "postgres://unused", { max: 1, onnotice: () => {} });
  const drop = async () => {
    await admin.unsafe(`drop table if exists ${TABLES.join(", ")}`);
  };
  const schemaOf = async (): Promise<Schema> => {
    const [r] = await admin`select json_build_object(
      'columns', (select json_agg(json_build_object('table', table_name, 'column', column_name, 'type', data_type,
          'nullable', is_nullable, 'default', column_default) order by table_name, ordinal_position)
        from information_schema.columns where table_schema = current_schema()),
      'indexes', (select json_agg(json_build_object('name', indexname, 'def', indexdef) order by indexname)
        from pg_indexes where schemaname = current_schema())) as j`;
    return r.j as Schema;
  };
  const open = () => PostgresPersistence.open(PG_URL!, 4, tls());
  const engines: Engine[] = [];
  beforeEach(drop);
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.close().catch(() => {});
  });
  afterAll(async () => {
    await drop();
    await admin.end();
  });

  test("a fresh store's schema is the one the Convex binary created", async () => {
    await (await open()).close();
    expect(await schemaOf()).toEqual(await Bun.file(FIXTURE).json());
  });

  test("ids are 16 bytes, JSON is its text's bytes, a delete stores `null`, key_sha256 hashes the whole key", async () => {
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
    const docs = await admin`select id, table_id, ts, json_value, deleted, prev_ts from documents
      where table_id = ${Buffer.from(table.id, "base64url")} order by ts`;
    expect(docs.length).toBe(4);
    for (const d of docs) {
      expect(d.id.length).toBe(16);
      expect(internalIdString(d.table_id)).toBe(table.id);
    }
    const internalOf = (devId: string) => {
      const doc = docs.find(
        (d) => d.deleted === false && JSON.parse(Buffer.from(d.json_value).toString())._id === devId,
      );
      return internalIdString(doc!.id);
    };
    const aId = internalOf(a);
    const bId = internalOf(b);
    const patched = docs.find((d) => internalIdString(d.id) === aId && d.prev_ts !== null)!;
    expect(JSON.parse(Buffer.from(patched.json_value).toString("utf8"))).toMatchObject({ _id: a, s: "a", n: 3 });
    const deleted = docs.find((d) => internalIdString(d.id) === bId && d.deleted === true)!;
    expect(Buffer.from(deleted.json_value).toString("utf8")).toBe("null");
    const rows = await admin`select key_prefix, key_suffix, key_sha256, deleted, table_id, document_id
      from indexes where index_id = ${Buffer.from(byS.id, "base64url")}`;
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

  test("a store made from the reference schema (Convex's DDL, no rows) opens and works", async () => {
    const ref = (await Bun.file(FIXTURE).json()) as Schema;
    const byTable = new Map<string, Schema["columns"]>();
    for (const c of ref.columns) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
    for (const [t, cols] of byTable) {
      const defs = cols.map(
        (c) =>
          `${c.column} ${c.type}${c.nullable === "NO" ? " not null" : ""}${c.default ? ` default ${c.default}` : ""}`,
      );
      await admin.unsafe(`create table ${t} (${defs.join(", ")})`);
    }
    for (const i of ref.indexes) {
      await admin.unsafe(i.def);
      if (i.name.endsWith("_pkey"))
        await admin.unsafe(
          `alter table ${i.name.slice(0, -"_pkey".length)} add constraint ${i.name} primary key using index ${i.name}`,
        );
    }
    // Convex's init inserts the lease row with every open.
    await admin`insert into leases (id, ts) values (1, 0)`;
    const schema = defineSchema({ items: defineTable({ n: v.number() }) });
    let e = await new Engine(schema, await open()).init();
    await e.mutation((db) => db.insert("items", { n: 7 }));
    await e.close();
    e = await new Engine(schema, await open()).init();
    engines.push(e);
    expect((await e.query((db) => db.query("items").collect())).map((d) => d.n)).toEqual([7]);
    expect(await schemaOf()).toEqual(ref);
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
      const [n] =
        await admin`select (select count(*) from documents)::int as d, (select count(*) from indexes)::int as i`;
      expect(n).toEqual({ d: 0, i: 0 });
      // The renewal (an advisory check) says so too.
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

  // Convex's `indexes` index has no ts column, so without its planner settings Postgres plans a range's newest
  // versions as a sequential scan and a sort (32 ms against 1.7 ms, measured): the driver's connections turn
  // sequential and bitmap scans off, as Convex's hints do.
  test("an index range over many versions walks the index, never a sequential scan", async () => {
    const schema = defineSchema({ items: defineTable({ t: v.string(), n: v.number() }).index("by_t_n", ["t", "n"]) });
    const e = await new Engine(schema, await open()).init();
    engines.push(e);
    const ids = (await e.mutation(async (db) => {
      const out: string[] = [];
      for (let i = 0; i < 400; i++) out.push(await db.insert("items", { t: `t${i % 4}`, n: i }));
      return out;
    })) as string[];
    for (let round = 0; round < 5; round++)
      await e.mutation(async (db) => {
        for (const id of ids) await db.patch(id as never, { n: round * 1000 + ids.indexOf(id) });
      });
    await admin.unsafe("analyze indexes");
    const seqScans = async () => {
      await admin.unsafe("select pg_stat_force_next_flush()");
      await Bun.sleep(1100); // the counters are flushed at most once a second
      await admin.unsafe("select pg_stat_clear_snapshot()");
      const [r] = await admin`select seq_scan from pg_stat_user_tables where relname = 'indexes'`;
      return Number(r.seq_scan);
    };
    const before = await seqScans();
    for (let i = 0; i < 50; i++)
      await e.query((db) =>
        db
          .query("items")
          .withIndex("by_t_n", (q) => q.eq("t", `t${i % 4}`))
          .take(20),
      );
    expect((await seqScans()) - before).toBe(0);
  });
});
if (!PG_URL) console.log("postgres-layout: set PG_URL to an empty scratch database to run these tests");
