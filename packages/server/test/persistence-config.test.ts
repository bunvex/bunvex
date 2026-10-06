// Database selection from the environment: bunvex's names, Convex's as aliases (DV-88) with Convex's
// precedence (run_backend.sh:17-32), DO_NOT_REQUIRE_SSL as Convex reads it, and the database: the URL's, else the
// instance's (DV-417). STUDY-25 L8. And the remote drivers' call timeouts (STUDY-25 L3) under Convex's names.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { v } from "@bunvex/values";
import {
  instanceDatabase,
  openPersistence,
  persistenceConfigFromEnv,
  urlDatabase,
  withDatabase,
} from "../src/persistence.ts";

const PG = "postgres://u@db.example:5432/app";
const MY = "mysql://u@db.example:3306/app";
const cfg = (env: Record<string, string | undefined>) => {
  const warnings: string[] = [];
  const c = persistenceConfigFromEnv(env, (m) => warnings.push(m));
  return { ...c, warnings };
};

describe("database selection", () => {
  test("nothing set: memory, as before", () => {
    const c = cfg({});
    expect([c.kind, c.url]).toEqual(["memory", undefined]);
  });

  test("Convex's names select the driver: POSTGRES_URL, else MYSQL_URL, else DATABASE_URL (Postgres)", () => {
    expect(cfg({ POSTGRES_URL: PG })).toMatchObject({ kind: "postgres", url: PG, urlFrom: "POSTGRES_URL" });
    expect(cfg({ MYSQL_URL: MY })).toMatchObject({ kind: "mysql", url: MY, urlFrom: "MYSQL_URL" });
    expect(cfg({ POSTGRES_URL: PG, MYSQL_URL: MY })).toMatchObject({ kind: "postgres", url: PG });
    expect(cfg({ MYSQL_URL: MY, DATABASE_URL: PG })).toMatchObject({ kind: "mysql", url: MY });
    const d = cfg({ DATABASE_URL: PG });
    expect(d).toMatchObject({ kind: "postgres", url: PG, urlFrom: "DATABASE_URL" });
    expect(d.warnings).toEqual([expect.stringContaining("DATABASE_URL is deprecated")]);
    expect(cfg({ POSTGRES_URL: PG }).warnings).toEqual([]);
  });

  test("an empty variable counts as unset (the shell's -n)", () => {
    expect(cfg({ POSTGRES_URL: "", MYSQL_URL: MY })).toMatchObject({ kind: "mysql", url: MY });
    expect(cfg({ PERSISTENCE: "", POSTGRES_URL: PG })).toMatchObject({ kind: "postgres", url: PG });
  });

  test("bunvex's names win over Convex's", () => {
    expect(cfg({ PERSISTENCE: "sqlite", POSTGRES_URL: PG })).toMatchObject({ kind: "sqlite", url: undefined });
    expect(cfg({ PERSISTENCE: "mysql", PERSISTENCE_URL: MY, POSTGRES_URL: PG })).toMatchObject({
      kind: "mysql",
      url: MY,
      urlFrom: "PERSISTENCE_URL",
    });
    const other = "postgres://u@other/app";
    expect(cfg({ PERSISTENCE: "postgres", PERSISTENCE_URL: other, POSTGRES_URL: PG })).toMatchObject({ url: other });
  });

  test("PERSISTENCE without PERSISTENCE_URL takes the URL from Convex's name for that driver", () => {
    expect(cfg({ PERSISTENCE: "postgres", POSTGRES_URL: PG })).toMatchObject({ url: PG, urlFrom: "POSTGRES_URL" });
    expect(cfg({ PERSISTENCE: "postgres", MYSQL_URL: MY })).toMatchObject({ url: undefined });
    expect(cfg({ PERSISTENCE: "mysql", MYSQL_URL: MY, POSTGRES_URL: PG })).toMatchObject({ url: MY });
    expect(cfg({ PERSISTENCE: "postgres", DATABASE_URL: PG })).toMatchObject({ url: PG, urlFrom: "DATABASE_URL" });
  });

  test("PERSISTENCE_URL alone does not select a driver (unchanged)", () => {
    expect(cfg({ PERSISTENCE_URL: PG })).toMatchObject({ kind: "memory" });
    expect(cfg({ PERSISTENCE_URL: PG, POSTGRES_URL: MY.replace("mysql", "postgres") })).toMatchObject({
      kind: "postgres",
      urlFrom: "POSTGRES_URL",
    });
  });
});

describe("DO_NOT_REQUIRE_SSL and the CA files", () => {
  test("TLS is required unless DO_NOT_REQUIRE_SSL is set to any non-empty value, as Convex reads it", () => {
    expect(cfg({}).requireSsl).toBe(true);
    expect(cfg({ DO_NOT_REQUIRE_SSL: "" }).requireSsl).toBe(true);
    for (const v of ["1", "true", "yes", "0", "false"]) expect(cfg({ DO_NOT_REQUIRE_SSL: v }).requireSsl).toBe(false);
  });

  test("PG_CA_FILE for Postgres, MYSQL_CA_FILE for MySQL", () => {
    const env = { PG_CA_FILE: "/pg.pem", MYSQL_CA_FILE: "/my.pem" };
    expect(cfg({ ...env, POSTGRES_URL: PG }).caFile).toBe("/pg.pem");
    expect(cfg({ ...env, MYSQL_URL: MY }).caFile).toBe("/my.pem");
    expect(cfg({ ...env, PERSISTENCE: "sqlite" }).caFile).toBeUndefined();
  });
});

describe("the database: the URL's, else the instance's (DV-417, as Convex)", () => {
  test("urlDatabase reads the path", () => {
    expect(urlDatabase("postgres://u:p@h:5432/app?sslmode=require")).toBe("app");
    expect(urlDatabase("postgres://u@h1:5432,h2:5432/app")).toBe("app");
    expect(urlDatabase("postgresql:///app?host=/tmp")).toBe("app");
    expect(urlDatabase("mysql://u@h:3306/my%20db")).toBe("my db");
    expect(urlDatabase("postgres://u@h:5432")).toBeUndefined();
    expect(urlDatabase("postgres://u@h:5432/")).toBeUndefined();
    expect(urlDatabase("mysql://u@h:3306/?ssl=true")).toBeUndefined();
  });

  test("withDatabase sets the path after the authority, before a query or fragment", () => {
    expect(withDatabase("postgres://u:p@h:5432", "app")).toBe("postgres://u:p@h:5432/app");
    expect(withDatabase("postgres://u:p@h:5432/", "app")).toBe("postgres://u:p@h:5432/app");
    expect(withDatabase("postgres://u@h:5432?sslmode=require", "app")).toBe("postgres://u@h:5432/app?sslmode=require");
    expect(withDatabase("mysql://u@h:3306/?ssl=true", "app")).toBe("mysql://u@h:3306/app?ssl=true");
    expect(withDatabase("postgres://u@h:5432#x", "app")).toBe("postgres://u@h:5432/app#x");
    expect(withDatabase("postgres://u@h1:5432,h2:5432", "app")).toBe("postgres://u@h1:5432,h2:5432/app");
    expect(withDatabase("postgres://u@h:5432", "my db")).toBe("postgres://u@h:5432/my%20db");
    // What urlDatabase reads back is the name that was set.
    expect(urlDatabase(withDatabase("postgres://u@h:5432?sslmode=require", "my db"))).toBe("my db");
  });

  test("instanceDatabase is the instance name with - replaced by _ (Convex's)", () => {
    expect(instanceDatabase("bunvex-self-hosted")).toBe("bunvex_self_hosted");
    expect(instanceDatabase("a-b-c")).toBe("a_b_c");
    expect(instanceDatabase("plain")).toBe("plain");
  });

  test("INSTANCE_NAME from the environment is the config's instance name", () => {
    expect(cfg({ POSTGRES_URL: PG, INSTANCE_NAME: "my-app" }).instanceName).toBe("my-app");
    expect(cfg({ POSTGRES_URL: PG, INSTANCE_NAME: "" }).instanceName).toBeUndefined();
    expect(cfg({ POSTGRES_URL: PG }).instanceName).toBeUndefined();
  });

  test("a URL without a database connects to the instance's (no refusal before connecting)", async () => {
    // Nothing listens on port 1: the open fails for the connection, never for a missing database.
    for (const c of [
      { ...cfg({ POSTGRES_URL: "postgres://u@127.0.0.1:1", DO_NOT_REQUIRE_SSL: "1" }), timeoutMs: 2000 },
      { ...cfg({ MYSQL_URL: "mysql://u@127.0.0.1:1/", DO_NOT_REQUIRE_SSL: "1" }), timeoutMs: 2000 },
    ]) {
      let err: unknown;
      try {
        await (await openPersistence(c)).close();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).not.toMatch(/names no database/);
    }
  });

  test("no URL at all names both variables", async () => {
    let err: unknown;
    try {
      await openPersistence(cfg({ PERSISTENCE: "postgres" }));
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("PERSISTENCE=postgres needs PERSISTENCE_URL (or POSTGRES_URL)");
  });
});

// Against a real Postgres (PG_URL, any database on the server; DO_NOT_REQUIRE_SSL for a server without TLS):
// a URL without a database opens the instance's.
const PG_URL = process.env.PG_URL;
describe.if(!!PG_URL)("DV-417 on a real Postgres (PG_URL)", () => {
  test("the instance name's database, with - replaced by _", async () => {
    // The server package does not depend on the native driver: the admin statements go through a store's pool.
    const adminStore = await openPersistence({
      kind: "postgres",
      url: PG_URL,
      requireSsl: !process.env.DO_NOT_REQUIRE_SSL,
      pool: 1,
    });
    const admin = (adminStore as unknown as { sql: { unsafe(q: string): Promise<unknown> } }).sql;
    const name = "k-dv417-test";
    const db = instanceDatabase(name);
    try {
      await admin.unsafe(`drop database if exists ${db}`);
      await admin.unsafe(`create database ${db}`);
      const server = PG_URL!.replace(/^([a-z]+:\/\/[^/?#]*)\/[^?#]*/i, "$1");
      const store = await openPersistence({
        kind: "postgres",
        url: server,
        requireSsl: !process.env.DO_NOT_REQUIRE_SSL,
        pool: 2,
        instanceName: name,
      });
      try {
        const sql = (store as unknown as { sql: { unsafe(q: string): Promise<Record<string, unknown>[]> } }).sql;
        const [r] = await sql.unsafe(`select current_database() as d, to_regclass('documents') is not null as t`);
        expect(r).toEqual({ d: db, t: true });
      } finally {
        await store.close();
      }
    } finally {
      await admin.unsafe(`drop database if exists ${db} with (force)`).catch(() => {});
      await adminStore.close();
    }
  });
});
if (!PG_URL) console.log("persistence-config: set PG_URL (and DO_NOT_REQUIRE_SSL) to run the DV-417 Postgres test");

describe("call timeouts (STUDY-25 L3)", () => {
  test("each remote driver reads its call timeout from its own variable, in seconds", () => {
    expect(persistenceConfigFromEnv({ PERSISTENCE: "postgres", POSTGRES_TIMEOUT_SECONDS: "5" }).timeoutMs).toBe(5000);
    expect(persistenceConfigFromEnv({ PERSISTENCE: "mysql", MYSQL_TIMEOUT_SECONDS: "2.5" }).timeoutMs).toBe(2500);
    expect(persistenceConfigFromEnv({ PERSISTENCE: "mongodb", MONGODB_TIMEOUT_SECONDS: "7" }).timeoutMs).toBe(7000);
    // another driver's variable is ignored; unset leaves the driver's default
    expect(persistenceConfigFromEnv({ PERSISTENCE: "postgres", MYSQL_TIMEOUT_SECONDS: "5" }).timeoutMs).toBeUndefined();
    expect(persistenceConfigFromEnv({ PERSISTENCE: "sqlite" }).timeoutMs).toBeUndefined();
  });

  test("a driver selected by Convex's URL name reads its timeout too", () => {
    expect(cfg({ POSTGRES_URL: PG, POSTGRES_TIMEOUT_SECONDS: "4" }).timeoutMs).toBe(4000);
    expect(cfg({ MYSQL_URL: MY, MYSQL_TIMEOUT_SECONDS: "3" }).timeoutMs).toBe(3000);
  });
});

describe("opening the local drivers", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const schema = defineSchema({ notes: defineTable(v.any()) });
  const roundTrip = async (kind: string, file: string) => {
    const dataDir = join(mkdtempSync(join(tmpdir(), `bunvex-${kind}-`)), "nested", "data");
    dirs.push(dataDir);
    const first = await new Engine(schema, await openPersistence({ kind, dataDir })).init();
    await first.mutation((db) => db.insert("notes", { body: kind }));
    await first.close();
    // The data directory is created, and a durable store is read back by the next process.
    expect(existsSync(join(dataDir, file))).toBe(true);
    const again = await new Engine(schema, await openPersistence({ kind, dataDir })).init();
    expect((await again.query((db) => db.query("notes").collect())).map((d) => d.body)).toEqual([kind]);
    await again.close();
  };

  test("memory keeps its log in the data directory", () => roundTrip("memory", "bunvex.log"));
  test("sqlite keeps its file in the data directory", () => roundTrip("sqlite", "bunvex.sqlite"));

  test("an unknown driver is refused, listing the known ones; MongoDB needs a URL", async () => {
    await expect(openPersistence({ kind: "oracle" })).rejects.toThrow(
      "unknown PERSISTENCE=oracle (memory, sqlite, postgres, mysql, mongodb)",
    );
    await expect(openPersistence({ kind: "mongodb" })).rejects.toThrow(/^PERSISTENCE=mongodb needs PERSISTENCE_URL$/);
  });
});
