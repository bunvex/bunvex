#!/usr/bin/env bun
// Run the Jepsen-style workload (STUDY-57) from the command line:
//   bun packages/jepsen/src/cli.ts [--store memory|sqlite|postgres|mysql|mongodb] [--seconds 10]
//     [--clients 5] [--seed N] [--runs 1] [--nemesis none|partition|kill|skew|store|all]
// Remote stores take the server's environment (PERSISTENCE_URL, DO_NOT_REQUIRE_SSL, …). Each run prints a
// line; a failed one also prints its findings and writes .data/jepsen/<store>-<nemesis>-<seed>.json. Exits 1
// if any run failed.
import { parseArgs } from "node:util";
import { nemesisByName } from "./nemesis.ts";
import { describe, writeReport } from "./report.ts";
import { run } from "./runner.ts";

const { values } = parseArgs({
  options: {
    store: { type: "string", default: "memory" },
    seconds: { type: "string", default: "10" },
    clients: { type: "string", default: "5" },
    seed: { type: "string" },
    runs: { type: "string", default: "1" },
    nemesis: { type: "string", default: "none" },
  },
});

let failed = false;
const first = values.seed ? Number(values.seed) : Math.floor(Math.random() * 2 ** 31);
for (let i = 0; i < Number(values.runs); i++) {
  const seed = first + i;
  const result = await run({
    seed,
    store: values.store!,
    clients: Number(values.clients),
    durationMs: Number(values.seconds) * 1000,
    nemesis: nemesisByName(values.nemesis!),
  });
  console.log(describe(result));
  if (!result.ok) {
    failed = true;
    console.log(`  report: ${writeReport(result)}`);
  }
}
process.exit(failed ? 1 : 0);
