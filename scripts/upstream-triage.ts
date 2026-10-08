// The daily triage of Convex's new commits (STUDY-138): every commit of get-convex/convex-backend after the
// parity reference (docs/parity/upstream.md) is sorted by the paths it touches and the words of its subject:
//
// - urgent: a fix, revert or security change in the runtime, the database or the client package. Each gets its
//   own issue, studied before the weekly bump;
// - weekly: anything else that reaches what an app observes (runtime, client package, CLI, dashboard, the web
//   APIs functions see). Studied in the weekly reference bump;
// - ignored: docs, demos, cloud-only crates, tests and tooling.
//
// It reads a local clone: `bun scripts/upstream-triage.ts --repo ../convex-backend [--from <ref>] [--to <ref>]
// [--json]`. Without --from it takes the reference from docs/parity/upstream.md.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Kind = "urgent" | "weekly" | "ignored";
export type Area = "runtime" | "client" | "web" | "dashboard" | "other";
export type Commit = { sha: string; date: string; subject: string; files: string[] };
export type Triaged = Commit & { kind: Kind; areas: Area[] };

/** Paths whose changes an app or an operator of bunvex can observe, by area. Longest prefix wins. */
const AREAS: [string, Area][] = [
  ["npm-packages/convex/", "client"],
  ["npm-packages/system-udfs/", "runtime"],
  ["npm-packages/node-executor/", "runtime"],
  ["npm-packages/udf-runtime/", "web"],
  ["npm-packages/dashboard-common/", "dashboard"],
  ["npm-packages/dashboard-self-hosted/", "dashboard"],
  ["npm-packages/dashboard/", "dashboard"],
  ["crates/webcrypto/", "web"],
  ["crates/", "runtime"],
  ["self-hosted/", "runtime"],
];

/** Crates that only the cloud product runs, or that only build and test the backend. */
const IGNORED_CRATES = new Set([
  "managed_export",
  "ai_gateway_jwt",
  "pb_build",
  "workos_client",
  "usage_tracking",
  "fivetran_source",
  "fivetran_destination",
  "airbyte_import",
  "scenario_runner",
  "load_generator",
  "convex_macro",
  "metrics",
]);

/** Where an urgent fix matters most: the engine, the function runtime and the client's protocol. */
const CORE = [
  "crates/database/",
  "crates/isolate/",
  "crates/udf/",
  "crates/value/",
  "crates/common/",
  "crates/model/",
  "crates/application/",
  "crates/sync/",
  "crates/sync_types/",
  "crates/convex/sync_types/",
  "crates/search/",
  "crates/indexing/",
  "crates/function_runner/",
  "crates/local_backend/",
  "crates/sqlite/",
  "crates/postgres/",
  "crates/mysql/",
  "crates/storage/",
  "crates/file_storage/",
  "crates/keybroker/",
  "npm-packages/convex/src/server/",
  "npm-packages/convex/src/values/",
  "npm-packages/convex/src/browser/",
  "npm-packages/convex/src/react/",
];

const URGENT_WORDS =
  /\b(fix(es|ed)?|revert|restore[sd]?|security|vuln\w*|cve|crash\w*|panic\w*|data loss|corrupt\w*|race|deadlock\w*|leak\w*|regression|incorrect|wrong|duplicate[sd]?|skipped)\b/i;

const isTestOrTooling = (f: string) =>
  /(^|\/)(tests?|__tests__|test_util|testing|benches)\//.test(f) ||
  /(\.test\.|_tests?\.rs$|\.spec\.)/.test(f) ||
  /(^|\/)(Cargo\.lock|pnpm-lock\.yaml|package-lock\.json|\.gitignore)$/.test(f) ||
  /\.(md|mdx)$/.test(f);

export function areaOf(file: string): Area | null {
  if (isTestOrTooling(file)) return null;
  const crate = /^crates\/([^/]+)\//.exec(file)?.[1];
  if (crate && IGNORED_CRATES.has(crate)) return null;
  for (const [prefix, area] of AREAS) if (file.startsWith(prefix)) return area;
  return null;
}

export function triage(c: Commit): Triaged {
  const areas = [...new Set(c.files.map(areaOf).filter((a): a is Area => a !== null))];
  if (areas.length === 0) return { ...c, kind: "ignored", areas: [] };
  const core = c.files.some((f) => !isTestOrTooling(f) && CORE.some((p) => f.startsWith(p)));
  return { ...c, kind: core && URGENT_WORDS.test(c.subject) ? "urgent" : "weekly", areas };
}

/** The commits after `from` up to `to`, oldest first, with the files each touches. */
export function commits(repo: string, from: string, to: string): Commit[] {
  const out = spawnSync(
    "git",
    [
      "-C",
      repo,
      "log",
      "--reverse",
      "--no-merges",
      "--name-only",
      "--format=%x1e%H%x1f%ad%x1f%s",
      "--date=short",
      `${from}..${to}`,
    ],
    { encoding: "utf8", maxBuffer: 64 << 20 },
  );
  if (out.status !== 0) throw new Error(`git log failed: ${out.stderr}`);
  return out.stdout
    .split("\x1e")
    .filter((s) => s.trim())
    .map((rec) => {
      const [head, ...rest] = rec.split("\n");
      const [sha, date, subject] = head!.split("\x1f") as [string, string, string];
      return { sha, date, subject, files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}

/** The parity reference recorded in docs/parity/upstream.md (`Reference commit: <sha>`). */
export function referenceFrom(markdown: string): string {
  const m = /Reference commit:\*?\*?\s*`([0-9a-f]{7,40})`/.exec(markdown);
  if (!m) throw new Error("docs/parity/upstream.md has no `Reference commit: <sha>` line");
  return m[1]!;
}

const URL = "https://github.com/get-convex/convex-backend/commit/";

export function digest(list: Triaged[], from: string, to: string): string {
  const line = (c: Triaged) =>
    `- [\`${c.sha.slice(0, 7)}\`](${URL}${c.sha}) ${c.date} ${c.subject.replace(/\|/g, "\\|")} _(${c.areas.join(", ")})_`;
  const of = (k: Kind) => list.filter((c) => c.kind === k);
  const [urgent, weekly, ignored] = [of("urgent"), of("weekly"), of("ignored")];
  return [
    `Commits of get-convex/convex-backend after the parity reference \`${from.slice(0, 7)}\`, up to \`${to.slice(0, 7)}\`: ${list.length} (${urgent.length} urgent, ${weekly.length} for the weekly bump, ${ignored.length} ignored). Sorted by \`scripts/upstream-triage.ts\` (STUDY-138); the weekly bump checks each one by hand.`,
    "",
    `### Urgent (${urgent.length})`,
    "A fix, revert or security change in the engine, the runtime or the client package: study it now (each has its own issue).",
    "",
    ...(urgent.length ? urgent.map(line) : ["None."]),
    "",
    `### For the weekly bump (${weekly.length})`,
    "",
    ...(weekly.length ? weekly.map(line) : ["None."]),
    "",
    `<details><summary>Ignored (${ignored.length}): docs, demos, cloud-only crates, tests and tooling</summary>`,
    "",
    ...ignored.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`),
    "",
    "</details>",
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const repo = opt("--repo") ?? "../convex-backend";
  const from =
    opt("--from") ?? referenceFrom(readFileSync(join(import.meta.dir, "../docs/parity/upstream.md"), "utf8"));
  const to = opt("--to") ?? "origin/main";
  const resolved = spawnSync("git", ["-C", repo, "rev-parse", to], { encoding: "utf8" }).stdout.trim();
  const list = commits(repo, from, to).map(triage);
  if (args.includes("--json")) console.log(JSON.stringify({ from, to: resolved, commits: list }, null, 2));
  else console.log(digest(list, from, resolved || to));
}
