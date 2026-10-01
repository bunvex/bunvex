// Driver module for the conformance suite: MySQL at $MYSQL_URL (an EMPTY scratch database).
import { MysqlPersistence } from "@bunvex/persistence/mysql";
import mysql from "mysql2/promise";

/** TLS as the server applies it (STUDY-25 L8): required unless DO_NOT_REQUIRE_SSL is set (CI's stores have none). */
const tls = () => ({ requireSsl: !process.env.DO_NOT_REQUIRE_SSL, caFile: process.env.MYSQL_CA_FILE || undefined });

export async function open(fresh: boolean) {
  if (fresh) {
    const c = await mysql.createConnection(process.env.MYSQL_URL!);
    await c.query(`drop table if exists documents, indexes, bunvex_lease`);
    await c.end();
  }
  return MysqlPersistence.open(process.env.MYSQL_URL!, undefined, tls());
}

/** K14: another session holds a lock on the lease row, i.e. a writer is inside a flush. */
export async function writerInsideFlush() {
  const c = await mysql.createConnection(process.env.MYSQL_URL!);
  const [rows] = (await c.query(
    `select count(*) as n from performance_schema.data_locks
     where object_name = 'bunvex_lease' and lock_type = 'RECORD' and lock_status = 'GRANTED'
       and thread_id <> ps_current_thread_id()`,
  )) as any;
  await c.end();
  return Number(rows[0].n) > 0;
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
