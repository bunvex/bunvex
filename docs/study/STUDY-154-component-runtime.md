# STUDY-154 — Components: running a function inside a component (STUDY-152 step 4)
<!-- index: Components, step 4: running a function inside a component — the admin entries with a component path, its code, env, schema and refusals, errors, logs and cache; a three-PR plan | decided (owner, 2026-10-16): DV-530; being built -->

- **Status:** decided (owner, 2026-10-16): P-1 a 400 at `/api/function` too (DV-530), P-2 refused until step 7, P-3
  measured in PR 2 (§5). Steps 1–3 are built (STUDY-152 §10–11, STUDY-153).
- **Convex source read:** `d8bdde0` of get-convex/convex-backend, the reference commit (docs/parity/upstream.md).
  Paths are relative to its root.
- **bunvex source:** `main` after STUDY-153 (#705–#707). Paths are relative to `packages/`.
- **Scope.** A function of a component run **directly**: an admin's call with a component path (`/api/function`,
  the websocket, the dashboard's runner and custom query), what it sees inside (its namespace, code, schema,
  variables) and what an app or admin observes (errors, logs, cache). **Not in scope:** calls across components
  (references, handles, `ctx.runQuery` into a child, the subtransaction) are step 5. A component's scheduler,
  crons, storage and HTTP mounts are step 7.
- **Related:** [STUDY-152](STUDY-152-components-restudy.md) (C2 / DV-492, C3), [STUDY-153](STUDY-153-component-push.md).

## 1. How Convex runs a function inside a component

### 1.1 Who can call one, and how

| Entry | Takes | Who | Unknown path | Notes |
|---|---|---|---|---|
| `POST /api/query`, `/api/mutation`, `/api/action`, `/api/query_batch`, `/api/run/…` | no component field (`public_api.rs:73-81`; an extra `componentPath` is ignored) | anyone | — | root exports only; `/api/run` says "Only functions exported at the root can be called through this endpoint" (`:335-337`) |
| `POST /api/function` | `UdfPostRequestWithComponent {componentPath?, path, args, format}` (`args_structs.rs:9-20`) | admin only, root included (`must_be_admin`, `args_structs.rs:23-26`): any other caller is 403 `BadDeployKey` | 500 InternalServerError (`must_component_path_to_ids` … "Component path not found" has no error metadata, `bootstrap_model/components/mod.rs:381-398`) | what `npx convex run --component` and `ConvexHttpClient.function` use |
| websocket `Query` / `Mutation` / `Action` | optional `componentPath` (`sync_types/src/types/json.rs:77-87, 216-228`) | admin or system for a non-root path (`worker.rs:581-596`); `""` is the root, for anyone | 400 `ComponentPathNotFound`, "Component path '{path}' not found" (`udf/src/validation.rs:569-581`) | the dashboard's runner sends mutations and actions so (`FunctionTester.tsx:591-605`) |
| `POST /api/run_test_function` | `componentId` (a `_components` id, not a path; `dashboard.rs:276-286`) | admin, `RunTestQuery` | internal error (`must_component_path`) | in a component: no user variables, the component's own `_udf_config` (`lib.rs:2744-2769`) |

- **`npx convex run --component <path>`** posts to `/api/function`. An inline query resolves the path to an id
  first, with `_system/frontend/components:list` (`cli/run.ts:238-285`).
- **The ensure.** Every component entry also checks `component.is_root() || is_admin() || is_system()`, "Only admin
  or system users can call functions on non-root components directly" (`api.rs:453-456`; `worker.rs:581-596`).
  - Over HTTP it has no error metadata: a 500.
  - An admin acting as a user (`ActingUser`, `npx convex run --identity`) passes `must_be_admin` but fails this
    check.
- **Lookup of the function** (`lib.rs:1535-1654`):
  - "Could not find function for '{udfPath}'{ in 'counter'}. Did you forget to run `npx convex dev`?"; the CLI
    reads "Could not find function" to list the functions (`cli/lib/run.ts:75-80`).
  - An admin reaches internal functions.
  - In a component, a public function needs an admin, system or acting user with `ViewData` (queries) or
    `WriteData` (mutations, actions); an internal one needs an admin and `RunInternal*`. Anyone else gets "Could
    not find public function for '{udfPath}' in '{componentPath}'." (`validation.rs:286-365`).
- **An unmounted component** still resolves (`component_registry.rs:176-212` reads no `state`). Its `_modules` are
  empty, so every call is "Could not find function". A write into its tables is 400 `UnmountedComponent`, "Cannot
  perform write operations in an unmounted component. Make sure your component is installed in your
  `convex.config.ts` file." (`user_facing.rs:116-138`).

### 1.2 What runs, and what it sees

- **Its code:**
  - comes from its namespace's `_modules` and latest `_source_packages` (`udf/phase.rs:284-345`;
    `action/phase.rs:188-209`);
  - its import seed, import time and server version come from its own `_udf_config` (`udf/phase.rs:186-193`;
    `validation.rs:377-413`).
  - Convex evaluates the modules afresh per call; bunvex evaluates them once per code version (DV-492).
- **`process.env`** (`udf/src/environment.rs:35-204`; actions the same, `action/phase.rs:225-378`):
  - a component sees its `_components.env` bindings: a `value` is the literal, an `envVar` is the deployment
    variable of that name (chains resolved at push, STUDY-153 §1.5);
  - it sees the system variables too: `CONVEX_CLOUD_URL` as is, and `CONVEX_SITE_URL` with the component's
    `httpPrefix` appended (trailing `/` trimmed);
  - anything else is `undefined`. A component never sees the deployment's variables directly.
- **`ctx.db`:**
  - It reads and writes the component's namespace (`udf/mod.rs:311-315`).
  - `get` of an id whose table number this namespace lacks is `null` (`user_facing.rs:66-90`).
  - `v.id` arguments are checked against the namespace's tables (`validation.rs:679-697`).
  - `db.system` is the component's own `_storage` and `_scheduled_functions`.
- **The schema** enforced on writes is the component's active schema (`schema/mod.rs:118-198`), with the root's
  message unchanged: "Failed to insert or update a document in table "{table}" because it does not match the
  schema: …".
- **Refused in a component:**
  - `.paginate()` is 400 `PaginationUnsupportedInComponents`, "paginate() is only supported in the app. Learn
    more at https://docs.convex.dev/components/authoring#pagination", after the page-size and cursor checks
    (`async_syscall.rs:1960-2004`);
  - `"use node"` modules are refused at push (STUDY-153).
- **`ctx.auth.getUserIdentity()`** is the caller's user identity. For an admin calling directly it is `null`
  (`async_syscall.rs:973-1004`).
- **Its scheduler and storage** are the component's own (`async_syscall.rs:384-500, 1207-1224`;
  `file_storage/src/core.rs:97-178`). Step 7.

### 1.3 What an admin or app observes

- **Errors.**
  - An uncaught error is `Uncaught …` with frames mapped through the component's source map. No component prefix
    is added (`common/src/errors.rs:694-798`).
  - Server messages name the component with `in_component_str()`, `" in 'a/b'"` (`component_path.rs:112-121`).
- **Logs and metrics.**
  - Log stream events carry `componentPath` (null for the app) beside `identifier` (`logs.rs:139-149`), and log
    sinks a `function.component_path` (`log_streaming.rs:1046-1071`).
  - Usage and app metrics take `componentPath` beside `udfPath` (`app_metrics.rs:33-42`).
- **The query cache** keys by the component **path** with the function (`cache/mod.rs:152-160`). A component's
  subscription re-runs when `_components` changes, since resolving the path reads it.
- **The dashboard** lists the functions with these, each with a `componentId` that re-runs the system function
  in that component (`currentSystemUdfInComponent`):
  - `_system/frontend/modules:listForAllComponents` (`[componentId | null, [path, module][]][]`);
  - `modules:list {componentId?}` and `modules:argsValidator {componentId?, function}`;
  - `components:list` (`{id, name, path, args, state, httpPrefix}`).

## 2. bunvex today

- **Admin calls with a component path are already parsed and checked:**
  - `UDF_POST_WITH_COMPONENT` (`server/src/json-body.ts:106-115`);
  - the websocket's `componentOf` (`server/src/sync.ts:1830-1839`), with Convex's "Only admin or system users …".
  - But any non-root path is `Component path '…' not found`: bunvex had no components.
- **Functions.**
  - `Functions` (`server/src/functions.ts`) holds one registry, the app's, which `install` replaces with a code
    version's.
  - A function's transaction is the root's; `db.inComponent` exists (STUDY-153 PR 2a) and nothing calls it from
    user code.
- **Schema enforcement.** `Tx.stage` checks the root's validators only (`core/src/tx.ts:1750`): a component's
  table is checked against none.
- **Code storage.**
  - A push stores each component's code in its namespace (STUDY-153 PR 4a): `_modules`, `_source_packages`,
    `_udf_config`.
  - `loadLatestCode` (`server/src/code-store.ts`) loads the app's only.
- **Dashboard system functions** (`frontend-system-functions.ts`, `data-system-*.ts`) accept `componentId` and
  answer for the app.
- **Function logs** carry `componentPath: null` (`function-log.ts:317-328`).

## 3. How bunvex would do it

### 3.1 One runtime per component instance (C3, DV-492)

- **Loading.** Each mounted component is loaded with `CodeVersion.load` from its namespace's latest package, with
  its own `_udf_config`'s seed and time, in **its own `vm` contexts** (C3). Two instances of one definition load
  twice: their globals are their own.
- **When.**
  - At start, for every mounted instance.
  - After a `finish_push`: every created, modified or remounted instance is reloaded, and an unmounted one is
    dropped. Its functions are then "not found", as on Convex.
- **Where it lives.** `Functions` keeps a registry per component, `componentId → {path, version, env,
  httpPrefix}`.
  - The app's stays as today.
  - A call names `(component, function)`.
  - Every body that runs user code wraps its transaction in `db.inComponent(id)`, so `ctx.db`, `v.id` checks and
    `db.system` are the component's.
- **What is not new.** The caches, limits, logs and timers are shared, as today; a component is not another
  deployment. The nested-call machinery (`ctx.runQuery` into the same component) works within the component, and
  calls across components are step 5.

### 3.2 What a component's function sees

- **`process.env`** is its bindings, resolved against the deployment's variables, plus the built-ins:
  - `BUNVEX_CLOUD_URL` as is;
  - `BUNVEX_SITE_URL` with its `httpPrefix` (bunvex's names for `CONVEX_*`, DV-312).
- **Its schema** is enforced on writes. `Engine` already keeps each component's active schema
  (`componentSchema(id)`, STUDY-153 PR 2b); the `Tx` gets the namespace's validators beside the root's. The
  pending schema's walk and staged validators stay root-only, as PR 2b refuses them in components.
- **A write into an unmounted component** is Convex's 400 `UnmountedComponent`, in bunvex's words (`bunvex.config.ts`,
  DV-494).
- **`.paginate()`** in a component is Convex's 400 `PaginationUnsupportedInComponents`, without its docs link
  (DV-04). Superseded: Convex d7402d6 allows it, and bunvex follows (STUDY-186 A8, #899).
- **`ctx.auth`** is as today: an admin's direct call has no user identity.

### 3.3 Entries, errors, logs, cache

- **`/api/function`, the websocket and `run_test_function`** resolve a path (or id) through the registry
  (`resolveComponentPath`, which reads `_components` in the transaction, so a subscription re-runs when the tree
  changes). Convex's checks and texts apply, including "Could not find function for '…' in 'counter'".
- **Function logs and the log stream** carry `componentPath`. App metrics already take one (`app-metrics-routes.ts:85`).
- **The query cache key** gets the component path.
- **The dashboard's system functions** take `componentId`: `modules:list`, `listForAllComponents`, `argsValidator`,
  `components:list` and the data functions. This is the dashboard's own step 9 with sandbox-86; step 4 does only
  what the runner and the CLI need (`components:list`, `modules:list`, `modules:argsValidator`).

### 3.4 Not in step 4

- **A component's `ctx.scheduler` and `ctx.storage`** are step 7. Until then they are refused with an error
  naming the step (P-2).
- **Function handles** are step 5.
- **`componentArg`** is legacy (`args: null`, STUDY-153 C-13): not built.

## 4. Proposed PRs

1. **core: a component's schema on writes, and its refusals.**
   - The `Tx` checks a namespace's documents against `Engine.componentSchema(ns)`.
   - A write into an unmounted component is refused (the `Tx` is told which namespaces are unmounted).
   - `.paginate()` called from a component's function is refused.
   - Tests: Convex's messages; the app's checks unchanged; sabotage; a write-path measurement.
2. **server: load and run a component's functions.**
   - `loadLatestCode(engine, store, namespace)`; the per-component registry in `Functions`, loaded at start and
     after `finish_push`; `process.env` per component.
   - `/api/function` and the websocket with a component path; `run_test_function` with `componentId`.
   - Log events with `componentPath`; the cache key.
   - Tests: a pushed component's query, mutation and action run by path; each of §1.1's refusals; the env (a
     value, a deployment variable through `envVar`, the prefixed site URL, an undeclared one `undefined`); two
     instances' globals separate; a restart.
   - Measurements: memory per loaded instance against DV-164's numbers, and the load time.
3. **server: the system functions the runner and CLI need.**
   - `_system/frontend/components:list`;
   - `modules:list {componentId}` and `modules:argsValidator {componentId, function}` answering for that
     component.

### As built, PR 1 (`core/src/tx.ts`, `core/src/engine.ts`)

- **Its schema.**
  - A write in a component's namespace is checked against the component's active schema. `Engine` keeps each
    component's document validators beside its schema and hands them to every mutation's `Tx`
    (`componentValidators`).
  - The message is the root's, and the ids in a document are named in the component's catalog.
  - The pending schema's walk and staged validators stay root-only, as PR 2b of STUDY-153 leaves them.
- **Unmounted.** A user's write (`insert`, `patch`, `replace`, `delete`) into an unmounted component is refused
  with Convex's text in bunvex's words. The `_components` row is read once per transaction. The server's own
  writes there (a push unmounting it) are not refused. Only a component's write awaits that check: an app's write
  keeps its synchronous errors at the app's call (the error-frame tests caught the first version).
- **`.paginate()`.** It is refused after the page's own checks (size, limits, cursors) when
  `Tx.componentFunction` is set, which the server sets while a component's function runs. The engine's own reads
  in a namespace (a schema's walk) still page. Superseded by STUDY-186 A8 (#899): a component's queries page, and
  `Tx.componentFunction` is gone.
- **Tests** (`core/test/component-writes.test.ts`):
  - its documents against its schema, and the app's against the app's;
  - its ids named in its namespace;
  - the unmounted refusals, reads kept, the server's writes allowed;
  - `.paginate()` refused after the page-size check, and the app's and the engine's pages fine.
- **Sabotage:** 8 of 8 caught.
- **Measured:** 4,000 inserts in the app (40 mutations of 100), median of 7, four alternated runs: 125.2–130.9 ms
  with this PR, 125.3–131.2 ms before it.

### As built, PR 2 (`server/src/functions.ts`, `code-store.ts`, `server.ts`, `sync.ts`, `function-log.ts`)

- **Loading.**
  - `loadComponentCode` loads a component's latest package from its namespace with its own `_udf_config`'s seed
    and time and no deployment variable, in contexts of its own (C3).
  - `installComponents` (server) loads every active instance at a start and after every push, and removes an
    unmounted or deleted one.
  - It reloads every instance after each push, not only the changed ones: about 8 ms per instance (below).
- **Running.**
  - `Functions` keeps a component's functions under `componentFunctionName(id, name)`, apart from the app's (which
    `install` replaces whole), with each `FunctionDef`'s component in a `WeakMap`.
  - `invoke` runs a component's query or mutation in `db.inComponent(id)` with `Tx.componentFunction` set.
  - Its `process.env` is `componentEnv`: its bindings, then the built-ins, `BUNVEX_SITE_URL` with its HTTP prefix.
  - Its nested `ctx.runQuery` / `runMutation`, and an action's `runQuery` / `runMutation` / `runAction`, resolve a
    name among its own functions (other components are step 5).
  - `ctx.scheduler` and `ctx.storage` (P-2), and an action's `ctx.vectorSearch`, are refused: "`ctx.scheduler` in a
    component is not supported yet". A component has no vector index (STUDY-153 PR 2b), so its search would read the
    app's tables.
  - The query cache keys a component's function by its registry name, with its own module hashes.
- **Entries.**
  - `/api/function {componentPath}`: an admin only. An admin acting as a user gets Convex's text as a 400. An
    invalid segment is `InvalidComponentPath`, an unknown path `ComponentPathNotFound` (DV-530), and a missing
    function "Could not find function for 'lib:nope' in 'counter'. Did you forget to run `bunvex dev`?".
  - The websocket's `Query` / `Mutation` / `Action` with `componentPath` (admin): a query resolves the path in its
    own transaction, so it re-runs when the tree changes.
  - `run_test_function {componentId}` is left for PR 3.
- **Logs.** Function logs and the log stream carry `componentPath` beside `identifier` (the function's own name).
- **Tests** (`server/test/component-runtime.test.ts`, over HTTP and the websocket):
  - a query, a mutation and an action in each instance's own namespace;
  - nested calls and an action's calls within the component;
  - an internal function by an admin;
  - the refusals (not an admin, an unknown path, a missing function);
  - the env (a value, a deployment variable through `envVar`, an unbound one absent);
  - its schema on writes, `.paginate()`, the scheduler;
  - each instance's module state its own;
  - an unmounted instance's functions not found;
  - a restart;
  - a websocket subscription re-run by a mutation;
  - the log's `componentPath`.
  - One existing test changed for DV-530: `/api/function` with an unknown component path is now a 400.
- **Sabotage:** 12 of 12 caught.
- **Measured (P-3):** a component of 10 modules with 10 functions each, mounted N more times, heap after a full GC:
  +0.68 MB per instance for N = 10 and +0.65 MB for N = 40, below the 2 MB budget. The `finish_push` that loads 11
  instances takes 66 ms, and 41 instances 350 ms.

### As built, PR 3 (`server/src/frontend-system-functions.ts`, `server/src/server.ts`)

- **`modules:listForAllComponents`** lists the app's modules, then each other component's, by its `_components` id,
  in the table's order. An unmounted component's list is empty: its `_modules` were cleared.
- **`modules:list` and `modules:argsValidator`** with a `componentId` read that component's namespace, as Convex's
  `queryWithComponent` re-runs the system function there. `components:list` already gave every path.
- **`/api/run_test_function {componentId}`**:
  - the test query is analyzed with the component's own `_udf_config` and no deployment variable at import;
  - it runs in the component's namespace, with its env;
  - an id with no component is Convex's system error (500).
- **Not in this PR:** the data screens' system functions (`componentId` in `data-system-*`) are step 9's, with
  sandbox-86.
- **Tests** (`server/test/component-runtime.test.ts`):
  - every component's modules, one component's, a function's validator in its component (none in the app), the
    paths;
  - the custom query in each component with its data, an unknown id;
  - no deployment variable at its import in a component.
- **Sabotage:** 6 of 6 caught.

## 5. Questions for the owner

| # | Where bunvex would differ | Convex | Recommendation | Decision |
|---|---|---|---|---|
| P-1 | **An unknown component path at `/api/function`** (and an acting user calling a component there) | 500 InternalServerError, while the websocket answers 400 `ComponentPathNotFound` | 400 `ComponentPathNotFound`, "Component path '…' not found", as the websocket does: a typo in `bunvex run --component` is the user's, and bunvex's 500s page as internal errors (DV-496's reasoning); the acting user, Convex's text as a 400 | **Decided (owner, 2026-10-16): 400 in both** (DV-530) |
| P-2 | **A component's `ctx.scheduler` and `ctx.storage` before step 7** | supported | Refuse with an error naming what is missing ("…in a component are not supported yet") until step 7 builds them. An interim gap, recorded as a step-7 row, not a lasting divergence | **Decided: refused until step 7** (no DV) |
| P-3 | **Memory**: one set of `vm` contexts per component instance (C3) | a fresh context per call | As decided (C3). PR 2 measures it; if one instance costs more than an agreed budget (for example 2 MB), propose sharing contexts per definition | **Decided: measure in PR 2, then decide** |

## Divergences

| # | Divergence | Decision |
|---|---|---|
| DV-530 | An unknown component path (or an acting user calling a component) at `/api/function` is a 400 `ComponentPathNotFound`, not Convex's 500 (P-1) | owner, 2026-10-16 |
