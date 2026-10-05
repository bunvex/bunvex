# STUDY-120 — `dev` waits on a table after a schema validation failure

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-37](STUDY-37-cli-and-environment-variables.md) (`bunvex dev`, the environment-variable
  wait), [STUDY-35](STUDY-35-push-and-deploy.md) (`wait_for_schema`)

## 1. How Convex does it

- **The push.** `npm-packages/convex/src/cli/lib/deploy2.ts:310` (`waitForSchema`) handles a `failed` status
  this way:
  - it fails the spinner with "Schema validation failed." (` in component "<path>"` before the period for a
    component); the spinner prints `✖ <message>`;
  - it prints the server's error on the next line (`logError`); the error names the table and the document;
  - it crashes with the error type `{"invalid filesystem or db data": {tableName, componentPath} | null}`.
- **The dev loop.** `cli/lib/dev.ts:395–442` keeps that `tableName` (`tableNameTriggeringRetry`). It then
  races three watches:
  - the file system;
  - `getTableWatch` (`:486`);
  - `getDeplymentEnvVarWatch` (`:504`; it is armed only after an "invalid filesystem or env vars" error).
- **The table watch** (`getFunctionWatch`, `:520`) is a subscription to `_system/cli/queryTable {tableName}`:
  - the first result is the current state, and the second ends the wait;
  - then dev pushes again, with no file change needed;
  - with no table, the watch waits forever.
- **`_system/cli/queryTable`** (`npm-packages/system-udfs/convex/_system/cli/queryTable.ts`) is a `ViewData`
  query. It counts the table, so it reads the whole table, and returns `Math.random()`. Any change to the
  table re-runs it, and the new number is a new result.

## 2. What an app can observe

- A developer whose stored documents fail a new schema sees `✖ Schema validation failed.`, then the error.
- When they fix the documents (dashboard, a mutation, an import), `dev` pushes again on its own.
- A change to another table does not trigger a push.
- `_system/cli/queryTable` is callable by an admin with `ViewData`. It returns a number in [0, 1).

## 3. How bunvex does it

- **Server.** `_system/cli/queryTable` in `packages/server/src/system-functions.ts`, with `op: "ViewData"`.
  It calls `countTable(tableName)`, which records the whole `by_creation_time` interval, so a cached run or a
  subscription re-runs on any change to the table. It returns `Math.random()`.
- **The push.** `deploy.ts` prints Convex's two lines. It returns `table` in its `DeployResult` when the
  failure names a table.
- **The dev loop.** `dev.ts` generalizes the environment-variable watch into `resultChanged(path, args)`. After
  a failure, it races the file watch with:
  - the table's subscription, when the failure named a table;
  - the variables' subscription, after an environment-variable error.

Owner decision (2026-10-05): match Convex, `Math.random()` return value included.

## 4. Divergences

None. The failure message changed to match Convex. Before, bunvex printed `Schema validation failed in table
"X".` on one line with the error. Convex's error already names the table, so nothing is lost.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/cli/test/dev.test.ts`:

- **"a schema its documents fail".** The steps:
  - push an app with no schema, and insert `{body: 1}`;
  - write a schema with `body: v.string()`;
  - check Convex's two lines (the error names `"messages"`) and that no push is ready;
  - insert into another table: no push;
  - fix the document with a mutation (admin API): dev pushes again, with no file change.
- **"_system/cli/queryTable".** A number in [0, 1) for an admin; refused without a key.

**Sabotage** (each restored; `git diff` clean after):

| # | Change | Failed |
|---|---|---|
| S1 | `queryTable` returns a constant | "a schema its documents fail" |
| S2 | `queryTable` counts another table | same |
| S3 | `deploy` returns no `table` | same |
| S4 | dev watches the wrong table | same |
| S5 | the old one-line message | same |

No hot path: `queryTable` runs only while dev waits.

## 6. Open questions

None.
