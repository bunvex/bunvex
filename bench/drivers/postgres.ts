// Driver module for the conformance suite: Postgres at $PG_URL (an EMPTY scratch database).
import type { OpenOptions } from "@bunvex/core";
import { PostgresPersistence } from "@bunvex/persistence/postgres";
import postgres from "postgres";

/** TLS as the server applies it (STUDY-25 L8): required unless DO_NOT_REQUIRE_SSL is set (CI's stores have none). */
const tls = () => ({ requireSsl: !process.env.DO_NOT_REQUIRE_SSL, caFile: process.env.PG_CA_FILE || undefined });

const raw = async <T>(f: (sql: postgres.Sql) => Promise<T>) => {
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  try {
    return await f(sql);
  } finally {
    await sql.end();
  }
};
/** Convex's five tables, and bunvex's lease table of the previous layout. */
const drop = (sql: postgres.Sql) =>
  sql.unsafe(`drop table if exists documents, indexes, leases, read_only, persistence_globals, bunvex_lease`);

export async function open(fresh: boolean, opts: OpenOptions = {}) {
  if (fresh) await raw(drop);
  return PostgresPersistence.open(process.env.PG_URL!, 16, { ...tls(), ...opts });
}

/** K14: a session other than ours holds the lease row `FOR SHARE`, i.e. a writer is inside its flush's last
 *  statement (the fence), waiting to commit. */
export async function writerInsideFlush() {
  return raw(async (sql) => {
    const [r] = await sql`select exists (select 1 from pg_locks where relation = to_regclass('leases')
      and granted and mode = 'RowShareLock' and pid <> pg_backend_pid()) as inside`;
    return r.inside as boolean;
  });
}

/** The schema of a database the Convex binary created (STUDY-133 §1.6): its columns and indexes. */
const REFERENCE = `${import.meta.dir}/../../packages/persistence/test/fixtures/postgres-reference-schema.json`;
type Reference = {
  columns: { table: string; column: string; type: string; nullable: string; default: string | null }[];
  indexes: { name: string; def: string }[];
};

/** K22: the schema as the fixture describes it, for the current schema. */
export async function schema() {
  const [r] = await raw(
    (sql) => sql`select json_build_object(
      'columns', (select json_agg(json_build_object('table', table_name, 'column', column_name, 'type', data_type,
        'nullable', is_nullable, 'default', column_default) order by table_name, ordinal_position)
        from information_schema.columns where table_schema = current_schema()),
      'indexes', (select json_agg(json_build_object('name', indexname, 'def', indexdef) order by indexname)
        from pg_indexes where schemaname = current_schema())) as j`,
  );
  return r.j;
}
export async function referenceSchema() {
  return Bun.file(REFERENCE).json();
}

/** K22: an empty store built from the reference system's schema (the fixture), not the driver's statements:
 *  its tables, its indexes (the primary keys from their unique indexes), and Convex's lease row. */
export async function makeReferenceStore() {
  const ref = (await Bun.file(REFERENCE).json()) as Reference;
  await raw(async (sql) => {
    await drop(sql);
    const tables = [...new Set(ref.columns.map((c) => c.table))];
    for (const t of tables) {
      const cols = ref.columns
        .filter((c) => c.table === t)
        .map(
          (c) =>
            `${c.column} ${c.type}${c.nullable === "NO" ? " not null" : ""}${c.default !== null ? ` default ${c.default}` : ""}`,
        );
      await sql.unsafe(`create table ${t} (${cols.join(", ")})`);
    }
    for (const ix of ref.indexes) {
      await sql.unsafe(ix.def);
      const table = /ON public\.(\w+)/.exec(ix.def)![1];
      if (ix.name.endsWith("_pkey"))
        await sql.unsafe(`alter table ${table} add constraint ${ix.name} primary key using index ${ix.name}`);
    }
    await sql.unsafe(`insert into leases (id, ts) values (1, 0)`);
  });
}
/** K22: a store in bunvex's previous Postgres layout (text ids, JSON as text), with one row. */
export async function makeForeign() {
  await raw(async (sql) => {
    await drop(sql);
    await sql.unsafe(`create table documents (table_id text not null, id text not null, ts bigint not null,
      json_value text, deleted boolean not null, prev_ts bigint, primary key (table_id, id, ts));
      insert into documents values ('t', 'x', 1, '{}', false, null);`);
  });
}
export async function foreignIntact() {
  return raw(async (sql) => {
    const [r] = await sql`select (select count(*) from documents)::int as n, to_regclass('indexes') is null
        and to_regclass('leases') is null and to_regclass('read_only') is null
        and to_regclass('persistence_globals') is null as untouched`;
    return r.n === 1 && r.untouched;
  });
}

/** K20: where the store listens, and an open through a proxy with a given call timeout. */
export function target() {
  const u = new URL(process.env.PG_URL!);
  return { host: u.hostname, port: Number(u.port || 5432) };
}
export async function openThrough(via: { host: string; port: number }, opts: { timeoutMs: number }) {
  const u = new URL(process.env.PG_URL!);
  u.hostname = via.host;
  u.port = String(via.port);
  return PostgresPersistence.open(u.toString(), 16, { ...tls(), timeoutMs: opts.timeoutMs });
}
