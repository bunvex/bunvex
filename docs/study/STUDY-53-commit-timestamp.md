# STUDY-53 — The commit timestamp (`db.vars.commitTs`)

- **Status:** decision pending (owner): T1–T2; PR 1 (draft) implements the recommendations. Closes DV-59
- **Convex source read:** `main` of get-convex/convex-backend (npm 1.46.0; the feature is in 1.43.0), 2026-10-03
- **Related:** [STUDY-06 D8](STUDY-06-transactions-and-occ.md), [STUDY-13 D2](STUDY-13-validators.md),
  [STUDY-44](STUDY-44-ctx-meta.md) (`getSnapshotTs`, same clock)

## 1. How Convex does it

- **The API**: `ctx.db.vars.commitTs` (mutations: only the writer has `vars`) is the one `CommitTsPlaceholder` (`values/value.ts`).
  - `toString()` gives "[unresolved commit timestamp]".
  - `valueOf()`, `toJSON()` and numeric conversion throw "This commit timestamp is unresolved: …".
  - `v.commitTs()` (JSON `{type: "commitTs"}`) accepts an int64; codegen types it as `bigint | CommitTsPlaceholder`.
  - `Value` includes the placeholder.
- **Wire and resolution**:
  - On the wire the placeholder is `{"$commitTs": null}` (Rust `PendingValue::CommitTs`).
  - Documents written with it are resolved by the committer once the commit ts is assigned, to `Int64(commit ts)`: nanoseconds, the mutation's response `ts`. Every placeholder of the transaction gets the same value.
  - A mutation's result is resolved the same way after the commit (`resolve_commit_ts`).
  - An idempotent session request stores the pending result and resolves it again with the recorded commit ts.
- **Before the commit, the "max view"**: wherever a concrete value is needed, the placeholder counts as `i64::MAX`.
  - This covers validators (args, returns, the schema), the transaction's own index entries (it sorts after every real timestamp), and index range values: `q.eq(f, db.vars.commitTs)` finds this transaction's rows.
  - Read back within the mutation (`get`, queries), a written placeholder is the placeholder.
  - A patch keeps the placeholders of fields it does not touch.
- **Restrictions**:
  - A top-level query returning it: "Function {path} return value invalid: queries cannot return an unresolved commit timestamp".
  - Elsewhere (client args, scheduler args, `.filter` literals) the token is a field name starting with `$`, which is refused.
  - Nested `runMutation` / `runQuery` from a mutation pass it through.

## 2. What an app can observe

The placeholder object and its errors, the resolved int64 (equal to the mutation's ts), its order, how indexes
treat it inside the mutation, and the errors above.

## 3. How bunvex does it (PR 1)

- **`@bunvex/values`**: `CommitTsPlaceholder` (a branded class, the one `commitTsPlaceholder`), `v.commitTs()`, `Value` including the placeholder.
  - Validators and sort keys see it as `MAX_COMMIT_TS`.
  - `toJsonValue` writes Convex's token.
  - `resolveCommitTs` / `resolveCommitTsJson` replace it.
- **`Tx`**:
  - `vars` exists in mutations.
  - insert, patch and replace store `MAX_COMMIT_TS` and remember where the placeholders are. Reads (`get`, `take`/`first`/`collect`, iteration, `paginate`) hand the placeholder back at those places.
  - Savepoints keep those places too.
  - `resolveCommitTs(ns)` puts the commit's timestamp there.
- **Committer**: a new `atTs(ts)` hook runs once the ts is assigned, before the log and the write. The engine resolves the documents there and re-derives their index entries, then resolves the result.
  - The value is `ts × 1000` ns: bunvex's ts are µs, the same unit as the wire `ts` (DV-30).
- **Session requests**: a recorded result holding the token gets a `commitTs: db.vars.commitTs` field, so the replay resolves it to the original commit's ts.
- **Queries**: a query's result holding it is refused with Convex's message.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| T1 | A query running inside a mutation (`ctx.runQuery`) sees `db.vars` | bunvex gives nested functions the caller's transaction object; Convex gives a query a reader without `vars`. **Not done yet** | DV-267, pending |
| T2 | The token in arguments that do not accept it (client, scheduler, `.filter`) is refused with bunvex's value error, not Convex's "Field name $commitTs starts with '$', which is reserved." | **Not done yet**: PR 2 aligns these messages (and cron logs of results holding it) | DV-268, pending |
