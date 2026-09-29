// Driver module for the conformance suite: SQLite, in $DIR (default ./.data/conformance).
import { mkdirSync, rmSync } from "node:fs";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";

const dir = process.env.DIR ?? `${import.meta.dir}/../../.data/conformance`;
export async function open(fresh: boolean) {
  mkdirSync(dir, { recursive: true });
  if (fresh) for (const s of ["", "-wal", "-shm"]) rmSync(`${dir}/sqlite.db${s}`, { force: true });
  return new SqlitePersistence(`${dir}/sqlite.db`, { durable: true });
}
