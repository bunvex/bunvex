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
const drop = (sql: postgres.Sql) =>
  sql.unsafe(`drop table if exists documents, indexes, bunvex_lease, persistence_globals, read_only`);

export async function open(fresh: boolean, opts: OpenOptions = {}) {
  if (fresh) await raw(drop);
  return PostgresPersistence.open(process.env.PG_URL!, 16, { ...tls(), ...opts });
}

/** K14: a session other than ours holds the lease row's write lock, i.e. a writer is inside a flush. */
export async function writerInsideFlush() {
  return raw(async (sql) => {
    const [r] = await sql`select exists (select 1 from pg_locks where relation = to_regclass('bunvex_lease')
      and granted and mode = 'RowExclusiveLock' and pid <> pg_backend_pid()) as inside`;
    return r.inside as boolean;
  });
}

// K22: the version record is a row of `persistence_globals`, read and written here behind the driver's back.
export async function layoutVersion() {
  const [r] = await raw((sql) => sql`select json_value from persistence_globals where key = 'layout_version'`);
  return r ? JSON.parse(r.json_value) : null;
}
export async function setLayoutVersion(v: unknown) {
  await raw((sql) =>
    v === null
      ? sql`delete from persistence_globals where key = 'layout_version'`
      : sql`insert into persistence_globals values ('layout_version', ${JSON.stringify(v)})
            on conflict (key) do update set json_value = excluded.json_value`,
  );
}
/** Convex's own Postgres layout (crates/postgres/src/sql.rs), with one row. */
export async function makeForeign() {
  await raw(async (sql) => {
    await drop(sql);
    await sql.unsafe(`create table documents (id bytea not null, ts bigint not null, table_id bytea not null,
      json_value bytea not null, deleted boolean default false, prev_ts bigint, primary key (ts, table_id, id));
      create table persistence_globals (key text not null primary key, json_value bytea not null);
      insert into documents values ('\\x01', 1, '\\x02', '\\x7b7d', false, null);`);
  });
}
export async function foreignIntact() {
  return raw(async (sql) => {
    const [r] = await sql`select (select count(*) from documents)::int as n,
      (select count(*) from persistence_globals)::int as g, to_regclass('indexes') is null
        and to_regclass('bunvex_lease') is null and to_regclass('read_only') is null as untouched`;
    return r.n === 1 && r.g === 0 && r.untouched;
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
export async function strayLogRow(ts: bigint) {
  const sql = postgres(process.env.PG_URL!, { max: 1, onnotice: () => {} });
  await sql`insert into indexes values (960, '\\xff'::bytea, null, ''::bytea, ${String(ts)}::bigint, false, 'stray')`;
  await sql.end();
}
