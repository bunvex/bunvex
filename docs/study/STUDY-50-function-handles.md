# STUDY-50 — Function handles

- **Status:** accepted: H1 as recommended (owner, 2026-10-03)
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-02
- **Related:** [STUDY-30](STUDY-30-scheduler-and-crons.md) (the scheduler), [STUDY-41](STUDY-41-nested-calls.md)
  (nested calls), [STUDY-35](STUDY-35-push.md) (pushes)

## 1. How Convex does it

- **`createFunctionHandle(ref)`** (`npm-packages/convex/src/server/components/index.ts`) is the `1.0/createFunctionHandle` syscall (`isolate/src/environment/*/async_syscall.rs`).
  - It works in queries, mutations and actions.
  - A handle passed to it comes back as is.
  - A system function is refused: "Cannot create function handle for system UDF".
  - A function with no row is refused: `FunctionHandleNotFound`, "Function handle not found".
- **The handle**: `function://<document id>#<stripped path>` (`common/src/bootstrap_model/components/handles.rs`).
  - Only the id counts when resolving it; the fragment is advisory.
- **`_function_handles`** (DefaultTableNumber 33, number 545) holds `{component, path, deletedTs}`, indexed `by_component_path`.
  - `FunctionHandlesModel::apply_config_diff` runs in the push's transaction: it adds a row for each new function.
  - When a function goes, its row is tombstoned (`deletedTs`); when it returns, the row is revived, so its handles work again.
- **Resolution**: `getFunctionAddress` (`server/components/paths.ts`) turns a string that starts with `function://` into `{functionHandle}`.
  - `ctx.runQuery` / `runMutation` / `runAction` and the scheduler resolve it to the path through the row, read in the caller's transaction.
  - A tombstoned or missing row is "Function handle not found".

## 2. What an app can observe

The handle strings, which functions they run, that they survive a delete and re-create, and the errors.

## 3. How bunvex does it

- **Storage**: `_function_handles` (number 545, `by_component_path`), with `component` always null (no components yet).
- **`server/src/function-handles.ts`**:
  - `createFunctionHandle`, exported by `@bunvex/server` with the `FunctionHandle` type, finds the running function through an async context and reads in its transaction, or in an action, in a transaction of its own.
  - `syncFunctionHandles` is Convex's `apply_config_diff`.
  - `resolveHandle` resolves a handle to its path.
- **Where handles are resolved**: the nested calls and the scheduler resolve handles in the caller's transaction; actions resolve them in a transaction of their own.
- **When the rows are kept up to date**: a push installs its code, then syncs the rows. An embedded server syncs its registered functions when it starts.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| H1 | The rows are synced in a transaction right after a push installs its code, not in the push's own | bunvex's push commits its config before it installs the code version (STUDY-35). **Not done yet** (doable by moving it into `finish_push`'s transaction); for an instant after a push, a new function's handle may be "not found" | DV-264, accepted (owner, 2026-10-03) |
