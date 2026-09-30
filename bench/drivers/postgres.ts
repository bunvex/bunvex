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
