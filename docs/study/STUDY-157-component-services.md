# STUDY-157 — Components: scheduler, crons, storage, HTTP and search per component (STUDY-152 step 7)

- **Status:** decided (owner, 2026-10-19):
  - Q-1: an action's cancel in its own component (DV-536);
  - Q-2: `_scheduled_functions` names a child component's job target (AD-33, "if simple");
  - Q-3: search in components as step 7's last PR;
  - Q-4: the order of §6.

  Built: PR 1, the scheduler (`packages/server/test/component-scheduler.test.ts`); PR 2, the crons
  (`component-crons.test.ts`).
- **Convex source read:** `d8bdde0`, the reference commit (docs/parity/upstream.md). Paths are relative to its
  root. Tests: js-integration-tests at `c358201e1`, Rust tests at `bea52bde0` (memory: Convex test snapshots).
- **bunvex source:** `main` after STUDY-156 (`6bc5beb2`). Paths are relative to `packages/`.
- **Scope.** What a component's functions may do beyond their database:
  - `ctx.scheduler`, and scheduling a child's function from the parent;
  - a component's `crons.ts`;
  - `ctx.storage`, and the upload and serve URLs;
  - a component's `http.ts` mounted under a prefix;
  - search and vector indexes in a component's schema.

  It lifts STUDY-154's P-2 and STUDY-155's Q-4. Env per component is built (STUDY-154), and Node actions stay
  refused, as Convex's (§1.7).
- **Related:**
  - [STUDY-152](STUDY-152-components-restudy.md) §3 and the §8 step 7 row;
  - [STUDY-154](STUDY-154-component-runtime.md) P-2;
  - [STUDY-155](STUDY-155-component-calls.md) Q-4;
  - [STUDY-62](STUDY-62-components.md) §7.

## 1. How Convex does it

### 1.1 Scheduler

- **Where the job lives.** The job always lives in the **caller's** namespace, whatever component it runs in.
  - `ScheduledJob` "lives the queue / _scheduled_jobs table of the component that scheduled it. But it can run
    jobs in a different component" (`crates/model/src/scheduled_jobs/types.rs:24-28, 70-74`).
  - The row stores the target's component **path** in `component` (absent: the root, `types.rs:141-182`), beside
    `udfPath`.
  - Its arguments go to `_scheduled_job_args` in the same namespace.
- **The syscall.** `schedule()` (`crates/isolate/src/environment/udf/async_syscall.rs:1160-1226`) resolves the
  target and writes into the caller's namespace (`VirtualSchedulerModel::new(tx, scheduling_component)`).
  - The target is resolved by handle or by reference, as STUDY-155's calls.
  - Its texts:
    - "Only functions can be scheduled. {} is not a function";
    - "Cannot schedule function by component id".
  - Validation (`crates/udf/src/validation.rs:181-250`) names the component: "Attempted to schedule function,
    but no exported function {name} found in the file: {module} in '<path>'. Did you forget to export it?".
  - An action's schedule passes its component too (`action/async_syscall.rs:357-367`).
- **Limits.** "Too many functions scheduled by this mutation" and the arguments' size are counted on the
  transaction (`crates/model/src/scheduled_jobs/mod.rs:162-195`), so across a top-level mutation and its nested
  calls.
- **Cancel.**
  - A mutation's `cancel` resolves the id in its own namespace (`async_syscall.rs:1228-1276`;
    `scheduled_jobs/mod.rs:532-590`).
  - Another namespace's id names the same table number in the caller's own table: no row, so a silent no-op
    (`mod.rs:398-412`).
  - **An action's cancel is the root's**, `TableNamespace::by_component_TODO()`
    (`crates/application/src/application_function_runner/mod.rs:2368-2391`). A component action's cancel of its
    own job is a no-op, and could cancel the root's job of the same internal id: a Convex gap (Q-1).
- **The executor** (`crates/application/src/scheduled_jobs/mod.rs`):
  - One worker for all namespaces: their `by_next_ts` streams merged by `(next_ts, namespace)` (`:450-515`).
  - Each job runs with `FunctionCaller::Scheduler { job_id, component_id }` and no identity (`:264-267, 576-785`).
  - Its state is written in the job's namespace.
  - Garbage collection covers every namespace (`:1155-1191`).
- **`db.system`.** `_scheduled_functions` is per namespace, so another namespace's job id reads `null`. Its
  documents carry no component (`virtual_table.rs:96-97`, "TODO(ENG-6920) include component") (Q-2).
- **Cascading cancel.** A job scheduled by a canceled job is inserted canceled, its parent looked up in both
  namespaces (`mod.rs:276-322`).
- **Tests.** `scheduler.test.ts` "Scheduler in component":
  - "schedule in parent";
  - "schedule within component";
  - "schedule child from parent": the job visible in the parent only, the message landing in the child.

  `component.test.ts`: "Function handles can be used in scheduling APIs".

### 1.2 Crons

- **At push.** Each component's `crons.js` is applied to its own `_cron_jobs` / `_cron_next_run`
  (`crates/model/src/components/config.rs:590, 657, 711`; `cron_jobs/mod.rs:151-195`).
  - Each component diff carries its `cronDiff`.
  - An unmount deletes the component's crons.
- **Targets.** A cron targets only its own component's functions. `cronJobs` throws on a `components.…` reference
  or a handle: `Expected function reference in the current component like "api.file.func" …`
  (`npm-packages/convex/src/server/api.ts:251-270`).
- **The executor** merges every namespace (`cron_jobs/mod.rs:432-480`) and runs each job in its tablet's
  component, with no identity (`crates/application/src/cron_jobs/mod.rs:335-452`).
- **Tests.** No js-integration-test covers crons in a component.

### 1.3 Storage

- **`_storage` is per namespace.** Queries, mutations and actions use their component
  (`udf/async_syscall.rs:384-418`; `action/async_syscall.rs:461-535`; `action/storage.rs:42-150`).
- **Upload.** `generateUploadUrl` is `{origin}/api/storage/upload?token=…`, with the component **sealed in the
  token** (`crates/keybroker/src/broker.rs:1357-1380`).
  - The upload stores the file in that namespace (`local_backend/storage.rs:79-130`).
  - A bad component id in a token: `InvalidStorageToken` "Invalid component ID".
- **Serve.** A component's `getUrl` appends `?component=<id>`; the root's has none (`crates/file_storage/src/core.rs:136-182`).
  - `GET /api/storage/<uuid>?component=<id>` reads that namespace (`local_backend/storage.rs:133-210`).
  - The errors are 404 `FileNotFound` "File {id} not found" and "Component {component:?} not found".
  - Without the parameter, a component's file is a 404.
- **Tests.** `fileStorage.test.ts` "File storage in component":
  - "file storage upload and get url": the file is in the child's `_storage`, not the parent's, and the URL
    matches `…/api/storage/.*\?component=.*`;
  - "file storage store and get".

### 1.4 HTTP

- **Mounts.** `app.use(c, { httpPrefix })` mounts the child's `http.js` (Convex's `httpMounts`).
  - The push's type check refuses a bad mount: a non-child, a child without routes, an overlap
    (`crates/model/src/components/type_checking.rs:505-550`). bunvex checks these already (STUDY-153 PR 3b).
  - A grandchild's prefix is its parent's plus its own mount.
  - The app's own `httpPrefix` does not compose into its children's.
- **Routing.** `route_http_action` (`crates/application/src/application_function_runner/http_routing.rs:332-480`)
  walks from the root:
  - the app's `http.js` matches after its own `httpPrefix` is stripped; mounts match the unstripped path;
  - an exact route wins, else the longest prefix among prefix routes and mounts;
  - a mount descends into the child with the rest of the path (`/` + suffix);
  - no match falls back to the current component's `http.js`, so its router answers 404 "No matching routes
    found".
- **What the handler sees.** It runs in the matched component. It receives the whole original `Request`, and its
  router looks up the stripped path (`action/mod.rs:540-545, 875-900`).
- **Reachability.** A component without a mount is unreachable. A grandchild is reachable only through its
  parent's mount.
- **Site URL.** `CONVEX_SITE_URL` carries the prefix (`crates/udf/src/environment.rs:89-117`). bunvex has done
  this since STUDY-154.
- **Tests.** Rust `crates/application/src/tests/http_action.rs` at `bea52bde0`:
  - `test_http_mount_routes_to_child_component`;
  - `…_no_route_outside_mount`;
  - `…_site_url_prefixed`;
  - `test_http_prefix_and_mount_*`;
  - `test_http_no_prefix_component_routes_not_accessible`;
  - `test_http_grandchild_*`.

### 1.5 Search and vector indexes

- **Supported in components.**
  - A component's schema may declare them.
  - Its queries search them.
  - Its actions' `ctx.vectorSearch` resolves the index in the component (`action/async_syscall.rs:392-410`).
- **Tests.** `vectorSearchInComponent.test.ts` (1) and `textSearchInComponent.test.ts` (7).

### 1.6 Env

Built (STUDY-154): a component sees its bindings and the built-ins, with `BUNVEX_SITE_URL` carrying its prefix.

### 1.7 Node actions

Refused in components:

- by the backend: "Node actions are not supported in components" (`deploy_config.rs:1511-1522`);
- by the CLI: `"use node" directive is not supported in components`.

Both refusals are built (STUDY-153, STUDY-156).

## 2. What apps observe

- **Scheduling.**
  - A component schedules its own functions, and the parent schedules a child's by reference or handle.
  - Each job is seen only in the scheduler's namespace, and runs where its target is.
- **Crons.** A component's crons run.
- **Storage.**
  - A component stores and serves files of its own.
  - Its URLs carry `?component=`, and its upload URLs work from the client as any other.
- **HTTP.** A mounted component answers under its prefix.
- **Search.** A component's schema may hold search and vector indexes, and its functions use them.

## 3. bunvex today

- **Refusals.**
  - `ctx.scheduler` and `ctx.storage` in a component throw "`ctx.scheduler` in a component is not supported
    yet" (`server/src/functions.ts:247-259`, used at `:1883-1902, 2774-2787`).
  - Scheduling a component's function from the app throws "Scheduling a function of a component is not supported
    yet" (`server/src/scheduler.ts:142-149`).
  - `ctx.vectorSearch` is refused (`functions.ts:2790-2793`).
  - Search and vector indexes in a component's schema are refused (`core/src/engine.ts:4309-4311`;
    `server/src/push.ts:169-180`; STUDY-153 PR 2b).
- **Tables.** Every component namespace has its own `_scheduled_jobs`, `_scheduled_job_args`, `_file_storage`,
  `_cron_jobs`, `_cron_next_run` and `_cron_job_logs` (`core/src/components.ts:295-314`).
- **Scheduler.**
  - A job row has `component: ""` always (`core/src/scheduled-jobs.ts:48-66, 170`).
  - `ScheduledJobExecutor` watches and reads the root's table only (`server/src/scheduler.ts:254-627`).
  - `Functions.scheduledTarget` / `scheduledKind` know the app's functions only (`functions.ts:2257-2271, 2437`).
  - `/api/cancel_job` ignores `componentId` (`server/src/server.ts:1447-1469`).
- **Crons.** A component's `crons.js` is checked and its rows are written in its namespace at push
  (`server/src/cron-executor.ts:149-155`). `CronJobExecutor` runs the root's only (`:103-108, 201-255`).
- **Storage.**
  - The upload token seals only `{issued}` (`server/src/storage.ts:95-109`).
  - `getUrl` has no `?component=` (`:181-183`).
  - `addRow` and the serve route read the root (`:186-200, 355`; `server.ts:1080-1100`).
- **HTTP.** The tree computes and checks prefixes and mounts (`server/src/component-tree.ts:132-308`). The router
  serves the app's `http.js` only: one `router.lookup` (`server/src/http-actions.ts:62-87`), and a component's
  router is dropped at install (`functions.ts:904-922`).

## 4. How bunvex would do it

### 4.1 Scheduler

- **Jobs.**
  - A job row gets the target's component path in `component` (`""` the root).
  - It is written in the caller's namespace (`insertJob` in the caller's `Tx`, which is already in it).
  - The target resolves through STUDY-155's `resolveCall` (reference, name, handle); the refusals in
    `scheduler.ts` go.
  - Validation and kind come from the target's component, with Convex's texts naming it (`in '<path>'`).
- **One executor for every namespace.**
  - It subscribes to each namespace's `by_next_ts` (the root's and every component's, new ones as they appear
    after a push) and merges by `(nextTs, namespace)`.
  - One concurrency limit for all, as Convex's.
  - Each job carries its namespace: its state, arguments and garbage collection are read and written there.
  - It runs the target in its component with no identity.
- **Cancel.**
  - A mutation's cancel resolves in its namespace.
  - An action's cancel resolves in its component's namespace too (Q-1).
  - `/api/cancel_job` and `cancel_all_jobs` honour `componentId`, as Convex's routes.
  - The cascade of a canceled parent, across namespaces.
- **Limits.** Counted per top-level transaction, as Convex's.
- **`_scheduled_functions` (AD-33).** A job whose target is in a child component carries `component: "<path>"`
  in its `_scheduled_functions` document, the field Convex's ENG-6920 TODO means to add. The root's jobs have no
  such field, so an app without components reads Convex's documents. The system table's type gets an optional
  `component?: string`.

### 4.2 Crons

`CronJobExecutor` runs every namespace's crons the same way: subscriptions per namespace, the job run in its
component, logs in its namespace. A cron's target is already checked against its own component's functions.

### 4.3 Storage

- **Upload token.** It seals the component's id. The upload route stores in that namespace, and a bad id is
  `InvalidStorageToken` "Invalid component ID".
- **Serve URL.** A component's `getUrl` appends `?component=<id>`. `GET /api/storage/<id>` reads that namespace,
  with Convex's 404s.
- **Storage functions.** `ctx.storage` (query, mutation, action) works in the function's namespace.
- **Dashboard.** Its file pages with `componentId` are step 9.

### 4.4 HTTP

- **Install.** Each component's router is kept at install.
- **Routing.** The HTTP server routes as Convex's `route_http_action`:
  - the app's `http.js` after its `httpPrefix`;
  - exact before the longest prefix, mounts among the prefixes;
  - a mount descends with the rest of the path;
  - a fallback to the current component's router for the 404.
- **The handler** runs in its component with the original `Request`.

### 4.5 Search and vector indexes (Q-3)

- **Schema.** The refusals in `engine.ts` and `push.ts` go.
- **Indexes.** The search and vector index workers build and serve each namespace's indexes. The engine's
  `SearchIndexes` / `VectorIndexes` are keyed by table id, so a component's table is its own key (to confirm in
  PR 5).
- **Search.** A component's `withSearchIndex` and its actions' `ctx.vectorSearch` read its namespace.

## 5. Questions for the owner

| # | Where bunvex would differ | Convex | Recommendation | Decision |
|---|---|---|---|---|
| Q-1 | **An action's `ctx.scheduler.cancel` in a component** | cancels in the **root's** namespace (`by_component_TODO`): a no-op for the component's own jobs, and it may cancel the root's job of the same internal id | Cancel in the component's own namespace, as its mutations do (new DV): Convex's behaviour is a TODO that can cancel another namespace's job | **Decided (owner, 2026-10-19): in the component** (DV-536) |
| Q-2 | **`_scheduled_functions` without the target's component** | no component field (ENG-6920 TODO) | As Convex (no DV): a field Convex will add is an API change to make when it does | **Decided (owner, 2026-10-19): add it if it is simple and changes little** (AD-33: an optional `component` path, only for a child's job, §4.1) |
| Q-3 | **Search and vector indexes in components** | supported | Build them in step 7, as its last PR (no DV): Convex's search tests in components are oracles; until then the refusal stays (an interim gap, as P-2) | **Decided (owner, 2026-10-19): step 7's last PR** |
| Q-4 | **Order of the PRs** | — | Scheduler, crons, storage, HTTP, search (§6): the scheduler first (workpool needs it), each PR independent of the next | **Decided (owner, 2026-10-19): as recommended** |

## 6. Proposed PRs

1. **Scheduler in components.** Built.
   - Jobs written in the caller's namespace with the target's path.
   - The executor over every namespace.
   - Cancel (Q-1), the cascade, `/api/cancel_job` with `componentId`.
   - `_scheduled_functions`' `component` for a child's job (AD-33).
   - Tests: Convex's three "Scheduler in component" cases, a handle, a component action's schedule and cancel,
     limits across nested calls, a job in an unmounted component.
2. **Crons in components.** Built. The cron executor over every namespace. Tests: a component's cron runs in it; an
   unmount stops it.
3. **Storage in components.**
   - The token with the component.
   - `?component=` URLs and the serve route.
   - `ctx.storage` everywhere.
   - Tests: Convex's two "File storage in component" cases, a missing component's 404.
4. **HTTP mounts.** The router as Convex's `route_http_action`. Tests: the Rust `http_action.rs` mount, prefix and
   grandchild cases, rewritten as bunvex tests.
5. **Search and vector indexes in components (Q-3).** Tests: Convex's text and vector search component cases.

## Divergences

| # | Divergence | Decision |
|---|---|---|
| DV-536 | An action's `ctx.scheduler.cancel` in a component resolves the job in the component's namespace, as its mutations do; Convex's resolves it in the root's (`by_component_TODO`) | owner, 2026-10-19 |

Addition: AD-33, `_scheduled_functions` naming a child component's job target (Q-2), in
[additions.md](../parity/additions.md).
