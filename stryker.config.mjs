// Mutation testing of the engine's critical files (TEST-01 §7). Each mutant is a small change to the source
// (an operator, a condition, a boundary); the tests must fail on it. A mutant that survives is a test to write,
// or an equivalent change marked `// Stryker disable next-line <mutator>: <why>` in the source.
//   bun run mutation                                   every file below (incremental: only what changed)
//   bun run mutation --mutate packages/core/src/keyenc.ts
// Scheduled weekly by .github/workflows/mutation.yml; the report is reports/mutation/index.html.
// The bun runner runs, for each mutant, only the tests that cover it (perTest).
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  plugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  coverageAnalysis: "perTest",
  mutate: [
    "packages/core/src/tx.ts",
    "packages/core/src/committer.ts",
    "packages/core/src/read-set-index.ts",
    "packages/core/src/keyenc.ts",
    "packages/core/src/query-cache.ts",
    "packages/core/src/system-reader.ts",
    "packages/core/src/schema-json.ts",
    "packages/core/src/persistence/split.ts",
    "packages/core/src/persistence/scan.ts",
    "packages/core/src/persistence/memory.ts",
    "packages/core/src/persistence/sqlite.ts",
    "packages/values/src/sorting.ts",
    "packages/values/src/value.ts",
    "packages/values/src/commit-ts.ts",
  ],
  bun: {
    testFiles: ["packages/core/test", "packages/values/test"],
    timeout: 900000,
  },
  ignorePatterns: [
    "apps",
    "examples",
    "docs",
    "docker",
    "bench",
    ".claude",
    "packages/ui",
    "packages/dashboard",
    "packages/differential",
    "packages/jepsen",
    "packages/sync-e2e",
    "reports",
  ],
  incremental: true,
  incrementalFile: "reports/mutation/incremental.json",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  thresholds: {
    high: 90,
    low: 75,
    break: null,
  },
  concurrency: 4,
};
