// Choosing the persistence driver by configuration (ARCH-01 D3/D-D):
//   PERSISTENCE=memory|sqlite            ship with @bunvex/core
//   PERSISTENCE=postgres|mysql|mongodb   from @bunvex/persistence (plus the driver's native package)
//   PERSISTENCE_URL=…                    for the external ones
//   DATA=./.data  DURABLE=1  POOL=16
//   POSTGRES_TIMEOUT_SECONDS=30  MYSQL_TIMEOUT_SECONDS=19  MONGODB_TIMEOUT_SECONDS=30
//                                        the client-side timeout of one database call (STUDY-25 L3); the
//                                        first two are Convex's names and defaults
//
// Convex's names are accepted too (DV-88; self-hosted/docker-build/run_backend.sh:17-32): when PERSISTENCE
// is not set, POSTGRES_URL selects Postgres, else MYSQL_URL selects MySQL, else DATABASE_URL (deprecated
// there) selects Postgres. bunvex's names win when both are set. A Postgres or MySQL URL without a database
// connects to the instance name's, `-` replaced by `_`, as Convex's (crates/clusters/src/lib.rs; DV-417); a
// URL that names one keeps it (Convex refuses such a URL).
//
// TLS (STUDY-25 L8, DV-109), as Convex (crates/local_backend/src/config.rs:114-118, run_backend.sh:68):
// Postgres and MySQL connections are encrypted and the certificate verified, unless DO_NOT_REQUIRE_SSL is
// set to any non-empty value (`0` and `false` too, as the shell's `${VAR:+…}` reads it). PG_CA_FILE and
// MYSQL_CA_FILE add a trusted CA. MongoDB has no Convex counterpart: its URL decides (`tls=true`).
import { mkdirSync } from "node:fs";
import { bundledModule, DEFAULT_INSTANCE_NAME, type Persistence } from "@bunvex/core";

export type PersistenceConfig = {
  kind: string;
  url?: string;
  /** The env var the URL came from, for messages ("PERSISTENCE_URL", "POSTGRES_URL", …). */
  urlFrom?: string;
  dataDir?: string;
  durable?: boolean;
  pool?: number;
  /** Postgres and MySQL: require an encrypted, verified connection (default true; DO_NOT_REQUIRE_SSL). */
  requireSsl?: boolean;
  /** Postgres and MySQL: a PEM file of extra trusted CA certificates (PG_CA_FILE, MYSQL_CA_FILE). */
  caFile?: string;
  /** The client-side timeout of one database call, for the remote drivers (default: each driver's). */
  timeoutMs?: number;
  /** The deployment's name (`--instance-name`, INSTANCE_NAME): its database when the URL names none. */
  instanceName?: string;
};

/** The environment variable that sets each remote driver's call timeout, in seconds. */
const TIMEOUT_ENV: Record<string, string> = {
  postgres: "POSTGRES_TIMEOUT_SECONDS",
  mysql: "MYSQL_TIMEOUT_SECONDS",
  mongodb: "MONGODB_TIMEOUT_SECONDS",
};

type Env = Record<string, string | undefined>;
/** Set and non-empty: an empty variable counts as unset (the shell's `-n` test). */
const set = (env: Env, name: string) => (env[name] ? env[name] : undefined);

export function persistenceConfigFromEnv(
  env: Env = process.env,
  warn: (message: string) => void = console.warn,
): PersistenceConfig {
  let kind = set(env, "PERSISTENCE");
  let url: string | undefined;
  let urlFrom: string | undefined;
  const from = (name: string) => {
    if (url === undefined && set(env, name)) {
      url = env[name];
      urlFrom = name;
    }
  };
  if (kind) {
    // bunvex's pair; Convex's name for the same driver fills in a missing PERSISTENCE_URL.
    from("PERSISTENCE_URL");
    if (kind === "postgres") from("POSTGRES_URL");
    if (kind === "mysql") from("MYSQL_URL");
    if (kind === "postgres") from("DATABASE_URL");
  } else if (set(env, "POSTGRES_URL")) {
    kind = "postgres";
    from("POSTGRES_URL");
  } else if (set(env, "MYSQL_URL")) {
    kind = "mysql";
    from("MYSQL_URL");
  } else if (set(env, "DATABASE_URL")) {
    kind = "postgres";
    from("DATABASE_URL");
  }
  if (urlFrom === "DATABASE_URL")
    warn("DATABASE_URL is deprecated: use PERSISTENCE=postgres with PERSISTENCE_URL, or POSTGRES_URL");
  kind ??= "memory";
  const timeout = TIMEOUT_ENV[kind] && env[TIMEOUT_ENV[kind]];
  const caFile =
    kind === "postgres" ? set(env, "PG_CA_FILE") : kind === "mysql" ? set(env, "MYSQL_CA_FILE") : undefined;
  return {
    kind,
    url,
    urlFrom,
    dataDir: env.DATA ?? "./.data",
    durable: env.DURABLE !== "0",
    pool: Number(env.POOL ?? 16),
    requireSsl: !set(env, "DO_NOT_REQUIRE_SSL"),
    caFile,
    ...(timeout ? { timeoutMs: Number(timeout) * 1000 } : {}),
    ...(set(env, "INSTANCE_NAME") ? { instanceName: env.INSTANCE_NAME } : {}),
  };
}

/** The URL with `database` as its path (Convex's `set_path`): after the authority, before a query or fragment. */
export function withDatabase(url: string, database: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)\/?([?#].*)?$/i.exec(url);
  if (!m) throw new Error(`cannot add a database to ${url}`);
  return `${m[1]}/${encodeURIComponent(database)}${m[2] ?? ""}`;
}

/** Convex's database name for an instance: its name with `-` replaced by `_`. */
export const instanceDatabase = (instanceName: string) => instanceName.replaceAll("-", "_");

/** The database a Postgres or MySQL URL names (its path), or undefined. */
export function urlDatabase(url: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\/([^?#]*)/i.exec(url);
  const name = m?.[1] ? decodeURIComponent(m[1]) : "";
  return name || undefined;
}

export async function openPersistence(c: PersistenceConfig): Promise<Persistence> {
  const durable = c.durable ?? true;
  const dir = c.dataDir ?? "./.data";
  const tls = { requireSsl: c.requireSsl ?? true, caFile: c.caFile };
  const needUrl = () => {
    if (!c.url) {
      const alias = c.kind === "postgres" ? " (or POSTGRES_URL)" : c.kind === "mysql" ? " (or MYSQL_URL)" : "";
      throw new Error(`PERSISTENCE=${c.kind} needs PERSISTENCE_URL${alias}`);
    }
    return c.url;
  };
  // DV-417, as Convex: a URL without a database (Convex's POSTGRES_URL / MYSQL_URL are written so) connects to
  // the instance's, its name with `-` replaced by `_`; the default name's when none is configured, as the
  // engine runs with it. A URL that names a database keeps it.
  const needDatabase = () => {
    const url = needUrl();
    if (urlDatabase(url)) return url;
    return withDatabase(url, instanceDatabase(c.instanceName || DEFAULT_INSTANCE_NAME));
  };
  switch (c.kind) {
    case "memory": {
      mkdirSync(dir, { recursive: true });
      const { MemoryPersistence } = await import("@bunvex/core/persistence/memory");
      return MemoryPersistence.open(`${dir}/bunvex.log`, { durable });
    }
    case "sqlite": {
      mkdirSync(dir, { recursive: true });
      const { SqlitePersistence } = await import("@bunvex/core/persistence/sqlite");
      return new SqlitePersistence(`${dir}/bunvex.sqlite`, { durable });
    }
    case "postgres": {
      const { PostgresPersistence } = await external<Driver<"PostgresPersistence">>("postgres");
      return PostgresPersistence.open(needDatabase(), c.pool, { ...tls, timeoutMs: c.timeoutMs });
    }
    case "mysql": {
      const { MysqlPersistence } = await external<Driver<"MysqlPersistence">>("mysql");
      return MysqlPersistence.open(needDatabase(), c.pool, { ...tls, timeoutMs: c.timeoutMs });
    }
    case "mongodb": {
      const { MongoPersistence } = await external<Driver<"MongoPersistence">>("mongodb");
      return MongoPersistence.open(needUrl(), { pool: c.pool, timeoutMs: c.timeoutMs });
    }
    default:
      throw new Error(`unknown PERSISTENCE=${c.kind} (memory, sqlite, postgres, mysql, mongodb)`);
  }
}

/**
 * What the server uses of an @bunvex/persistence driver, typed here: the package is optional, and an app that
 * does not install it still typechecks the server's sources (STUDY-40, published as TypeScript).
 */
// biome-ignore lint/suspicious/noExplicitAny: each driver's open() takes its own options
type Driver<Name extends string> = { [K in Name]: { open(url: string, ...rest: any[]): Promise<Persistence> } };

/** @bunvex/persistence is an optional dependency of the server: loaded only when an external driver is asked for. */
async function external<T>(name: string): Promise<T> {
  // A standalone executable carries the drivers (STUDY-39).
  const bundled = bundledModule<T>(`@bunvex/persistence/${name}`);
  if (bundled) return bundled;
  try {
    return (await import(`@bunvex/persistence/${name}`)) as T;
  } catch (e) {
    if (/Cannot find (package|module)/.test(String(e)))
      throw new Error(`PERSISTENCE=${name} needs @bunvex/persistence: bun add @bunvex/persistence`);
    throw e;
  }
}
