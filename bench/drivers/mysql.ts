// Driver module for the conformance suite: MySQL at $MYSQL_URL (an EMPTY scratch database).
import type { OpenOptions } from "@bunvex/core";
import { MysqlPersistence } from "@bunvex/persistence/mysql";
import mysql from "mysql2/promise";

const raw = async <T>(f: (c: mysql.Connection) => Promise<T>) => {
  const c = await mysql.createConnection(process.env.MYSQL_URL!);
  try {
    return await f(c);
  } finally {
    await c.end();
  }
};
const drop = (c: mysql.Connection) =>
  c.query(`drop table if exists documents, indexes, bunvex_lease, persistence_globals, read_only`);

export async function open(fresh: boolean, opts: OpenOptions = {}) {
  if (fresh) await raw(drop);
  return MysqlPersistence.open(process.env.MYSQL_URL!, 16, opts);
}

/** K14: another session holds a lock on the lease row, i.e. a writer is inside a flush. */
export async function writerInsideFlush() {
  return raw(async (c) => {
    const [rows] = (await c.query(
      `select count(*) as n from performance_schema.data_locks
       where object_name = 'bunvex_lease' and lock_type = 'RECORD' and lock_status = 'GRANTED'
         and thread_id <> ps_current_thread_id()`,
    )) as any;
    return Number(rows[0].n) > 0;
  });
}

// K22: the version record is a row of `persistence_globals`, read and written here behind the driver's back.
export async function layoutVersion() {
  const [rows] = (await raw((c) =>
    c.query("select json_value from persistence_globals where `key` = 'layout_version'"),
  )) as any;
  return rows[0] ? JSON.parse(rows[0].json_value) : null;
}
export async function setLayoutVersion(v: unknown) {
  await raw((c) =>
    v === null
      ? c.query("delete from persistence_globals where `key` = 'layout_version'")
      : c.query("replace into persistence_globals (`key`, json_value) values ('layout_version', ?)", [
          JSON.stringify(v),
        ]),
  );
}
/** Convex's own MySQL layout (crates/mysql/src/v5/sql.rs), with one row. */
export async function makeForeign() {
  await raw(async (c) => {
    await drop(c);
    await c.query(`create table documents (id varbinary(32) not null, ts bigint not null,
      table_id varbinary(32) not null, json_value longblob not null, deleted boolean default false,
      prev_ts bigint, primary key (ts, table_id, id))`);
    await c.query("create table persistence_globals (`key` varchar(255) primary key, json_value longblob not null)");
    await c.query(`insert into documents values (x'01', 1, x'02', '{}', false, null)`);
  });
}
export async function foreignIntact() {
  return raw(async (c) => {
    const [rows] = (await c.query(
      `select (select count(*) from documents) as n, (select count(*) from persistence_globals) as g,
        (select count(*) from information_schema.tables where table_schema = database()
          and table_name in ('indexes', 'bunvex_lease', 'read_only')) as ours`,
    )) as any;
    return Number(rows[0].n) === 1 && Number(rows[0].g) === 0 && Number(rows[0].ours) === 0;
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
  return MysqlPersistence.open(u.toString(), 16, { timeoutMs: opts.timeoutMs });
}
