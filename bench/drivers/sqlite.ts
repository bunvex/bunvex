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

// K22: the version record is a row of `persistence_globals`, read and written here behind the driver's back.
const raw = <T>(f: (db: Database) => T) => {
  const db = new Database(path);
  try {
    return f(db);
  } finally {
    db.close();
  }
};
export async function layoutVersion() {
  const r = raw(
    (db) =>
      db.query(`select json_value from persistence_globals where key = 'layout_version'`).get() as {
        json_value: string;
      } | null,
  );
  return r ? JSON.parse(r.json_value) : null;
}
export async function setLayoutVersion(v: unknown) {
  raw((db) =>
    v === null
      ? db.run(`delete from persistence_globals where key = 'layout_version'`)
      : db.run(`insert or replace into persistence_globals values ('layout_version', ?)`, [JSON.stringify(v)]),
  );
}
/** Convex's own SQLite layout (crates/sqlite/src/lib.rs), with one row. */
export async function makeForeign() {
  mkdirSync(dir, { recursive: true });
  remove();
  raw((db) => {
    db.run(`create table documents (id blob not null, ts integer not null, table_id blob not null,
      json_value text not null, deleted integer default 0, prev_ts integer, primary key (ts, table_id, id))`);
    db.run(`insert into documents values (x'01', 1, x'02', '{}', 0, null)`);
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
