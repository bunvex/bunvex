// A bunvex server process for the Jepsen-style runs (STUDY-57 §3.1): the workload's functions, persistence
// chosen by the same environment as the real server (PERSISTENCE=memory|sqlite|postgres|mysql|mongodb,
// PERSISTENCE_URL, DATA, DURABLE), on PORT. A separate process so the nemesis can kill it (SIGKILL) and
// start it again on the same data. Prints "ready <port>" once it serves.
import { Engine } from "@bunvex/core";
import { createServer, Functions, openPersistence, persistenceConfigFromEnv } from "@bunvex/server";
import { bank, log, reg, schema, set } from "./functions.ts";

const config = persistenceConfigFromEnv();
const engine = await new Engine(schema, await openPersistence(config), {
  // a killed predecessor's lease must not block the restart for its whole TTL
  lease: { ttlMs: Number(process.env.LEASE_TTL_MS ?? 2000), waitMs: Number(process.env.LEASE_WAIT_MS ?? 10_000) },
}).init();
const functions = new Functions(engine)
  .register("reg", reg)
  .register("bank", bank)
  .register("set", set)
  .register("log", log);
const app = createServer({ engine, functions, port: Number(process.env.PORT ?? 0), label: config.kind });
process.once("SIGTERM", async () => {
  await app.shutdown();
  process.exit(0);
});
console.log(`ready ${app.server.port}`);
