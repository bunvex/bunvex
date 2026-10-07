// Driver module for the conformance suite: MySQL at $MYSQL_URL (an EMPTY scratch database).
import type { OpenOptions } from "@bunvex/core";
import { MysqlPersistence } from "@bunvex/persistence/mysql";
import mysql from "mysql2/promise";

/** TLS as the server applies it (STUDY-25 L8): required unless DO_NOT_REQUIRE_SSL is set (CI's stores have none). */
const tls = () => ({ requireSsl: !process.env.DO_NOT_REQUIRE_SSL, caFile: process.env.MYSQL_CA_FILE || undefined });

const raw = async <T>(f: (c: mysql.Connection) => Promise<T>) => {
  const c = await mysql.createConnection(process.env.MYSQL_URL!);
  try {
    return await f(c);
  } finally {
    await c.end();
  }
};
/** Convex's five tables, and bunvex's lease table of the previous layout. */
const drop = (c: mysql.Connection) =>
  c.query(`drop table if exists documents, indexes, leases, read_only, persistence_globals, bunvex_lease`);

export async function open(fresh: boolean, opts: OpenOptions = {}) {
  if (fresh) await raw(drop);
  return MysqlPersistence.open(process.env.MYSQL_URL!, 16, { ...tls(), ...opts });
}

/** K14: another session holds a lock on the lease row (the fence's `FOR SHARE`), i.e. a writer is inside its
 *  flush, waiting to commit. */
export async function writerInsideFlush() {
  return raw(async (c) => {
    const [rows] = (await c.query(
      `select count(*) as n from performance_schema.data_locks
       where object_name = 'leases' and lock_type = 'RECORD' and lock_status = 'GRANTED'
         and thread_id <> ps_current_thread_id()`,
    )) as any;
    return Number(rows[0].n) > 0;
  });
}

/** The schema of a database the Convex binary created (STUDY-133 §1.7): its tables' `SHOW CREATE TABLE`, and
 *  their columns, indexes and row formats as information_schema reports them. */
const REFERENCE = `${import.meta.dir}/../../packages/persistence/test/fixtures/mysql-reference-schema.json`;
const TABLES = ["documents", "indexes", "leases", "persistence_globals", "read_only"];

/** K22: the schema in the fixture's form (without its statements), for the URL's database. */
export async function schema() {
  return raw(async (c) => {
    const [columns] = await c.query(
      `select table_name as \`table\`, column_name as \`column\`, column_type as type, is_nullable as nullable,
         column_default as \`default\`, character_set_name as charset, collation_name as collation
       from information_schema.columns where table_schema = database() and table_name in (?)
       order by table_name, ordinal_position`,
      [TABLES],
    );
    const [indexes] = await c.query(
      `select table_name as \`table\`, index_name as name, seq_in_index as seq, column_name as \`column\`,
         sub_part as subPart, non_unique as nonUnique
       from information_schema.statistics where table_schema = database() and table_name in (?)
       order by table_name, index_name, seq_in_index`,
      [TABLES],
    );
    const [tables] = await c.query(
      `select table_name as \`table\`, row_format as rowFormat from information_schema.tables
       where table_schema = database() and table_name in (?) order by table_name`,
      [TABLES],
    );
    return JSON.parse(JSON.stringify({ columns, indexes, tables }));
  });
}
export async function referenceSchema() {
  const { create: _, ...rest } = await Bun.file(REFERENCE).json();
  return rest;
}

/** K22: an empty store built from the reference system's own statements (the fixture), not the driver's, and
 *  Convex's lease row. */
export async function makeReferenceStore() {
  const { create } = (await Bun.file(REFERENCE).json()) as { create: string[] };
  await raw(async (c) => {
    await drop(c);
    for (const statement of create) await c.query(statement);
    await c.query(`insert into leases (id, ts) values (1, 0)`);
  });
}
/** K22: a store in bunvex's previous MySQL layout (text ids, JSON as text), with one row. */
export async function makeForeign() {
  await raw(async (c) => {
    await drop(c);
    await c.query(`create table documents (table_id varchar(32) not null, id varchar(64) not null,
      ts bigint not null, json_value mediumtext, deleted boolean not null, prev_ts bigint,
      primary key (table_id, id, ts))`);
    await c.query(`insert into documents values ('t', 'x', 1, '{}', false, null)`);
  });
}
export async function foreignIntact() {
  return raw(async (c) => {
    const [rows] = (await c.query(
      `select (select count(*) from documents) as n,
        (select count(*) from information_schema.tables where table_schema = database()
          and table_name in ('indexes', 'leases', 'read_only', 'persistence_globals')) as ours`,
    )) as any;
    return Number(rows[0].n) === 1 && Number(rows[0].ours) === 0;
  });
}

/** K20: where the store listens, and an open through a proxy with a given call timeout. */
export function target() {
  const u = new URL(process.env.MYSQL_URL!);
  return { host: u.hostname, port: Number(u.port || 3306) };
}
export async function openThrough(via: { host: string; port: number }, opts: { timeoutMs: number }) {
  const u = new URL(process.env.MYSQL_URL!);
  u.hostname = via.host;
  u.port = String(via.port);
  return MysqlPersistence.open(u.toString(), 16, { ...tls(), timeoutMs: opts.timeoutMs });
}
