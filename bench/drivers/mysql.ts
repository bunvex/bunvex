// Driver module for the conformance suite: MySQL at $MYSQL_URL (an EMPTY scratch database).
import { MysqlPersistence } from "@bunvex/persistence/mysql";
import mysql from "mysql2/promise";

export async function open(fresh: boolean) {
  if (fresh) {
    const c = await mysql.createConnection(process.env.MYSQL_URL!);
    await c.query(`drop table if exists documents, indexes, bunvex_lease`);
    await c.end();
  }
  return MysqlPersistence.open(process.env.MYSQL_URL!);
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

/** K25: a store written before PERSIST-01 C11 has no ts index. */
export async function dropLogIndex() {
  const c = await mysql.createConnection(process.env.MYSQL_URL!);
  await c.query(`alter table indexes drop index indexes_by_ts`);
  await c.end();
}
export async function hasLogIndex() {
  const c = await mysql.createConnection(process.env.MYSQL_URL!);
  const [rows] = (await c.query(
    `select count(*) as n from information_schema.statistics
     where table_schema = database() and table_name = 'indexes' and index_name = 'indexes_by_ts'`,
  )) as any;
  await c.end();
  return Number(rows[0].n) > 0;
}
/** K25: an index row above the durable prefix, written behind the driver's back. */
export async function strayLogRow(ts: number) {
  const c = await mysql.createConnection(process.env.MYSQL_URL!);
  await c.query(`insert into indexes values (960, x'ff', null, x'', ?, false, 'stray')`, [ts]);
  await c.end();
}
