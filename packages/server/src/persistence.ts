// Choosing the persistence driver by configuration (ARCH-01 D3/D-D):
//   PERSISTENCE=memory|sqlite            ship with @bunvex/core
//   PERSISTENCE=postgres|mysql|mongodb   from @bunvex/persistence (plus the driver's native package)
//   PERSISTENCE_URL=…                    for the external ones
//   DATA=./.data  DURABLE=1  POOL=16
//   POSTGRES_TIMEOUT_SECONDS=30  MYSQL_TIMEOUT_SECONDS=19  MONGODB_TIMEOUT_SECONDS=30
//                                        the client-side timeout of one database call (STUDY-25 L3); the
//                                        first two are Convex's names and defaults
import { mkdirSync } from "node:fs";
import type { Persistence } from "@bunvex/core";

export type PersistenceConfig = {
  kind: string;
  url?: string;
  dataDir?: string;
  durable?: boolean;
  pool?: number;
  /** The client-side timeout of one database call, for the remote drivers (default: each driver's). */
  timeoutMs?: number;
};

/** The environment variable that sets each remote driver's call timeout, in seconds. */
const TIMEOUT_ENV: Record<string, string> = {
  postgres: "POSTGRES_TIMEOUT_SECONDS",
  mysql: "MYSQL_TIMEOUT_SECONDS",
  mongodb: "MONGODB_TIMEOUT_SECONDS",
};

export function persistenceConfigFromEnv(env: Record<string, string | undefined> = process.env): PersistenceConfig {
  const kind = env.PERSISTENCE ?? "memory";
  const timeout = TIMEOUT_ENV[kind] && env[TIMEOUT_ENV[kind]];
  return {
    kind,
    url: env.PERSISTENCE_URL,
    dataDir: env.DATA ?? "./.data",
    durable: env.DURABLE !== "0",
    pool: Number(env.POOL ?? 16),
    ...(timeout ? { timeoutMs: Number(timeout) * 1000 } : {}),
  };
}

export async function openPersistence(c: PersistenceConfig): Promise<Persistence> {
  const durable = c.durable ?? true;
  const dir = c.dataDir ?? "./.data";
  const needUrl = () => {
    if (!c.url) throw new Error(`PERSISTENCE=${c.kind} needs PERSISTENCE_URL`);
    return c.url;
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
      const { PostgresPersistence } = await external<typeof import("@bunvex/persistence/postgres")>("postgres");
      return PostgresPersistence.open(needUrl(), c.pool, { timeoutMs: c.timeoutMs });
    }
    case "mysql": {
      const { MysqlPersistence } = await external<typeof import("@bunvex/persistence/mysql")>("mysql");
      return MysqlPersistence.open(needUrl(), c.pool, { timeoutMs: c.timeoutMs });
    }
    case "mongodb": {
      const { MongoPersistence } = await external<typeof import("@bunvex/persistence/mongodb")>("mongodb");
      return MongoPersistence.open(needUrl(), { pool: c.pool, timeoutMs: c.timeoutMs });
    }
    default:
      throw new Error(`unknown PERSISTENCE=${c.kind} (memory, sqlite, postgres, mysql, mongodb)`);
  }
}

/** @bunvex/persistence is an optional dependency of the server: loaded only when an external driver is asked for. */
async function external<T>(name: string): Promise<T> {
  try {
    return (await import(`@bunvex/persistence/${name}`)) as T;
  } catch (e) {
    if (/Cannot find (package|module)/.test(String(e)))
      throw new Error(`PERSISTENCE=${name} needs @bunvex/persistence: bun add @bunvex/persistence`);
    throw e;
  }
}
