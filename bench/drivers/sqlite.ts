// Driver module for the conformance suite: SQLite, in $DIR (default ./.data/conformance).
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import type { OpenOptions } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";

const dir = process.env.DIR ?? `${import.meta.dir}/../../.data/conformance`;
const path = `${dir}/sqlite.db`;
const remove = () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${path}${s}`, { force: true });
};
export async function open(fresh: boolean, opts: OpenOptions = {}) {
  mkdirSync(dir, { recursive: true });
  if (fresh) remove();
  return new SqlitePersistence(path, { durable: true, ...opts });
}

// K22: stores made here behind the driver's back.
const raw = <T>(f: (db: Database) => T) => {
  const db = new Database(path);
  try {
    return f(db);
  } finally {
    db.close();
  }
};

/** The `sqlite_master` of a store the Convex binary created (STUDY-133 §1.5): the reference layout. */
const REFERENCE = `${import.meta.dir}/../../packages/core/test/fixtures/sqlite-reference-schema.json`;

/** An empty store in the reference layout, from the reference system's own DDL (tables first, then indexes;
 *  SQLite's automatic indexes come with their tables). */
export async function makeReferenceStore() {
  mkdirSync(dir, { recursive: true });
  remove();
  const rows = (await Bun.file(REFERENCE).json()) as { type: string; sql: string | null }[];
  const ddl = [...rows.filter((r) => r.type === "table"), ...rows.filter((r) => r.type === "index")]
    .map((r) => r.sql)
    .filter((s): s is string => s !== null);
  raw((db) => {
    for (const s of ddl) db.run(s);
  });
}

/** A store in bunvex's previous SQLite layout (text ids), with one row: another layout's columns. */
export async function makeForeign() {
  mkdirSync(dir, { recursive: true });
  remove();
  raw((db) => {
    db.run(`create table documents (table_id text not null, id text not null, ts integer not null,
      json_value text, deleted integer not null, prev_ts integer, primary key (table_id, id, ts)) without rowid`);
    db.run(`insert into documents values ('t', 'x', 1, '{}', 0, null)`);
  });
}
export async function foreignIntact() {
  return raw((db) => {
    const tables = (db.query(`select name from sqlite_master where type = 'table'`).all() as { name: string }[])
      .map((r) => r.name)
      .join();
    const mode = (db.query(`pragma journal_mode`).get() as { journal_mode: string }).journal_mode;
    const n = (db.query(`select count(*) as n from documents`).get() as { n: number }).n;
    return tables === "documents" && mode === "delete" && n === 1;
  });
}

/** K22: the store's `sqlite_master`, without bunvex's `read_only` table (DV-412). */
export async function schema() {
  return raw((db) =>
    db
      .query(`select type, name, tbl_name, sql from sqlite_master where tbl_name <> 'read_only' order by type, name`)
      .all(),
  );
}
/** K22: the `sqlite_master` of a store the Convex binary created. */
export async function referenceSchema() {
  return Bun.file(REFERENCE).json();
}
