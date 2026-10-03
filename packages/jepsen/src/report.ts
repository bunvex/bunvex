// What a failed run leaves behind (STUDY-57 §3.6): the seed that reproduces it, the findings, the smallest
// failing register history, the nemesis' actions and the server's output — as a JSON file and a summary.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Op } from "./history.ts";
import type { RunResult } from "./runner.ts";

const short = (o: Op) => ({
  client: o.client,
  f: o.f,
  args: o.args,
  status: o.status,
  result: o.result,
  error: o.error?.split("\n")[0],
  start: Math.round(o.start * 10) / 10,
  end: o.end === Infinity ? null : Math.round(o.end * 10) / 10,
});

/** One line, then the findings: what a test failure or the CLI prints. */
export function describe(r: RunResult): string {
  const lines = [
    `${r.ok ? "PASS" : "FAIL"} seed=${r.seed} store=${r.store} nemesis=${r.nemesis} ${r.durationMs} ms, ` +
      `${r.stats.ops} ops (ok ${r.stats.ok}, fail ${r.stats.fail}, info ${r.stats.info})`,
    ...r.violations.map((v) => `  ${v}`),
  ];
  if (!r.linearizability.ok)
    lines.push(
      `  smallest failing history (${r.linearizability.minimal.length} ops):`,
      ...r.linearizability.minimal.map((o) => `    ${JSON.stringify(short(o))}`),
    );
  lines.push(`  reproduce: bun packages/jepsen/src/cli.ts --store ${r.store} --nemesis ${r.nemesis} --seed ${r.seed}`);
  return lines.join("\n");
}

/** Write the full report; returns its path. */
export function writeReport(r: RunResult, dir = ".data/jepsen"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${r.store}-${r.nemesis}-${r.seed}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...r,
        history: r.history.map(short),
        linearizability: r.linearizability.ok
          ? r.linearizability
          : {
              ...r.linearizability,
              ops: r.linearizability.ops.map(short),
              minimal: r.linearizability.minimal.map(short),
            },
      },
      null,
      1,
    ),
  );
  return path;
}
