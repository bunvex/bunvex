# STUDY-187 — What Convex's removed tests check on the data side, and bunvex misses

- **Status:** decided (owner, 2026-10-25): D-1–D-3 as recommended (§4): every item matches Convex, X13 waits for
  the operations in flight, in §3's order. No product change in this PR; each item becomes its own PR, with its test
  and a sabotage check. X20 is #838.
- **Convex source read:** the reference `72ce13c` of get-convex/convex-backend ([upstream.md](../parity/upstream.md));
  every citation below was checked at that commit. Convex's tests were removed from the open repository
  (TypeScript in `7a518c760`, Rust in `ba16e0638`, [TEST-01 §3](../specs/TEST-01-test-strategy.md)); they are read at
  the last snapshots that still have them, `bea52bde0` (Rust) and `c358201e1` (TypeScript), cloned next to bunvex.
- **Related:** [TEST-01 §3](../specs/TEST-01-test-strategy.md) and [STUDY-65](STUDY-65-convex-tests-application-client-cli.md)
  (the parts of those tests mapped before); STUDY-188 (the runtime side of the same mapping: isolate globals,
  dynamic import, messages, types).

## 1. Why this study

The owner asked which of Convex's own tests bunvex has not yet studied, and whether they are worth bringing over.
A read of both snapshots, area by area, against bunvex's tests turned up behaviour that differs from Convex
without a divergence recorded. This study takes the data side: the database, schemas, import and export, vector
search, the function log and log streams. Each item was reproduced on bunvex (a probe, or the code read where the
path is plain) before it went in here; the Convex side is read at the reference and, where noted, still to be run
on its binary in the item's PR.

One more item came from the differential suite while this was written (§2.10): the generated programs of
`packages/differential` failed on CI with seed 578652894, on several PRs at once, and the cause is on `main`.

## 2. The items

### 2.1 X13 — an unawaited write is run before the commit

**Convex.** A query's or mutation's run loop (`crates/isolate/src/environment/udf/mod.rs`, around `:1110–1250`)
drains the microtask queue, then runs the pending syscalls, then drains again, and stops only when no syscall is
pending, even after the handler's promise has fulfilled (`:1150`, "No syscalls or javascript to run, so we're
done"). It checks "queries and mutations should run all syscalls to completion" (`:1250`). It stops early only
when the handler's promise is rejected. So a write the handler did not await, or one chained after another
unawaited call, is part of the transaction. Convex's tests: `isolate/src/tests/async.rs` `test_dangling_mutation`
(one unawaited `db.insert`: 1 row), `test_doubly_dangling_mutation` (two chained inserts in an unawaited async
function: 2 rows), `test_doubly_dangling_syscall`; the functions are `udf-tests/convex/asyncTests.ts`.

**bunvex.** The engine commits as soon as the handler's promise settles (`packages/core/src/engine.ts`,
`execute` → `runMutation`). Nothing waits for operations still running. An unawaited write is kept only when it
finishes before the engine's own continuation, which is luck:
- into a declared table, or one that exists, `db.insert` is synchronous up to its write, so it is kept;
- into a table the insert creates, `insert` awaits `createTable` (`packages/core/src/tx.ts:2063`, several reads
  of `_tables` and `_index`), so the write lands after the commit and is **lost, while its promise still resolves
  with an id**;
- a write chained after an unawaited read is kept on the memory and SQLite stores, whose reads resolve within
  microtasks, and would be lost on a store whose read is real I/O (Postgres, MySQL, MongoDB).

Probe (memory and SQLite, `defineSchema({})` vs a declared `test` table): Convex's two tests give 1 and 2 rows;
bunvex gives 0 and 0 without the declaration, 1 and 2 with it.

**App impact.** High: data loss with a success answer. `void db.insert(...)` and fire-and-forget helpers are
common, and `@typescript-eslint/no-floating-promises` is off in many apps.

**Fix (to match).** The transaction counts its operations in flight. After the handler's promise fulfills, the
engine waits while any is in flight, and waits one macrotask past the last (so microtasks queued by a resolved
operation run and may start more), until none is left; then it commits. A rejected handler fails at once, as
Convex's. Under `BUNVEX_FUNCTION_SANDBOX=process` the child reports the end of a call, so it waits the same way
before it does. Cost: one macrotask per mutation (to measure in the PR, with `bench/`). A write issued after the
commit (only reachable through a promise that never settles) is refused rather than dropped.

Related: X19 (STUDY-188) is the query side of the same loop (a dangling `.then` must not change a query's
result, which Convex serializes before the final drain). The two PRs touch the same code: X13 goes first.

### 2.2 X1 — a CSV import drops the empty cells of optional fields

**Convex.** For a CSV import only (`crates/application/src/snapshot_import/mod.rs:486`), when the target table has
an active schema, `remap_empty_string_by_schema` (`:1763`) removes from each row a top-level field whose value is
`""` and which is optional in any variant of the table's document validator
(`crates/common/src/schemas/mod.rs:803`, `optional_top_level_fields`). That includes `v.optional(v.string())`.
A required field keeps `""`; without a schema, every `""` is kept. Convex's tests:
`snapshot_import/tests.rs` `import_with_empty_strings_and_optional_{number,string}_schema_treats_empty_as_none`,
`…_string_schema_treats_empty_as_empty`, `…_no_schema_defaults_to_empty_strings`.

**bunvex.** `packages/server/src/import-parse.ts` (`csvRows`, `parseCsvCell`) keeps `""` for every empty cell, so a
CSV with a blank optional number fails schema validation on bunvex and imports on Convex.

**Fix (to match).** In the CSV path, read the active schema of the import's namespace once, and drop `""` for the
optional top-level fields of that table. JSONL and ZIP imports are unchanged, as Convex's.

### 2.3 X2 — an empty `q.or()` in a vector search filters nothing out

**Convex.** `q.or()` with no arguments assembles an empty field map (`crates/vector/src/query.rs:99`), so the search
has no filter conditions, and a document matches when there are none (`crates/vector/src/memory_index.rs:235`).
Convex's tests: `vector/src/qdrant_segments.rs` `plain_segment_with_empty_filter`,
`disk_segment_with_all_none_filter`.

**bunvex.** `vectorFilter` (`packages/core/src/engine.ts:4441`) returns an empty `Map`, which is truthy, and both
the memory part and the segments (`packages/search/src/segmented-vector-index.ts:94`, `:113`) then skip every
document: the search returns nothing. Apps hit it with `q.or(...tags.map((t) => q.eq("tag", t)))` and no tags.

**Fix (to match).** An empty filter map is no filter. The PR checks the answer on Convex's binary
(`packages/differential`), before and after a flush to segments.

### 2.4 X3 — the previous schema is kept as `overwritten`, and old ones go after an hour

**Convex.** Activating a schema marks the previous active one `overwritten` (`clear_active`,
`crates/database/src/bootstrap_model/schema/mod.rs:579`). Each time a schema is marked `overwritten` or `failed`,
`delete_old_failed_and_overwritten_schemas` (`:596`) deletes the `failed` and `overwritten` rows older than
`MAX_TIME_TO_KEEP_FAILED_AND_OVERWRITTEN_SCHEMAS`, one hour (`:64`). Convex's tests:
`bootstrap_model/schema/tests.rs` `overwrite_schema_by_state_with_active_schema_sets_active_to_overwritten`,
`overwrite_schema_deletes_old_overwritten_schemas`, `failed_schema_deletes_old_failed_schema`.

**bunvex.** Activation deletes the previous active row at once (`packages/core/src/engine.ts:4386`), and the
`overwritten` and `failed` rows it does write (`:4316`) are never removed. What an app sees: the `_schemas` table
(dashboard, exports) holds different rows.

**Fix (to match).** Mark, don't delete; delete `failed` / `overwritten` rows older than an hour at the same points.

### 2.5 X5 — `occInfo.componentPath` names the component

**Convex.** An OCC error's info carries the component path of the conflicting table (`OccInfo`,
`crates/errors/src/lib.rs:78`), into the function log and log streams. Convex's tests: `database/src/tests/mod.rs`
`test_occ_error_component_path_for_child_component` (`"my_child"`), `…_is_none_for_root` (none).

**bunvex.** `componentPath` is always `null` (`packages/server/src/functions.ts:1516`).

**Fix (to match).** Resolve the conflicting table's namespace to its component path.

### 2.6 X6 — log streams get `log_stream_egress` events

**Convex.** The open-source log manager counts the bytes each sink sends, and every 60 s, when there is something
to report, emits `{topic: "log_stream_egress", egress_bytes}` into the stream (`crates/log_streaming/src/lib.rs:754`,
`egress_emission_worker`; the JSON at `crates/common/src/log_streaming.rs:1006`). Its billing half (usage counted
as a `LogStreamPayload` call) is the cloud's.

**bunvex.** The topic is listed (`packages/server/src/log-events.ts:21`) and never emitted.
[STUDY-59](STUDY-59-log-streams.md) calls egress events cloud-only; that is wrong for this one.

**Fix (to match).** Count each sink's sent bytes; a 60 s tick emits the event when the count is not zero. STUDY-59
is corrected in the same PR.

### 2.7 X10 — a mutation that straddles a schema push (to verify)

**Convex.** The schema state is in a transaction's read set, so a transaction that saw the schema conflicts with
a push that makes it pending or active (`database/src/tests/mod.rs` `test_schema_registry_takes_read_dependency`).

**bunvex.** Writes are checked against pending validators when they are made (`tx.pendingViolation`,
`withPendingCheck` in `packages/core/src/engine.ts`), and no read of `_schemas` is recorded. A mutation that starts
before a push turns pending, and commits after the validation walk's snapshot, might pass both checks. Not
reproduced yet. Its PR starts with the reproduction (a push held between pending and the walk); if it does not
reproduce, the item closes with that test.

### 2.8 X12 — a streaming export's JSON Schema falls back to the active schema

**Convex.** When a table's reduced shape is neither `Object` nor `Never`, `json_schemas` builds the table's JSON
Schema from the active schema (`crates/local_backend/src/streaming_export.rs:1115`), and fails with
`NoSchemaForExport` or `NoTableDefinitionForExport` only without one. Convex's test:
`local_backend/src/streaming_export.rs` `test_json_schema_fallback_to_active_schema`.

**bunvex.** `jsonSchemas` (`packages/server/src/streaming-export.ts:489`) throws `NoSchemaForExport` in that case,
and calls it unreachable. It is reachable: a document with more fields than `MAX_OBJECT_FIELDS` has a `Record`
shape (`packages/core/src/shapes.ts:94-107`).

**Fix (to match).** The same fallback, with Convex's two errors.

### 2.9 X18 — an id whose table does not exist

**Convex.** `delete`, `patch` and `replace` resolve an id's table first and fail with `Table for ID "<id>" not
found` (`crates/database/src/transaction.rs:373`, `resolve_idv6`; the syscalls add the `id` argument's context,
`crates/isolate/src/environment/udf/async_syscall.rs`). `get` returns null. Convex's test:
`isolate/src/tests/user_error.rs` `test_nonexistent_table`.

**bunvex.** "Delete/Update/Replace on nonexistent document ID …" (probe). The full text, with its argument
context, is taken from Convex's binary in the PR.

### 2.10 X20 — a patch or replace that changes nothing writes nothing

Found by the differential suite (seed 578652894, shrunk to: insert `{x: 2}`, then patch it with `{x: 2}`).

**Convex.** `patch_inner` and `replace_inner` (`crates/database/src/transaction.rs:694`, `:748`) compare the new
document with the current one and return before the schema check and the write when they are equal. So the
transaction has no write for it: no usage (`databaseWriteDocuments`, bytes, index rows), no invalidation of the
queries that read the document, no OCC conflict with them, and no schema enforcement.

**bunvex.** The write is made. Checked on Convex's binary (`precompiled-2026-10-10-72ce13c`): top-level and in a
nested mutation, Convex's log shows the mutation with reads only, bunvex's with one written document of 159 bytes
and 3 index rows; a patch that changes the value matches.

**App impact.** Medium: extra usage, and subscriptions re-run (with OCC retries for concurrent readers) on writes
that change nothing. The differential suite's generated programs keep failing on it at random, on any PR.

**Fix (to match).** Compare with the current version (the pending one when the transaction already wrote it) and
skip the write when equal, as Convex's. The function log and the subscriptions are then unchanged by such a call.

### 2.11 X21 — under `process`, an operation chained after the handler settled holds the call

Found while building X13's differential test. Under `BUNVEX_FUNCTION_SANDBOX=process` (opt-in, AD-44), a mutation
whose handler returns while an unawaited operation is in flight, and whose answer's code starts another operation
(`doublyDanglingMutation`, a write after an unawaited read), never answers: the call fails at its 1 s limit with
"Function execution timed out". The single unawaited insert works. It happens on `main` too, on Bun 1.4.2 and 1.4.4.
The child already waits for the operations a call started before it answers (`packages/sandbox/src/child-call.ts`,
`settled` / `checked`); the chained one is not seen through to the end. Matching Convex is X13's behaviour (every
syscall run to the end). Its own PR, in `packages/sandbox`, with the differential case run under `process`.

### 2.12 X22 — creating a table invalidates every cached query

Found by the generated differential programs, intermittently (CI picks random seeds). Seed 347098918 shows it every
time, and shrinks to three programs: a query reads `b`, a mutation in a later program creates a table nothing reads
(`nope`), and the same query runs again. Convex runs it again; bunvex answered it from the cache.

- **Convex:** every use of the table mapping records a read of all of `_tables` (`Transaction::table_mapping` →
  `take_table_mapping_dep`, `database/src/transaction.rs`: `record_indexed_derived` over `_tables.by_id`,
  `Interval::all()`). Every query and mutation that names a table takes it. A commit that writes any `_tables`
  document (a table created, replaced by an import, deleted) invalidates every cached query and every subscription,
  and conflicts with every mutation in flight.
- **bunvex before:** a transaction read only the `_tables` row of each table it used (`Tx.dependOn`). Only a read of
  a table that does not exist read all of `_tables`.
- **bunvex now:** the first table a transaction uses also reads all of `_tables`. That read is on `_tables`'
  `by_creation_time`, which `Tx.catalogTouches` (bunvex's own write log entries for an index change) never writes. An
  index change therefore still conflicts only with transactions that used its table, as Convex's per-index `_index`
  reads do (`transaction_index.rs`, `record_interval`).
- **What apps observe:** the `cached` flag in the function log, and one more run after a table is created, as on
  Convex. Mutations in flight while a table is created retry, as on Convex. `bunvex dev` waiting on a table after a
  schema validation failure (`_system/cli/queryTable`, `Math.random()` per run, as Convex's) pushes again when any
  table is created, as Convex's CLI does; `dev.test.ts` now creates its unrelated table before the watch.
- **Cost:** one interval per transaction. 20 000 mutations and 20 000 indexed queries on the memory store run within
  noise before and after (about 50–58 k mutations/s and 140–170 k queries/s on both).
- **Tests:** `packages/differential/test/table-mapping.test.ts` against Convex's binary, which fails without the fix;
  `tx-b-edges.test.ts`; the read-set fixture, where each shape gains that one read.

## 3. Order

1. X13 (data loss), X20 (it fails CI at random), X1 and X2 (wrong data or results); X21 after X13.
2. X12, X18, X3, X5, X6.
3. X10: reproduction first.
4. X22 (found after the study), its own PR.

Each is its own PR from `main`, with the oracle case in `packages/differential` where Convex's binary can show it.

## 4. Questions for the owner

All decided by the owner on 2026-10-25, as recommended.

| # | Question | Recommendation |
|---|---|---|
| D-1 | Match Convex on every item of §2 (none is recorded as a divergence today) | **Yes.** Each is a bug against Convex's behaviour |
| D-2 | X13: commit only after every operation in flight, at the cost of one macrotask per mutation (measured in its PR) | **Yes.** Losing a write that answered an id is worse than a few microseconds |
| D-3 | The order of §3 | **As §3** |

## 5. Gaps left for later

The tests of §2.2 of the mapping (a feature that exists with no test pinning Convex's behaviour: the index diff at
push, schema subsets, ZIP import table numbers, import metering, …) are split between this study and STUDY-188 in
a follow-up.
