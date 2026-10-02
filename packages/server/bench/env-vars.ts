// The cost of `process.env` in pushed code (STUDY-37): every query and mutation of a code version reads the
// deployment's variables first (from a cache valid until a commit writes them). Runs N uncached queries
// (distinct arguments) of pushed code, with and without the variables, and N that read one variable.
//   bun packages/server/bench/env-vars.ts
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { CodeVersion } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";

const N = Number(process.env.N ?? 20_000);
const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
await engine.mutation((db) =>
  engine.environment.update(
    db,
    Array.from({ length: 20 }, (_, i) => ({ name: `VAR_${i}`, value: "x".repeat(64) })),
  ),
);
const version = await CodeVersion.load(
  [
    {
      path: "m.js",
      environment: "isolate",
      source: `import { query } from "@bunvex/server";
        export const plain = query(async (_, { i }) => i);
        export const reads = query(async (_, { i }) => (process.env.VAR_3 ?? "").length + i);`,
    },
  ],
  { seed: new Uint32Array(4), timestamp: 0 },
);
const run = async (label: string, f: Functions, name: string) => {
  for (let i = 0; i < 1000; i++) await f.runQuery(name, { i: -i - 1 }, false); // warm up
  const t = performance.now();
  for (let i = 0; i < N; i++) await f.runQuery(name, { i }, false);
  const us = ((performance.now() - t) * 1000) / N;
  console.log(`${label.padEnd(44)} ${us.toFixed(2)} µs/query`);
};
const withEnv = new Functions(engine);
withEnv.install(version.functions, version.moduleHashes);
// The same code, registered (embedded): no deployment variables.
const without = new Functions(engine).register(
  "m",
  Object.fromEntries([...version.functions].map(([k, v]) => [k.split(":")[1]!, v])),
);
await run("pushed, variables preloaded (cache)", withEnv, "m:plain");
await run("embedded, no variables", without, "m:plain");
await run("pushed, reads one variable", withEnv, "m:reads");
await engine.close();
