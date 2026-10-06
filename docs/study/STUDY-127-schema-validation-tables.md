# STUDY-127 — `_schema_validations` and `_schema_validation_progress`

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) (push, the schema walk), [STUDY-12](STUDY-12-dashboard.md)
  (§14.7, the dashboard's validation progress), [STUDY-52](STUDY-52-shape-inference.md) (the walk's shape
  shortcut, not built)

## 1. How Convex does it

**Tables.** Both are bootstrap tables, created per namespace (`model/src/lib.rs:455-460`).

- `_schema_validations` (`crates/database/src/bootstrap_model/schema_validations/`). Number 555
  (`DefaultTableNumber::SchemaValidations = 43`). Index `by_schema_id_and_table_name` on
  `[schemaId, tableName, _creationTime]`. One document per (schema, table):
  `{schemaId, tableName, validatorHash?, state}`. `state` is `{state: "pending"}`, `{state: "valid"}` or
  `{state: "failed", error}`. `validatorHash` is set only for staged validators.
- `_schema_validation_progress` (`…/schema_validation_progress/`). Number 549 (`= 37`). Index `by_validation_id`
  on `[validationId, _creationTime]`. One document per attempt: `{validationId, numDocsValidated: int64,
  totalDocs: int64 | null}`. Counters are kept apart from attempts "so flushing progress cannot invalidate a
  document transaction that records a validation failure". A legacy shape keyed by `schemaId` is still read.

**What is written, and when** (`crates/application/src/schema_worker/mod.rs`).

- The `SchemaWorker` picks up a `Pending` schema. It decides which tables must be walked
  (`table_validation_outcomes`, shapes included). It counts each table from the table summaries (`None` before
  they are bootstrapped).
- `SchemaValidationProgressTracker::new` then creates every attempt in one commit
  (`"schema_validation_tracker_initialized"`). `start_table_validation` deletes an earlier attempt for the same
  (schema, table), inserts a `pending` one, and inserts its progress at 0 with `totalDocs`.
- Each document checked is counted in memory. Every `progress_update_threshold(total)` documents, the count is
  flushed (`"schema_validation_progress_updated"`):
  - the threshold is `min(500, ceil(5 % of total))`, or 500 when the total is unknown, at least 1;
  - the flush is `update_attempt(RecordProgress)`: `numDocsValidated += count`, `totalDocs` kept unless it was
    `None`, re-read from the summaries each flush;
  - it only applies while the attempt is `pending`; a missing or resolved attempt returns false and stops the
    walk ("validation was canceled").
- At a table's end, the rest is flushed and the attempt is marked `valid`
  (`"schema_validation_progress_finished"`).
- A document that does not match marks the schema failed (`SchemaModel::mark_failed`).
- When every table is walked, `mark_validated`.

**Deleted when** (`schema/mod.rs`): `mark_active`, `mark_failed` and `mark_overwritten` each call
`delete_validations_for_schema`. A resolved schema keeps no attempts.

**After a restart.** `initialize_application_system_tables` calls
`SchemaValidationModel::reset_for_compatibility` (`model/src/lib.rs:470`). It deletes every attempt, and
re-creates staged validators' attempts of the active schema as `pending`. The worker then finds the still
`Pending` schema and walks it again from the start, with fresh attempts (new ids, zero progress). Progress is not
resumed from where it stopped.

**Read by.**

- The dashboard's `_system/frontend/getSchemas:schemaValidationProgress` (system-udfs, ViewData). It finds the
  pending schema, reads its attempts by `by_schema_id_and_table_name`, and each one's counters by
  `by_validation_id`. It returns `{numDocsValidated: Σ, totalDocs: Σ or null}`: null when any total is unknown,
  and `|| null` turns 0 into null. It returns null when nothing is pending or there is no attempt.
- `wait_for_schema` (`deploy_config.rs:708-820`) does **not** read them. It reads the schema's state and the
  indexes only (`schemaValidationComplete`, `indexesComplete`, `indexesTotal`), and so does the CLI.

## 2. What an app can observe

Nothing new for app code. The dashboard shows the walk's progress. Operators see the rows. After a restart,
a pending schema is still checked and becomes `validated` (or `failed`), where before this change it stayed
`pending`.

## 3. How bunvex does it

Before: the walk (`Engine.validateExisting`) kept no rows, and a restart left a pending schema pending forever.
Now (`@bunvex/core` `schema-validations.ts`, `engine.ts`):

- Both tables use Convex's numbers, documents and indexes.
- `validateExisting` creates every attempt in one commit, counts each checked document, flushes at Convex's
  threshold and at each table's end, then marks the attempt `valid`. A flush or mark that finds the attempt gone
  stops the walk. Flushes run while the walk goes on, one at a time: the next waits for the previous one, so a
  cancel is noticed one flush later. Awaiting each flush made a 20 000-document walk about 50 % slower (see §5);
  pipelined, it costs nothing measurable.
- `totalDocs` comes from the table summaries (null while they are built).
- A failed (`failSchemaPush`), overwritten (`startSchemaPush`) or activated (`commitSchemaPush`) schema's
  attempts are deleted in the same commit.
- At a deployable engine's start, every attempt is deleted. A `pending` schema is then walked again from the
  start with new attempts. Writes are checked against a `pending` or `validated` schema, as before the restart.
- `_system/frontend/getSchemas:schemaValidationProgress` is Convex's (`componentId` accepted and ignored).

Which tables are walked is unchanged: bunvex walks a table whose validator changed (or that validation now
covers), without Convex's shape shortcut (STUDY-52). `validatorHash` is never written: bunvex has no staged
validators yet (#423 adds `.staged()`; its attempts would follow Convex's `reset_for_compatibility` rule).

After a restart the push that started the schema cannot be finished: bunvex keeps a push's state in memory
(STUDY-35), where Convex's CLI sends it back. The schema still gets validated, and the next push overwrites it.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| V1 (DV-404) | Was: progress in memory only, nothing kept, a pending schema left pending after a restart. Now as Convex: the two tables, their writes and deletes, the restart rule, the dashboard's query | match Convex's internal system tables; no legacy data | owner, 2026-10-05: match Convex |
| V2 | Progress flushes are pipelined (one in flight while the walk continues); Convex awaits each | the walk's speed (§5); a cancel is seen one flush later, and the walk does nothing but read meanwhile | not observable; noted |

## 5. Tests

`packages/core/test/schema-validations.test.ts`:

- the attempt and its counters after a walk (Convex's numbers, `valid`, `numDocsValidated` and `totalDocs`);
  deleted when the schema becomes active;
- progress is flushed during a 4 000-document walk in steps of 200 (5 %), with the total; the dashboard's sum
  reads it;
- a failed and an overwritten schema lose their attempts; the newer push's stay;
- after a restart a pending schema is walked again with new attempts, becomes `validated`, and a write that
  does not match fails it (attempts deleted).

`packages/server/test/push.test.ts`: `getSchemas:schemaValidationProgress` over HTTP, with a failed schema's
attempts gone.

Sabotage (each applied alone, then restored):

| Change | Result |
|---|---|
| flush every 50 % instead of 5 % | 1 test fails |
| `totalDocs` not kept in the counters | 1 fails |
| an active schema keeps its attempts | 1 fails |
| a failed schema keeps its attempts | 3 fail (core and server) |
| no resume after a restart | 1 fails |
| `_schema_validations` numbered 9997 | 1 fails |

Measurement: `bench-walk` (a push validating 20 000 documents, SQLite, median of 5 runs):

| | main | awaiting each flush | pipelined (shipped) |
|---|---|---|---|
| run 1 | 423 ms | 664 ms | 442 ms |
| run 2 | 367 ms | | 366 ms |

## 6. Open questions

None.
