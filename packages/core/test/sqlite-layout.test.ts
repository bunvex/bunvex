// The SQLite store in Convex's layout (STUDY-133 PR 4): the schema a fresh store gets is the one the Convex
// binary creates (`fixtures/sqlite-reference-schema.json` is the `sqlite_master` of such a store), ids are the
// 16 bytes of their internal ids, a store in that layout opens, and one in another layout is refused untouched.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { internalIdOf, internalIdString } from "../src/internal-id.ts";
import { LayoutError } from "../src/persistence/layout.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const reference = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/sqlite-reference-schema.json"), "utf8")) as {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}[];
const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function file() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-sqlite-layout-"));
  dirs.push(dir);
  return join(dir, "db.sqlite3");
}
const raw = <T>(path: string, f: (db: Database) => T): T => {
  const db = new Database(path);
  try {
    return f(db);
  } finally {
    db.close();
  }
};
const master = (db: Database) =>
  db
    .query(`select type, name, tbl_name, sql from sqlite_master where tbl_name <> 'read_only' order by type, name`)
    .all();

describe("SQLite in the reference layout", () => {
  test("a fresh store's schema is the reference's, statement for statement; WAL; no layout record", async () => {
    const path = file();
    const e = await new Engine(schema, new SqlitePersistence(path, { durable: false })).init();
    await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.close();
    raw(path, (db) => {
      expect(master(db)).toEqual(reference);
      // bunvex's two additions (DV-411, DV-412): WAL mode and the `read_only` table.
      expect((db.query(`pragma journal_mode`).get() as { journal_mode: string }).journal_mode).toBe("wal");
      expect(db.query(`select name from sqlite_master where name = 'read_only'`).get()).toEqual({ name: "read_only" });
      expect(db.query(`select 1 from persistence_globals where key = 'layout_version'`).get()).toBeNull();
    });
  });

  test("ids, tablets and index ids are stored as their 16 bytes", async () => {
    const path = file();
    const e = await new Engine(schema, new SqlitePersistence(path, { durable: false })).init();
    const id = (await e.mutation((db) => db.insert("items", { n: 7 }))) as string;
    const table = e.catalog.table("items");
    const byN = table.indexes.get("by_n")!;
    await e.close();
    raw(path, (db) => {
      const doc = db
        .query(`select id, table_id from documents where table_id = ? and id = ?`)
        .get(Buffer.from(table.id, "base64url"), Buffer.from(internalIdOf(id), "base64url")) as {
        id: Uint8Array;
        table_id: Uint8Array;
      };
      expect(doc.id).toBeInstanceOf(Uint8Array);
      expect(doc.id.length).toBe(16);
      expect(internalIdString(doc.id)).toBe(internalIdOf(id));
      expect(doc.table_id.length).toBe(16);
      expect(internalIdString(doc.table_id)).toBe(table.id);
      const entries = db
        .query(`select index_id, table_id, document_id from indexes where index_id = ? and deleted = 0`)
        .all(Buffer.from(byN.id, "base64url")) as {
        index_id: Uint8Array;
        table_id: Uint8Array;
        document_id: Uint8Array;
      }[];
      expect(entries.length).toBe(1);
      const [x] = entries;
      expect([x.index_id.length, x.table_id.length, x.document_id.length]).toEqual([16, 16, 16]);
      expect(internalIdString(x.index_id)).toBe(byN.id);
      expect(internalIdString(x.table_id)).toBe(table.id);
      expect(internalIdString(x.document_id)).toBe(internalIdOf(id));
      // Every row of both tables, bootstrap and catalog rows included: no text id anywhere.
      const kinds = db
        .query(
          `select distinct typeof(id) || ',' || typeof(table_id) || ',' || length(id) || ',' || length(table_id) as t
           from documents
           union all
           select distinct typeof(index_id) || ',' || length(index_id) || ',' ||
             coalesce(typeof(table_id) || ',' || length(table_id) || ',' || typeof(document_id) || ',' ||
                      length(document_id), 'tombstone') from indexes`,
        )
        .all() as { t: string }[];
      expect(new Set(kinds.map((r) => r.t))).toEqual(new Set(["blob,blob,16,16", "blob,16,blob,16,blob,16"]));
    });
  });

  test("an empty store created with the reference DDL opens and works", async () => {
    const path = file();
    raw(path, (db) => {
      // Tables before their indexes.
      for (const r of [...reference].sort((a, b) => (a.type === b.type ? 0 : a.type === "table" ? -1 : 1)))
        if (r.sql) db.run(r.sql);
    });
    const e1 = await new Engine(schema, new SqlitePersistence(path, { durable: false })).init();
    for (let n = 0; n < 3; n++) await e1.mutation((db) => db.insert("items", { n }));
    await e1.close();
    const e2 = await new Engine(schema, new SqlitePersistence(path, { durable: false })).init();
    const ns = await e2.query(async (db) =>
      (
        await db
          .query("items")
          .withIndex("by_n", (q) => q.gte("n", 0))
          .collect()
      ).map((d) => d.n),
    );
    await e2.close();
    expect(ns).toEqual([0, 1, 2]);
    raw(path, (db) => expect(master(db)).toEqual(reference));
  });

  test("a store in bunvex's previous layout (text ids) is refused with LayoutError and left untouched", async () => {
    const path = file();
    raw(path, (db) => {
      db.run(`create table documents (table_id text not null, id text not null, ts integer not null,
        json_value text, deleted integer not null, prev_ts integer, primary key (table_id, id, ts)) without rowid`);
      db.run(`insert into documents values ('t', 'x', 1, '{}', 0, null)`);
    });
    const before = readFileSync(path);
    let err: unknown = null;
    try {
      new SqlitePersistence(path, { durable: false }).close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LayoutError);
    expect((err as Error).message).toContain("documents");
    expect((err as Error).message).toContain("id text");
    expect(readFileSync(path).equals(before)).toBe(true);
    raw(path, (db) => {
      expect((db.query(`pragma journal_mode`).get() as { journal_mode: string }).journal_mode).toBe("delete");
      expect(
        (db.query(`select name from sqlite_master where type = 'table'`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      ).toEqual(["documents"]);
    });
  });
});
