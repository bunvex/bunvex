// The function sandbox's parity corpus (STUDY-171 §7.4): every load of app code a push makes, for which the
// parity test (packages/sandbox/test/analysis-parity.test.ts) checks that a child analyzes it as `CodeVersion.load`
// does in-process.
//
// - Each example app (examples/*/bunvex), bundled as `bunvex deploy` bundles it: its modules, its schema and its
//   auth config, the last with no variables and with each variable it reads set.
// - The server's pushed-code suites, run with `sandbox-parity-recorder.ts` preloaded: every `CodeVersion.load` and
//   every push-time evaluation they make (STUDY-168 §12.4's list).
//
//   bun scripts/sandbox-parity-corpus.ts      writes packages/sandbox/test/fixtures/parity-corpus.json.gz
//
// Run it again when an example or one of those suites changes; the parity test fails when an example is missing.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundleFunctions } from "../packages/cli/src/bundle.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "packages/sandbox/test/fixtures/parity-corpus.json.gz");
/** The pushed-code suites (STUDY-168 §12.4): the ones that load app code through the loader. */
const SUITES = [
  "code-version",
  "code-store",
  "export-validators",
  "source-position",
  "rooms-define",
  "push",
  "push-components",
  "component-runtime",
  "component-calls",
  "component-read-count",
  "component-nested-read-count",
  "action-nested-error-frames",
  "engine-error-frames",
  "value-error-frames",
  "http-action-content-type",
  "node-action-log-format",
  "log-realms",
  "run-test-function",
  "serve-after-code-ready",
].map((s) => `packages/server/test/${s}.test.ts`);
const SEED = [1, 2, 3, 4];
const TIMESTAMP = 1_760_000_000_000;

type Entry = Record<string, unknown> & { suite: string; kind: "load" | "evaluate" };
const entries: Entry[] = [];

// The examples.
for (const name of readdirSync(join(ROOT, "examples")).sort()) {
  const dir = join(ROOT, "examples", name, "bunvex");
  if (name.startsWith("_") || !existsSync(dir)) continue;
  const suite = `examples/${name}`;
  const bundled = await bundleFunctions(dir, join(ROOT, "examples", name));
  const auth = bundled.modules.find((m) => m.path === "auth.config.js");
  const options = { seed: SEED, timestamp: TIMESTAMP, env: {} };
  entries.push({ suite, kind: "load", sources: bundled.modules.filter((m) => m !== auth), options });
  if (bundled.schema) entries.push({ suite, kind: "evaluate", use: "schema", source: bundled.schema, options });
  if (auth) {
    const variables = [...auth.source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
    for (const env of [{}, Object.fromEntries(variables.map((v) => [v, `https://${v.toLowerCase()}.example.com`]))])
      entries.push({
        suite,
        kind: "evaluate",
        use: "authConfig",
        source: auth,
        options: { ...options, env, failOnMissingEnv: true },
      });
  }
}

// The server's suites.
const tmp = mkdtempSync(join(tmpdir(), "bunvex-parity-corpus-"));
const recorded = join(tmp, "recorded.jsonl");
const run = Bun.spawnSync(
  ["bun", "test", "--preload", "./scripts/sandbox-parity-recorder.ts", "--timeout", "30000", ...SUITES],
  { cwd: ROOT, env: { ...process.env, SANDBOX_CORPUS_OUT: recorded }, stdout: "inherit", stderr: "inherit" },
);
if (run.exitCode !== 0) throw new Error(`the server's suites failed (exit code ${run.exitCode})`);
const lines = readFileSync(recorded, "utf8").split("\n").filter(Boolean);
rmSync(tmp, { recursive: true, force: true });
let skipped = 0;
for (const line of lines) {
  const e = JSON.parse(line) as Entry & { options: Record<string, unknown> };
  // A test's temporary `node_modules` and the auth config's callback do not replay (its evaluation does).
  if (e.options.nodeModules || e.options.onMissingEnv) {
    skipped++;
    continue;
  }
  entries.push(e);
}

// Once each: the suites load the same code many times.
const seen = new Set<string>();
const corpus = entries.filter((e) => {
  const { suite: _, ...rest } = e;
  const key = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
writeFileSync(OUT, Bun.gzipSync(JSON.stringify(corpus)));
console.log(
  `${corpus.length} entries (${lines.length} recorded, ${skipped} not replayable, ${entries.length - corpus.length} repeats) → ${OUT}`,
);
