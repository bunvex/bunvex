#!/usr/bin/env bun
// Run the Jepsen-style workload (STUDY-57) from the command line:
//   bun packages/jepsen/src/cli.ts [--store memory|sqlite|postgres|mysql|mongodb] [--seconds 10]
//     [--clients 5] [--seed N] [--runs 1 | --minutes M] [--nemesis none|partition|kill|skew|store|all[,…]]
//     [--summary failures.md]
// Several nemeses, comma-separated, take turns run by run; `--minutes` keeps starting runs until the time is
// up (the nightly run, STUDY-57 §5). A remote store takes PERSISTENCE_URL (and DO_NOT_REQUIRE_SSL, …) and
// gets a fresh database "jepsen" beside the one it names for each run. Each run prints a line; a failed one
// also prints its findings and writes .data/jepsen/<store>-<nemesis>-<seed>.json (and, with --summary, a
// Markdown section for an issue). Exits 1 if any run failed.
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { freshDatabase } from "./fresh-db.ts";
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
    minutes: { type: "string" },
    nemesis: { type: "string", default: "none" },
    summary: { type: "string" },
  },
});

const store = values.store!;
const remote = !["memory", "sqlite"].includes(store);
const nemeses = values.nemesis!.split(",");
for (const n of nemeses) nemesisByName(n); // an unknown name fails before any run
const deadline = values.minutes ? performance.now() + Number(values.minutes) * 60_000 : Infinity;
const runs = values.minutes ? Infinity : Number(values.runs);

let failed = 0;
let done = 0;
const first = values.seed ? Number(values.seed) : Math.floor(Math.random() * 2 ** 31);
for (let i = 0; i < runs && performance.now() < deadline; i++) {
  const seed = first + i;
  const nemesis = nemeses[i % nemeses.length]!;
  const env: Record<string, string> = {};
  if (remote) {
    const base = process.env.PERSISTENCE_URL;
    if (!base) throw new Error(`--store ${store} needs PERSISTENCE_URL`);
    env.PERSISTENCE_URL = await freshDatabase(store, base, "jepsen");
    // a killed server's lease must not hold its successor back for long
    env.LEASE_TTL_MS = process.env.LEASE_TTL_MS ?? "1000";
  }
  const result = await run({
    seed,
    store,
    env,
    clients: Number(values.clients),
    durationMs: Number(values.seconds) * 1000,
    nemesis: nemesisByName(nemesis),
  });
  done++;
  const text = describe(result);
  console.log(text);
  if (!result.ok) {
    failed++;
    const report = writeReport(result);
    console.log(`  report: ${report}`);
    if (values.summary)
      appendFileSync(
        values.summary,
        `### ${store}, nemesis ${nemesis}, seed ${seed}\n\n\`\`\`\n${text}\n\`\`\`\n\nFull history: \`${report}\` (workflow artifact).\n\n`,
      );
  }
}
console.log(`${done} runs, ${failed} failed`);
process.exit(failed ? 1 : 0);
