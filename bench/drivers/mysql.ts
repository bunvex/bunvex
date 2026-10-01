// Driver module for the conformance suite: MySQL at $MYSQL_URL (an EMPTY scratch database).
import { MysqlPersistence } from "@bunvex/persistence/mysql";
import mysql from "mysql2/promise";

export async function open(fresh: boolean) {
  if (fresh) {
    const c = await mysql.createConnection(process.env.MYSQL_URL!);
    await c.query(`drop table if exists documents, indexes, bunvex_lease`);
    await c.end();
  }
  // TLS as the server applies it (STUDY-25 L8): required unless DO_NOT_REQUIRE_SSL is set (CI's stores have none).
  return MysqlPersistence.open(process.env.MYSQL_URL!, undefined, {
    requireSsl: !process.env.DO_NOT_REQUIRE_SSL,
    caFile: process.env.MYSQL_CA_FILE || undefined,
  });
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
