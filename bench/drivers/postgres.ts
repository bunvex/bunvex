// Driver module for the conformance suite: Postgres at $PG_URL (an EMPTY scratch database).
import { PostgresPersistence } from "@bunvex/persistence/postgres";
import postgres from "postgres";

export async function open(fresh: boolean) {
  if (fresh) {
    const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
    await sql.unsafe(`drop table if exists documents, indexes, bunvex_lease`);
    await sql.end();
  }
  // TLS as the server applies it (STUDY-25 L8): required unless DO_NOT_REQUIRE_SSL is set (CI's stores have none).
  return PostgresPersistence.open(process.env.PG_URL!, undefined, {
    requireSsl: !process.env.DO_NOT_REQUIRE_SSL,
    caFile: process.env.PG_CA_FILE || undefined,
  });
}

/** K14: a session other than ours holds the lease row's write lock, i.e. a writer is inside a flush. */
export async function writerInsideFlush() {
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  const [r] = await sql`select exists (select 1 from pg_locks where relation = to_regclass('bunvex_lease')
    and granted and mode = 'RowExclusiveLock' and pid <> pg_backend_pid()) as inside`;
  await sql.end();
  return r.inside as boolean;
}
