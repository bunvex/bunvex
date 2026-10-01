// Driver module for the conformance suite: Postgres at $PG_URL (an EMPTY scratch database).
import { PostgresPersistence } from "@bunvex/persistence/postgres";
import postgres from "postgres";

export async function open(fresh: boolean) {
  if (fresh) {
    const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
    await sql.unsafe(`drop table if exists documents, indexes, bunvex_lease`);
    await sql.end();
  }
  return PostgresPersistence.open(process.env.PG_URL!);
}

/** K14: a session other than ours holds the lease row's write lock, i.e. a writer is inside a flush. */
export async function writerInsideFlush() {
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  const [r] = await sql`select exists (select 1 from pg_locks where relation = to_regclass('bunvex_lease')
    and granted and mode = 'RowExclusiveLock' and pid <> pg_backend_pid()) as inside`;
  await sql.end();
  return r.inside as boolean;
}

/** K25: a store written before PERSIST-01 C11 has no ts index. */
export async function dropLogIndex() {
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  await sql`drop index if exists indexes_by_ts`;
  await sql.end();
}
export async function hasLogIndex() {
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  const [r] = await sql`select to_regclass('indexes_by_ts') is not null as ok`;
  await sql.end();
  return r.ok as boolean;
}
/** K25: an index row above the durable prefix, written behind the driver's back. */
export async function strayLogRow(ts: number) {
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  await sql`insert into indexes values (960, '\\xff'::bytea, null, ''::bytea, ${ts}, false, 'stray')`;
  await sql.end();
}
