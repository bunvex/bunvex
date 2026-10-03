# STUDY-57 — Pausing a deployment (`_backend_state`, pause / unpause)

- **Status:** implemented (PR feat/pause-deployment)
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-03
- **Related:** [STUDY-30](STUDY-30-scheduler-and-crons.md) (the executors), [STUDY-32](STUDY-32-file-storage.md)
  (file storage), [STUDY-48](STUDY-48-audit-log.md) (audit events), [STUDY-34](STUDY-34-admin-keys.md)
  (operations), UI-01 §17.2 (the dashboard's pause screen)

## 1. How Convex does it

### 1.1 The state (`crates/model/src/backend_state`, `crates/common/src/types/backend_state.rs`)

- `_backend_state` (table number 536) holds one document, `{system, usage_limit, user}`:
  - `system`: `none`, `disabled` or `suspended`, set by Convex's cloud;
  - `usage_limit`: `none` or `disabled`, set by the usage-limit worker;
  - `user`: `none` or `paused`, set by an operator.
- `is_stopped()`: any of the three is not `none`.
- `set_user_stop_state(new)` replaces the document and returns the old state, or nothing when `user` is
  already `new`.

### 1.2 The routes (`crates/local_backend/src/deployment_state.rs`)

- `POST /api/v1/pause_deployment` needs `PauseDeployment`.
  - It fails when `system` is not `none`: 400 `PauseDeploymentFailed`, "Deployment is currently disabled or
    suspended by Convex and cannot be paused."
  - Otherwise it sets `user: paused` and answers 200 with no body. Pausing a paused deployment is a 200 too.
- `POST /api/v1/unpause_deployment` needs `UnpauseDeployment`.
  - It fails when `system` is not `none`: 400 `UnpauseDeploymentFailed` ("… cannot be unpaused.").
  - It fails when `user` is not `paused`: 400 `UnpauseDeploymentFailed`, "Deployment is not currently
    paused."
  - Otherwise it sets `user: none`; 200, no body.
- `application/src/deployment_state.rs`: the change commits with an audit event, `pause_deployment` or
  `unpause_deployment` (metadata `{}`), only when the state changed.

### 1.3 Function calls (`crates/udf/src/validation.rs` `fail_while_not_running`)

- Every user function call checks the state in its own transaction, before it resolves the path:
  `ValidatedPathAndArgs::new` (queries, mutations, actions, from clients and from other functions) and
  `ValidatedHttpPath::new` (HTTP actions). System functions skip the check.
- A stopped deployment fails the call with a `JsError` (a function error, not an HTTP error). In order:
  - `system: disabled`: the free-plan or spending-limit message;
  - `usage_limit: disabled` (system `none`): "This deployment has been disabled because it exceeded a
    configured usage limit. …";
  - `system: suspended`: "Cannot run functions while this deployment is suspended. …";
  - `user: paused`: "Cannot run functions while this deployment is paused. Resume the deployment in the
    dashboard settings to allow functions to run."
- Being a read in the call's transaction, the check is part of a query's read set: a subscribed query
  reruns when the deployment is paused or unpaused.
- An HTTP action refused this way answers as an uncaught error does (`RedactedJsError` response parts).

### 1.4 The executors

- `scheduled_jobs/mod.rs` and `cron_jobs/mod.rs` `run_once`: while stopped, the executor does not poll
  (`next_job_ready_time = None`). It waits on a subscription to its transaction's reads, which include
  `_backend_state`, so an unpause wakes it.
- A scheduled job due while paused runs after the unpause. A cron misses its runs and runs once, then moves
  on (its usual catch-up rule, STUDY-30).

### 1.5 File storage (`application/src/lib.rs` `bail_if_not_running`, `application_function_runner`)

- `store_file`, `get_file` and `get_file_range` (HTTP upload and download) and the action callbacks
  `storage_get_url`, `storage_get_file_entry` (getMetadata, get), `storage_store_file_entry` (store) and
  `storage_delete` fail while stopped.
- The error is 400 `BackendIsNotRunning`, "Cannot perform this operation when the backend is not running".
- `generateUploadUrl` is not checked.

### 1.6 The dashboard's queries (`npm-packages/system-udfs/convex/_system/frontend`)

- `backendState`: `{system, usage_limit, user}`.
- `deploymentState`: Convex's older form, `{state}`: `disabled`, `suspended`, `paused` or `running`. A
  usage-limit stop reads as `running`.
- Both are `queryPrivateSystem(noPermissionRequired)`: any admin key, whatever its operations.

## 2. What an app can observe

- While paused, every call of a user function fails with the paused message, a cached query too; a
  subscribed query turns into that error and back.
- Scheduled functions and crons wait; file storage refuses with `BackendIsNotRunning`.
- The routes' statuses, codes and messages, and the audit events.

## 3. How bunvex does it

- **The state** (`core/src/backend-state.ts`): `_backend_state` with Convex's number and document.
  `readBackendState`, `isStopped`, `setUserStopState` and `notRunningMessage` mirror Convex's model.
  bunvex only ever sets `user`. A missing document reads as running; the first pause inserts it.
- **The routes** (`server/src/server.ts` `pauseRoute`): Convex's paths, operations, statuses, codes and
  messages. The change and its audit event commit together, the event only when the state changed.
- **Function calls** (`server/src/functions.ts` `failWhileNotRunning`):
  - The check runs at the start of a query's or mutation's body, in its transaction, before the path
    resolves (`fnLater` defers a resolution error until after it).
  - Actions and HTTP actions check in a transaction of their own before they start, as Convex's.
  - The error is a `FunctionPathError`: a function error with no "Uncaught", as Convex's `JsError`.
  - System functions do not check.
- **The read is cheap, and out of the function's limits:**
  - `BackendStateCache` keeps the state as of the last commit that wrote `_backend_state`.
    - A transaction at or after that commit takes it from the cache; one before it scans.
    - Commits update the cache as they become visible, before any transaction can begin at their ts.
  - Either way the transaction records the whole table in its read set, so subscriptions and the query
    cache are invalidated by a pause, and a mutation conflicts with it.
  - Convex keeps system-table reads out of the user's limits (`system_tx_size`). The check's read counts
    neither against `databaseQueries` nor against the documents and bytes read (`Tx.uncountedRead`).
- **The executors** (`scheduler.ts`, `cron-executor.ts`):
  - Each loop reads the state first. While stopped it sleeps with no timer.
  - Each executor's commit listener wakes it on a write to `_backend_state`, as Convex's subscription
    does.
- **File storage** (`storage.ts`):
  - Upload, download and the action methods `getUrl`, `getMetadata`, `get`, `store` and `delete` check
    the state and throw `BackendIsNotRunningError`. The HTTP routes answer it as 400.
  - In an action the error is a function error with Convex's message.
- **The queries**: `_system/frontend/backendState` and `_system/frontend/deploymentState`, both
  `noPermissionRequired` (a new `SystemQuery` flag).

### 3.1 Cost

The check runs on every user function call. Measured in process (in-memory store, a trivial query and a
one-insert mutation, 30 000 calls × 3 rounds):

| | without the check | with it |
|---|--:|--:|
| no `_backend_state` document | query 2.7–2.9 µs, mutation 22–24 µs | query 2.9–3.1 µs, mutation 22–23 µs |
| with a document | query 2.8–3.1 µs, mutation 21–25 µs | query 2.7–3.6 µs, mutation 22–27 µs |

That is about +0.2 µs per query, and within the noise for mutations. A first version that scanned the
table on every call cost +4 µs per query and +6 µs per mutation once a document existed. The cache
replaced it.

## 4. Divergences

None an app can reach:

- **Messages for states bunvex never sets.** The `disabled`, `suspended` and usage-limit messages, and the
  routes' "disabled or suspended" message, are reworded without Convex's name and links (rule 5). These
  states only arrive through an imported `_backend_state`.
- **The dashboard contract** (`data-source-state.ts`) says resuming a running deployment is not an error,
  while the server answers 400 as Convex's. The dashboard has only the mock source today. A server-backed
  source should treat that 400 as done.

## 5. Tests

- `server/test/pause-deployment.test.ts`:
  - the routes: statuses, empty body, codes and messages, state queries, one audit event per change;
  - the operations: a read-only key cannot pause; a key without `ViewData` reads the state;
  - user functions fail while paused (a cached query too, a query run from the cache path too, a missing
    function too); system ones run; an HTTP action answers 500 with the message; all resume after
    unpause;
  - a scheduled job waits and runs after unpause;
  - file storage: upload, download, and `ctx.storage.store` in an action that was running when the pause
    came;
  - the check stays out of the function's limits (`databaseQueries`, `documentsRead`), on the scan path
    and the cache path.
- `server/test/cron.test.ts`: a paused deployment's cron is not even attempted, and runs once unpaused.
- `core/test/catalog.test.ts`: the table number.
- Sabotage checks, each failing its test:
  - removing the check in query bodies, in actions, or deferring path errors;
  - the scheduler's or the cron executor's state check, and the cron executor's wake-up;
  - the download and `store` guards;
  - `noPermissionRequired`, and the audit event's "only on change";
  - the cache's invalidation, and its read-set entry;
  - the uncounted read (intervals, and documents).

## 6. Open questions

- Convex does not run an HTTP action refused this way, and so records no execution for it. bunvex records
  each refused call as a failed execution in the function log. Not checked against a live Convex
  deployment.
