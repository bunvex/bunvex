// Driver module for the conformance suite: Postgres at $PG_URL (an EMPTY scratch database).
import { PostgresPersistence } from "@bunvex/persistence/postgres";
import postgres from "postgres";

export async function open(fresh: boolean) {
  if (fresh) {
    const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
    await sql.unsafe(`drop table if exists documents, indexes`);
    await sql.end();
  }
  return PostgresPersistence.open(process.env.PG_URL!);
}
