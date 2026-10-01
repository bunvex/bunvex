// TLS against real servers (STUDY-25 L8, DV-109). Each group runs only when its server is given:
//   TLS_PG_PLAIN_URL   a Postgres WITHOUT TLS (an empty scratch database; a superuser, for the read-only check)
//   TLS_PG_TLS_URL     a Postgres WITH TLS, its certificate for `localhost` signed by TLS_CA_FILE
//   TLS_MYSQL_URL      a MySQL 8.4 with TLS (its auto-generated certificates, or ones signed by TLS_MYSQL_CA_FILE)
//   TLS_MYSQL_PLAIN_URL a MySQL with TLS turned off (`tls_version=''`)
// CI runs the plain-Postgres and MySQL groups against its service containers (no TLS / auto certificates).
import { describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import postgres from "postgres";
import { MysqlPersistence } from "../src/mysql.ts";
import { PostgresPersistence } from "../src/postgres.ts";

const { TLS_PG_PLAIN_URL, TLS_PG_TLS_URL, TLS_CA_FILE, TLS_MYSQL_URL, TLS_MYSQL_CA_FILE, TLS_MYSQL_PLAIN_URL } =
  process.env;

/** Whether the store's own connection is encrypted, asked over that connection. */
async function pgEncrypted(p: PostgresPersistence): Promise<boolean> {
  const sql = (p as unknown as { sql: postgres.Sql }).sql;
  const [r] = await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
  return r.ssl as boolean;
}
async function mysqlEncrypted(p: MysqlPersistence): Promise<boolean> {
  const pool = (p as unknown as { pool: mysql.Pool }).pool;
  const [rows] = (await pool.query(`show session status like 'Ssl_cipher'`)) as any;
  return !!rows[0]?.Value;
}

describe.if(!!TLS_PG_PLAIN_URL)("Postgres without TLS", () => {
  const url = TLS_PG_PLAIN_URL!;
  test("the default refuses it, naming DO_NOT_REQUIRE_SSL", async () => {
    await expect(PostgresPersistence.open(url, 2)).rejects.toThrow(
      /does not accept TLS connections, and bunvex requires TLS by default: set DO_NOT_REQUIRE_SSL=1/,
    );
  });

  test("DO_NOT_REQUIRE_SSL connects, unencrypted", async () => {
    const p = await PostgresPersistence.open(url, 2, { requireSsl: false });
    expect(await pgEncrypted(p)).toBe(false);
    await p.close();
  });

  test("target_session_attrs=read-write: a read-only server is refused", async () => {
    const admin = postgres(url, { max: 1, onnotice: () => {} });
    const db = `bunvex_ro_${process.pid}`;
    await admin.unsafe(`drop database if exists ${db}`);
    await admin.unsafe(`create database ${db}`);
    try {
      const ro = url.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
      // The tables exist (a first open), so a later open only reads: it would succeed on a read-only server.
      await (await PostgresPersistence.open(ro, 2, { requireSsl: false })).close();
      await admin.unsafe(`alter database ${db} set default_transaction_read_only = on`);
      const err = await PostgresPersistence.open(ro, 2, { requireSsl: false }).then(
        (p) => (p.close(), "opened a read-only session"),
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error); // the driver ends the session: "write CONNECTION_DESTROYED"
    } finally {
      await admin.unsafe(`drop database if exists ${db} with (force)`);
      await admin.end();
    }
  });
});

describe.if(!!TLS_PG_TLS_URL && !!TLS_CA_FILE)("Postgres with TLS", () => {
  const url = TLS_PG_TLS_URL!;
  test("the default connects encrypted when the certificate verifies (PG_CA_FILE)", async () => {
    const p = await PostgresPersistence.open(url, 2, { caFile: TLS_CA_FILE });
    expect(await pgEncrypted(p)).toBe(true);
    await p.close();
  });

  test("the default verifies the certificate: an unknown CA is refused, naming PG_CA_FILE", async () => {
    await expect(PostgresPersistence.open(url, 2)).rejects.toThrow(
      /Postgres's TLS certificate does not verify \(UNABLE_TO_VERIFY_LEAF_SIGNATURE.*set PG_CA_FILE/,
    );
  });

  test("the default verifies the host name", async () => {
    // The certificate names `localhost`; the same server reached by its address does not match it.
    const byIp = url.replace("@localhost", "@127.0.0.1");
    expect(byIp).not.toBe(url);
    await expect(PostgresPersistence.open(byIp, 2, { caFile: TLS_CA_FILE })).rejects.toThrow(
      /ERR_TLS_CERT_ALTNAME_INVALID/,
    );
  });

  test("a weaker sslmode in the URL does not turn the requirement off", async () => {
    const p = await PostgresPersistence.open(`${url}?sslmode=disable`, 2, { caFile: TLS_CA_FILE });
    expect(await pgEncrypted(p)).toBe(true);
    await p.close();
  });

  test("DO_NOT_REQUIRE_SSL still prefers TLS when the server offers it, verified", async () => {
    const p = await PostgresPersistence.open(url, 2, { requireSsl: false, caFile: TLS_CA_FILE });
    expect(await pgEncrypted(p)).toBe(true);
    await p.close();
    await expect(PostgresPersistence.open(url, 2, { requireSsl: false })).rejects.toThrow(/does not verify/);
    const plain = await PostgresPersistence.open(`${url}?sslmode=disable`, 2, { requireSsl: false });
    expect(await pgEncrypted(plain)).toBe(false);
    await plain.close();
  });
});

describe.if(!!TLS_MYSQL_URL)("MySQL", () => {
  const url = TLS_MYSQL_URL!;
  test("the default verifies the certificate: an unknown CA (e.g. MySQL's own) is refused, naming MYSQL_CA_FILE", async () => {
    await expect(MysqlPersistence.open(url, 2)).rejects.toThrow(
      /MySQL's TLS certificate does not verify \(.*set MYSQL_CA_FILE/,
    );
  });

  test("DO_NOT_REQUIRE_SSL connects, unencrypted (as the URL says)", async () => {
    const p = await MysqlPersistence.open(url, 2, { requireSsl: false });
    expect(await mysqlEncrypted(p)).toBe(false);
    await p.close();
  });

  test("a read-only server is refused (Convex's require_leader)", async () => {
    const admin = await mysql.createConnection(url);
    await admin.query("set global read_only = on");
    try {
      await expect(MysqlPersistence.open(url, 2, { requireSsl: false })).rejects.toThrow(
        "MySQL is read-only (read_only or innodb_read_only is on)",
      );
    } finally {
      await admin.query("set global read_only = off");
      await admin.end();
    }
  });

  test.if(!!TLS_MYSQL_CA_FILE)(
    "the default connects encrypted when the certificate verifies (MYSQL_CA_FILE)",
    async () => {
      const p = await MysqlPersistence.open(url, 2, { caFile: TLS_MYSQL_CA_FILE });
      expect(await mysqlEncrypted(p)).toBe(true);
      await p.close();
    },
  );

  test.if(!!TLS_MYSQL_CA_FILE && url.includes("@localhost"))(
    "the default verifies the host name; verify_identity=false in the URL skips that check (as Convex)",
    async () => {
      const byIp = url.replace("@localhost", "@127.0.0.1");
      await expect(MysqlPersistence.open(byIp, 2, { caFile: TLS_MYSQL_CA_FILE })).rejects.toThrow(
        /does not verify .*Hostname\/IP does not match/,
      );
      const p = await MysqlPersistence.open(`${byIp}?verify_identity=false`, 2, { caFile: TLS_MYSQL_CA_FILE });
      expect(await mysqlEncrypted(p)).toBe(true);
      await p.close();
    },
  );

  test.if(!!TLS_MYSQL_CA_FILE)("MYSQL_CA_FILE alone turns TLS on under DO_NOT_REQUIRE_SSL (as Convex)", async () => {
    const p = await MysqlPersistence.open(url, 2, { requireSsl: false, caFile: TLS_MYSQL_CA_FILE });
    expect(await mysqlEncrypted(p)).toBe(true);
    await p.close();
  });
});

describe.if(!!TLS_MYSQL_PLAIN_URL)("MySQL without TLS", () => {
  test("the default refuses it, naming DO_NOT_REQUIRE_SSL", async () => {
    await expect(MysqlPersistence.open(TLS_MYSQL_PLAIN_URL!, 2)).rejects.toThrow(
      /MySQL does not accept TLS connections, and bunvex requires TLS by default: set DO_NOT_REQUIRE_SSL=1/,
    );
  });

  test("DO_NOT_REQUIRE_SSL connects", async () => {
    const p = await MysqlPersistence.open(TLS_MYSQL_PLAIN_URL!, 2, { requireSsl: false });
    expect(await mysqlEncrypted(p)).toBe(false);
    await p.close();
  });
});
