// A fresh database for each run on a remote store (STUDY-57 §5): the runs share one database server, and
// each must start empty (the bank is set up once, the logs start at 0). `PERSISTENCE_URL` names the server
// and a database to connect to; this drops and creates `name` beside it and returns its URL.
const SAFE = /^[a-z0-9_]+$/;

export async function freshDatabase(kind: string, url: string, name: string): Promise<string> {
  if (!SAFE.test(name)) throw new Error(`not a safe database name: ${name}`);
  const fresh = new URL(url);
  fresh.pathname = `/${name}`;
  if (kind === "mysql") {
    // mysql2, as the driver: Bun.SQL refuses MySQL 8's RSA key exchange without TLS
    const { createConnection } = await import("mysql2/promise");
    const conn = await createConnection(url);
    try {
      await conn.query(`DROP DATABASE IF EXISTS ${name}`);
      await conn.query(`CREATE DATABASE ${name}`);
    } finally {
      await conn.end();
    }
  } else if (kind === "postgres") {
    const sql = new Bun.SQL(url);
    try {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await sql.unsafe(`CREATE DATABASE ${name}`);
    } finally {
      await sql.close();
    }
  } else if (kind === "mongodb") {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(fresh.toString());
    try {
      await client.connect();
      await client.db(name).dropDatabase();
    } finally {
      await client.close();
    }
  } else throw new Error(`no fresh database for ${kind}`);
  return fresh.toString();
}
