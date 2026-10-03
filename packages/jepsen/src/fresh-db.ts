// A fresh database for each run on a remote store (STUDY-57 §5): the runs share one database server, and
// each must start empty (the bank is set up once, the logs start at 0). `PERSISTENCE_URL` names the server
// and a database to connect to; this drops and creates `name` beside it and returns its URL.
const SAFE = /^[a-z0-9_]+$/;

export async function freshDatabase(kind: string, url: string, name: string): Promise<string> {
  if (!SAFE.test(name)) throw new Error(`not a safe database name: ${name}`);
  const fresh = new URL(url);
  fresh.pathname = `/${name}`;
  if (kind === "postgres" || kind === "mysql") {
    const sql = new Bun.SQL(url, kind === "mysql" ? { adapter: "mysql" } : {});
    try {
      await sql.unsafe(
        kind === "postgres" ? `DROP DATABASE IF EXISTS ${name} WITH (FORCE)` : `DROP DATABASE IF EXISTS ${name}`,
      );
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
