# TEST-01 — the test strategy

> **v1, 3 Oct 2026.** What bunvex tests, at which layer, and how a regression in the parts an app relies
> on most is caught before it merges. Written with the test-hardening track: property tests (#255),
> the index-range fix they found (#256, DV-310), the coverage gaps (#259) and the coverage floors (§4).

## 1. Layers

| Layer | What it is | Where | Runs |
|---|---|---|---|
| Unit | one module, its behaviour and its messages; a fake socket or an in-memory store where needed | `packages/*/test/*.test.ts` | root `bun test` (`bun run check`, CI `check`) |
| Property | random inputs (fast-check, pinned), an invariant or a reference model; a failure prints its seed and a shrunk counterexample | `packages/*/test/*.property.test.ts` | root `bun test` |
| Seeded oracle | a seeded random workload checked against a simple model (the linear OCC validator, a sequential replay) | `core/test/occ-validation.test.ts`, `core/test/read-set-serializable.test.ts` | root `bun test` |
| Conformance | PERSIST-01's K1–K29, the same suite on every driver | `@bunvex/persistence-conformance` | memory and SQLite in `bun test`; Postgres, MySQL and MongoDB in their CI jobs |
| End to end | a real server and clients over HTTP and WebSocket, compared with an oracle client | `packages/sync-e2e`, the dashboard in Chromium (`bun run e2e`) | `bun test`; the `e2e` CI job |
| Linearizability | concurrent histories with faults injected, checked for linearizability | track 2's harness (its own spec) | its own job |
| Mutation | mutate the source, the suite must fail: measures what the tests actually pin | later | — |

Property tests scale with `BUNVEX_PROPERTY_MULTIPLIER` (an integer, default 1): every `runs(n)` becomes
`n × multiplier`, as Convex's `CONVEX_PROPTEST_MULTIPLIER`. Use it for a long local soak
(`BUNVEX_PROPERTY_MULTIPLIER=100 bun test packages/values packages/core`). A failure prints
`seed` and `path`; replay it with `fc.assert(..., { seed, path })` in the failing test, then keep the
counterexample as a plain regression case.

Every behaviour change still comes with a **sabotage check** (CLAUDE.md): break the fix, watch the test
fail. A property that survives a sabotage is either weak or the mutant is equivalent; the PR says which.

## 2. The heart areas

Eight areas where a bug is silent data loss or a wrong answer, not a crash. Each has tests at more than
one layer, and its files have coverage floors (§4).

| Area | What must hold | Tests |
|---|---|---|
| Transactions / OCC | serializable: every commit equals some serial order; a read set conflicts with exactly the writes that change its answer | `occ*.test.ts`, `read-set-serializable` (sequential replay oracle), `read-set-index.property` (model), K3, K5 |
| Value encoding / order | index key bytes order exactly as `compareValues`; JSON, export and ids round-trip | `sorting.property`, `roundtrip.property`, `validators.property`, `filter-cursor.property`, `index-range.property`, K1 |
| Persistence durability | an acknowledged commit survives a crash, whole; nothing unacknowledged is half-visible | PERSIST-01 K6, K7, K15, K20, K21, K26; `scan.property` (split keys) |
| Invalidation / cache | a cached query is invalidated by exactly the writes in its read set | K4, `query-cache` tests, `sync-semantics` |
| Sync / reconnect | the client's view equals a fresh run at the same version, across reconnects and chunked transitions | `sync-e2e` oracle tests, `web-socket-manager.test`, `pieces.test` |
| Determinism | a query or mutation gives the same result for the same snapshot (no Date.now / Math.random leak) | `determinism.test.ts` |
| Scheduler exactly-once | a scheduled function or cron slot runs once, also across restarts and leader changes | `scheduler.test`, `cron.test` |
| Admin keys | a key works only for its instance and secret; nothing admin is reachable without one | `admin-keys.test`, `admin-access.test`, `local-backend.test` |

## 3. What Convex tests, and what bunvex mirrors

Convex removed its tests from the open repository (TypeScript in `7a518c760`, 2026-04-08; Rust in
`ba16e0638`, 2026-04-09). The last snapshots with tests are `bea52bde0` (Rust, 313 files with tests) and
`c358201e1` (TypeScript, 208 test files). bunvex learns *what* they test from those; the code is never
copied.

| Convex (bea52bde0 / c358201e1) | bunvex |
|---|---|
| `crates/value/src/sorting.rs`: round trips, `compatible_with_manual_impl` (key order = value order) | `values/test/sorting.property.test.ts` |
| `crates/value/src/json/tests.rs`, `export.rs`, `id_v6.rs` | `values/test/roundtrip.property.test.ts` (wire JSON, export JSON, ids, mangled ids refused) |
| `npm-packages/convex/src/values/{value,validator,size}.test.ts` | `roundtrip.property`, `validators.property`, the existing unit tests |
| `crates/database/src/reads.rs`, `subscription.rs`, `crates/interval_map/src/tests.rs` | `core/test/read-set-index.property.test.ts` (set / delete / match against a map model) |
| `crates/common/src/{persistence,query,document}.rs` proptests | `core/test/scan.property.test.ts`, `filter-cursor.property.test.ts`, `index-range.property.test.ts` |
| `CONVEX_PROPTEST_MULTIPLIER` | `BUNVEX_PROPERTY_MULTIPLIER` (§1) |

### 3.1 Convex's persistence test suite against PERSIST-01

`crates/common/src/testing/persistence_test_suite.rs` (bea52bde0) runs 25 cases on every Convex driver.
Compared with PERSIST-01's K1–K29:

| Convex case | PERSIST-01 | Status |
|---|---|---|
| write_and_load, write_and_load_from_table, write_and_load_value_types | K1, K2 | covered |
| write_and_load_sorting | K1 | covered |
| overwrite_document, overwrite_index | K2, K8 (many versions per key) | covered |
| query_index_at_ts | K2 | covered |
| query_index_range_short / _long (with prefix) | K8, K9 | covered |
| query_multiple_indexes | K2 (several indexes per commit) | partial: no case reads two indexes of one table at one snapshot and cross-checks them |
| query_dangling_reference, query_reference_deleted_doc | — | **gap**: an index entry whose document is missing or deleted at the snapshot; bunvex's `scanDocs` should skip it, not throw |
| same_internal_id_multiple_tables | — | **gap**: two tables holding the same internal id (possible with hidden tables, STUDY-42) |
| query_with_rows_estimate_short / _long | — | not applicable: bunvex drivers have no rows-estimate API |
| write_then_read (reopen) | K6, K7, K22 | covered |
| set_read_only (in the suite's helpers) | K23 | covered |
| persistence_global | K29 | covered |
| persistence_enforce_retention | K28 | covered |
| delete_documents, delete_many_documents, delete_tablet_documents | K28 (pruning) | partial: table deletion is tested through the engine (`hidden-tables.test.ts`), not per driver |
| previous_revisions_of_documents, previous_revisions, load_revision_pairs | K27 (the document log) | partial: no API for "the revision before ts" of a document; the document log covers what bunvex uses |
| table_stats | — | not applicable: no table statistics API yet |

The two gaps are candidates for K30 and K31; they touch every driver, so they belong to the persistence
track.

### 3.2 The application, client and CLI tests

[STUDY-65](../study/STUDY-65-convex-tests-application-client-cli.md) maps the rest of what applies:
- `crates/application/src/tests`;
- the React, browser and Next.js client tests;
- the CLI tests.

It found four bugs, each fixed with its test:
- `.env` files not read as dotenv reads them (#277);
- a repeated name refused in an environment-variable batch (#278);
- `auth.config` losing the canonical URLs on an environment-variable update (#279);
- a canceled job's callees still scheduling live jobs (#281).

Its §6 is the prioritized list of what is still untested.

## 4. Coverage floors

`bun run coverage` (`scripts/coverage.ts`) runs the root `bun test` with lcov coverage. It prints:
- a table per critical file, with its area and floor;
- a table per package.

On GitHub Actions the tables also go to the job summary. It fails when the tests fail, or when a critical
file is below its floor or missing from the report. A file is missing when no test loads it, or when it
was renamed. CI runs it as its own job, `coverage · critical-file floors`, in parallel with `check`.

It is not part of `bun run check`: it re-runs the whole suite under instrumentation, about 105 s locally
against `bun test`'s 100 s.

The floors live in **one place**, `scripts/coverage-floors.ts`. Each entry gives the file, its heart area
(§2), why the file is critical, and its floor. A floor is the file's line coverage when it was set, minus
about 2 points, rounded down.

To change a floor:
- **Raise it** in the PR that adds tests to the file.
- **Lower it** only with a reason in the PR and the owner's review.
- **Add an entry** for a new critical file.
- **Move or drop the entry** of a renamed or removed file.

The floors were set at main `52141c8`, then raised once #255 (property tests) and #259 (coverage gaps)
merged. The files those PRs moved:

| File | at `52141c8` | after #255 / #259 | floor then → now |
|---|---|---|---|
| values/src/commit-ts.ts | 72.2% | 100% | 70 → 98 |
| core/src/system-reader.ts | 73.9% | 100% | 71 → 98 |
| core/src/schema-json.ts | 76.9% | 100% | 74 → 98 |
| core/src/persistence/scan.ts | 80.4% | 98.3% | 78 → 96 |
| core/src/persistence/split.ts | 10.7% (exercised by the SQL drivers' jobs) | 86.3% | 8 → 84 |
| client/src/web-socket-manager.ts | 85.4% | 100% | 83 → 98 |
| server/src/persistence.ts | 86.9% | 96.3% | 84 → 94 |
| server/src/local-backend.ts | 84.2% | 100% | 82 → 98 |

split.ts and scan.ts are covered by fast-check properties with a random seed; their coverage was the same
over six runs, so a seed-dependent dip below the floor is not expected.

## 5. Bugs the property tests found

- **Index ranges and the escape byte (DV-310, #256).** The bug was found by `index-range.property`, with
  the counterexample `[["\0", null], "", "eq"]`.
  - `withIndex(q => q.eq("n", ""))` also returned `"\0"` and `"\0x"`.
  - The upper bound of an equality, `gt` or `lte` range was the prefix increment, and keys that continue
    with the 0xFF escape sort inside it. A key whose next byte is 0xFF is the encoding of the value plus an
    escaped NUL, or of `{}` plus an empty field name.
  - Convex shares it (`End::after_prefix`).
  - The fix bounds the range at `key + [0xFF]` instead. It is a divergence, pending the owner's decision.
- **Not a bug, a wrong assumption.** "No key is a proper prefix of another" failed with seed 1282129258 on
  `[{}, {"": NaN}]`. An empty field name is followed by the escape, as in Convex. The property now states
  what does hold: when one key is a proper prefix of another, the next byte is 0xFF. That is also what led
  to DV-310.

## 6. Later

- **Mutation testing.** Run a mutator (e.g. Stryker's TypeScript support, or a small AST mutator) over
  the heart-area files, nightly, and report the surviving mutants.
- **Raise the floors** (§4) as the gaps close. Add branch coverage once Bun reports it in lcov.
- **K30 and K31** (§3.1), with the persistence track.
