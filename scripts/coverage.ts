// `bun run coverage` (TEST-01 §4): the root `bun test` with line coverage (lcov), a table per package and
// one per critical file, and a failure when a critical file is below its floor (scripts/coverage-floors.ts).
//
//   bun run coverage               run the tests, print the tables, check the floors
//   bun run coverage --lcov <file> read an existing lcov report instead of running the tests
//
// Bun reports only the files the tests load; a critical file no test loads is reported as missing and fails.
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOORS } from "./coverage-floors.ts";

type FileCov = { lines: number; hit: number };

function parseLcov(text: string): Map<string, FileCov> {
  const files = new Map<string, FileCov>();
  let current: string | null = null;
  let cov: FileCov = { lines: 0, hit: 0 };
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = line.slice(3).replace(/^\.\//, "");
      cov = { lines: 0, hit: 0 };
    } else if (line.startsWith("LF:")) cov.lines = Number(line.slice(3));
    else if (line.startsWith("LH:")) cov.hit = Number(line.slice(3));
    else if (line === "end_of_record" && current) {
      files.set(current, cov);
      current = null;
    }
  }
  return files;
}

const pct = (c: FileCov) => (c.lines ? (100 * c.hit) / c.lines : 100);
const fmt = (n: number) => n.toFixed(2).padStart(6);

function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [line(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line)].join("\n");
}

async function runTests(): Promise<{ lcov: string; ok: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-coverage-"));
  try {
    const p = Bun.spawn(["bun", "test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const ok = (await p.exited) === 0;
    return { lcov: readFileSync(join(dir, "lcov.info"), "utf8"), ok };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const given = args.indexOf("--lcov");
const { lcov, ok: testsOk } =
  given >= 0 ? { lcov: readFileSync(args[given + 1]!, "utf8"), ok: true } : await runTests();
const files = parseLcov(lcov);

const packages = new Map<string, FileCov>();
for (const [file, c] of files) {
  const m = /^(packages|apps)\/([^/]+)\//.exec(file);
  if (!m) continue;
  const name = `${m[1]}/${m[2]}`;
  const p = packages.get(name) ?? { lines: 0, hit: 0 };
  packages.set(name, { lines: p.lines + c.lines, hit: p.hit + c.hit });
}
const byPackage = () =>
  table(
    ["package", "lines", "hit", "%"],
    [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => [n, `${c.lines}`, `${c.hit}`, fmt(pct(c))]),
  );

const out: string[] = [];
const print = (s: string) => {
  console.log(s);
  out.push(s);
};
const failures: string[] = [];
const rows = Object.entries(FLOORS).map(([file, f]) => {
  const c = files.get(file);
  if (!c) {
    failures.push(`${file}: not in the report (no test loads it, or the file moved: update coverage-floors.ts)`);
    return [file, f.area, "  -", fmt(f.floor), "MISSING"];
  }
  const p = pct(c);
  if (p < f.floor) failures.push(`${file}: ${p.toFixed(2)}% of lines, below its floor of ${f.floor}% (${f.why})`);
  return [file, f.area, fmt(p), fmt(f.floor), p < f.floor ? "BELOW" : "ok"];
});
print("\n## Critical files (floors: scripts/coverage-floors.ts)\n");
print(table(["file", "area", "%", "floor", ""], rows));
print("\n## Line coverage by package (files the root `bun test` loads)\n");
print(byPackage());
// On GitHub Actions, the tables also go to the job's summary page.
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out.join("\n")}\n`);

if (!testsOk) failures.unshift("the tests failed");
if (failures.length) {
  console.error(`\ncoverage check failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\ncoverage check passed");
