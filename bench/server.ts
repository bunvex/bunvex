// The convex-bench server: the benchmark's functions on a bunvex server, persistence chosen by env
// (PERSISTENCE=memory|sqlite|postgres|mysql|mongodb, PERSISTENCE_URL, DATA, DURABLE, POOL, PORT).
//   PERSISTENCE=sqlite bun bench/server.ts
import { Engine } from "@bunvex/core";
import { createServer, Functions, openPersistence, persistenceConfigFromEnv } from "bunvex/server";
import { bench, benchSchema } from "./functions.ts";

const config = persistenceConfigFromEnv();
const engine = await new Engine(benchSchema, await openPersistence(config), {
  cacheMax: Number(process.env.CACHE_MAX ?? 1000),
}).init();
const functions = new Functions(engine).register("bench", bench);
createServer({ engine, functions, port: Number(process.env.PORT ?? 3210), label: config.kind });
console.log(`bunvex: persistence=${config.kind} durable=${config.durable} port=${process.env.PORT ?? 3210}`);
