// Choosing the persistence driver by configuration (ARCH-01 D3/D-D):
//   PERSISTENCE=memory|sqlite            ship with @bunvex/core
//   PERSISTENCE=postgres|mysql|mongodb   from @bunvex/persistence (plus the driver's native package)
//   PERSISTENCE_URL=…                    for the external ones
//   DATA=./.data  DURABLE=1  POOL=16
import { mkdirSync } from "node:fs";
import type { Persistence } from "@bunvex/core";

export type PersistenceConfig = {
  kind: string;
  url?: string;
  dataDir?: string;
  durable?: boolean;
  pool?: number;
};

export function persistenceConfigFromEnv(env: Record<string, string | undefined> = process.env): PersistenceConfig {
  return {
    kind: env.PERSISTENCE ?? "memory",
    url: env.PERSISTENCE_URL,
    dataDir: env.DATA ?? "./.data",
    durable: env.DURABLE !== "0",
    pool: Number(env.POOL ?? 16),
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
      return PostgresPersistence.open(needUrl(), c.pool);
    }
    case "mysql": {
      const { MysqlPersistence } = await external<typeof import("@bunvex/persistence/mysql")>("mysql");
      return MysqlPersistence.open(needUrl(), c.pool);
    }
    case "mongodb": {
      const { MongoPersistence } = await external<typeof import("@bunvex/persistence/mongodb")>("mongodb");
      return MongoPersistence.open(needUrl(), { pool: c.pool });
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
