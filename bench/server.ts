// The convex-bench server: the benchmark's functions on a bunvex server, persistence chosen by env
// (PERSISTENCE=memory|sqlite|postgres|mysql|mongodb, PERSISTENCE_URL, DATA, DURABLE, POOL, PORT; Convex's
// POSTGRES_URL / MYSQL_URL too). TLS is required by default: DO_NOT_REQUIRE_SSL=1 for a local store without it.
//   PERSISTENCE=sqlite bun bench/server.ts
import { Engine } from "@bunvex/core";
import { createServer, Functions, openPersistence, persistenceConfigFromEnv } from "bunvex/server";
import { bench, benchSchema } from "./functions.ts";

// The benchmark measures capacity: Convex's 4 MiB/s write throughput limit (MAX_BYTES_WRITTEN_PER_SECOND,
// STUDY-78) is lifted unless the environment sets it, so runs compare with those before the limit existed.
// MAX_BYTES_WRITTEN_PER_SECOND=4194304 measures with Convex's default.
process.env.MAX_BYTES_WRITTEN_PER_SECOND ||= String(Number.MAX_SAFE_INTEGER);
const config = persistenceConfigFromEnv();
const engine = await new Engine(benchSchema, await openPersistence(config), {
  // The query cache's byte budget comes from UDF_CACHE_MAX_SIZE (default 100 MiB), as in Convex.
  instanceSecret: process.env.INSTANCE_SECRET,
  instanceName: process.env.INSTANCE_NAME,
  // PERSIST-01 C7: the store's lease (drivers that have one). LEASE_WAIT_MS > 0 waits for a held lease.
  lease: { ttlMs: Number(process.env.LEASE_TTL_MS ?? 5000), waitMs: Number(process.env.LEASE_WAIT_MS ?? 0) },
}).init();
const functions = new Functions(engine).register("bench", bench);
const app = createServer({ engine, functions, port: Number(process.env.PORT ?? 3210), label: config.kind });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await app.shutdown();
    process.exit(0);
  });
console.log(
  `bunvex: persistence=${config.kind} durable=${config.durable} port=${process.env.PORT ?? 3210} ` +
    `max-bytes-written-per-second=${process.env.MAX_BYTES_WRITTEN_PER_SECOND}`,
);
