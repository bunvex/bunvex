// Driver module for the conformance suite: MySQL at $MYSQL_URL (an EMPTY scratch database).
import { MysqlPersistence } from "@bunvex/persistence/mysql";
import mysql from "mysql2/promise";

export async function open(fresh: boolean) {
  if (fresh) {
    const c = await mysql.createConnection(process.env.MYSQL_URL!);
    await c.query(`drop table if exists documents, indexes`);
    await c.end();
  }
  return MysqlPersistence.open(process.env.MYSQL_URL!);
}
