// Driver module for the conformance suite: SQLite, in $DIR (default ./.data/conformance).
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";

const dir = process.env.DIR ?? `${import.meta.dir}/../../.data/conformance`;
export async function open(fresh: boolean) {
  mkdirSync(dir, { recursive: true });
  if (fresh) for (const s of ["", "-wal", "-shm"]) rmSync(`${dir}/sqlite.db${s}`, { force: true });
  return new SqlitePersistence(`${dir}/sqlite.db`, { durable: true });
}

/** K25: a store written before PERSIST-01 C11 has no ts index. */
export async function dropLogIndex() {
  const db = new Database(`${dir}/sqlite.db`);
  db.exec(`drop index if exists indexes_by_ts`);
  db.close();
}
export async function hasLogIndex() {
  const db = new Database(`${dir}/sqlite.db`, { readonly: true });
  const r = db.query(`select 1 from sqlite_master where type = 'index' and name = 'indexes_by_ts'`).get();
  db.close();
  return !!r;
}
