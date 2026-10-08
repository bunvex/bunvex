# STUDY-62 — Components

- **Status:** K1–K9 accepted as recommended (owner, 2026-10-03). Re-checked against Convex `a4ad353` on
  2026-10-08 (§7): K8 and the root component rows are built; §7.4 lists what that check corrects or adds, and
  K2 is to be confirmed again (§7.3). **No step of §5 is started**: the owner wants the pros and cons laid out
  before going on (2026-10-08).
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031, npm `convex` 1.46.0), 2026-10-03;
  re-checked at `a4ad3530c` (2026-10-08).
- **Related:** [STUDY-04](STUDY-04-table-and-index-metadata.md) D4 (DV-55: no namespaces),
  [STUDY-36](STUDY-36-codegen.md) G2 (DV-174), [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md)
  (nested calls, the depth limit), [STUDY-43](STUDY-43-data-command.md) D1 (DV-224),
  [STUDY-50](STUDY-50-function-handles.md) (handles), STUDY-42 X1 (DV-215),
  [STUDY-133](STUDY-133-persistence-layout-identical.md) Q10 (DV-420), STUDY-134 S9 (DV-429), STUDY-116 F2
  (DV-385). The divergences waiting on components: DV-55, DV-174, DV-186, DV-215, DV-224, DV-385, DV-391,
  DV-420, DV-429 (DV-276 is resolved).

## 1. How Convex does it

### 1.1 The developer's API (`npm/convex/server/components`)

- **`defineComponent(name, {env?})`** declares a component.
  - Its env vars are string validators: `v.string()`, a string literal, or a union of those. The server
    checks again (`InvalidEnvVarDeclaration`).
  - Component **args are gone** from the JS API. `args` is always `[]`; typed env vars replace them.
  - **Explicit exports are gone**: a component's exports are its public functions.
- **`defineApp({httpPrefix?, env?})`** declares the app.
- **`app.use(definition, {name?, httpPrefix?, env?})`** mounts a child.
  - The name defaults to the definition's name.
  - `httpPrefix` mounts the child's `http.ts` routes.
  - `env` binds the child's vars to values or to the parent's vars (`app.env.X`).
- **References and handles**:
  - `components.<name>.<module>.<fn>` is a reference (`_reference/childComponent/…`), called with
    `ctx.runQuery` / `runMutation` / `runAction`.
  - `createFunctionHandle` works for component functions too.
- **Packages**: a component ships as an npm package (`@convex-dev/ratelimiter` and others) with
  `convex.config.js`, its `_generated/component.ts` types, and a client wrapper.
  - Apps import `pkg/convex.config` and `app.use` it.
  - The packages import `convex/server` and `convex/values`, and resolve with the `"convex"` export
    condition.
- **Codegen**:
  - `_generated/api.ts` exports typed `components`.
  - `_generated/component.ts` exports `ComponentApi`.
  - IDs crossing a boundary are typed `string`.
  - `_generated/server.ts` exports a typed `env`.

### 1.2 What a component is

- **Its own namespace.** A component has its own tables and schema and cannot read its parent's.
  - It has its own `_file_storage`, `_scheduled_jobs`, `_cron_jobs` / logs / next run, `_modules`,
    `_udf_config`, `_source_packages` and `_schemas`.
  - These sit at the **same numbers** in each namespace.
  - User tables start at 10001 **in each namespace**.
- **IDs.** A document ID string encodes table number and internal id but **not the namespace**, so IDs
  are opaque across components. Tablets are global and unique.
- **Registry.** `_components` (544, `by_parent_and_name`) and `_component_definitions` (543) are global.
  A component's id is its `_components` document id. The root is the global namespace. `ComponentPath`
  is names joined by `/`, with `""` for the root.
- **What it can call**: its own functions, its children's **public** functions, and anything through a
  handle. A client cannot call a component's functions; only the app's own functions and admins can.
  - The sync protocol's `componentPath` is admin-only ("Only admin or system users can call functions on
    non-root components directly").
  - So is `/api/function`'s.
- **Calls.**
  - A query or mutation calling a component runs in the **same transaction**, as a subtransaction. A
    caught failure discards only the component's writes.
  - The depth limit is 8 ("Cross component call depth limit exceeded…").
  - Arguments and return values are checked against the **callee's** tables.
- **Identity.** Actions and HTTP actions pass only admin identities into a component; users become
  unknown. Queries and mutations share the transaction, so the component sees the caller's identity.
  Convex samples logs of this, which suggests it may change.
- **Restrictions**: no `paginate()` in components (`PaginationUnsupportedInComponents`), no `"use node"`
  (`NodeActionsNotSupported`), and only the root's Node dependencies.
- **Per component**: crons, scheduled jobs (in the scheduler's namespace, the target's path stored), file
  storage, env (declared vars only, plus a `CONVEX_SITE_URL` with the mount prefix), and HTTP routes
  mounted by prefix (longest prefix wins; overlaps are refused).

### 1.3 Push (`deploy_config.rs`, `model/src/components/*`)

- **The CLI**:
  1. Discovers `convex.config.*` imports (esbuild metafile).
  2. Rewrites child definition imports to `./_componentDeps/<base64url(path)>`.
  3. Bundles each definition, its schema and its functions. Node bundles are root-only.
  4. Sends `appDefinition` and `componentDefinitions` to `start_push`.
- **`start_push`**:
  1. Evaluates every `convex.config.js` in post-order. A cycle is `CyclicImport`; an error is
     `InvalidConvexConfig`.
  2. Typechecks and instantiates the tree: env bindings, HTTP mounts.
  3. Allocates each new component's namespace (its id and system tables).
  4. Submits per-namespace schema and index changes.
- **`finish_push`**, in one transaction:
  - `_component_definitions` per definition path.
  - The tree diff: create, modify, remount, unmount.
  - Unmounting removes modules, crons and handles, and keeps data and schema read-only.
  - Audit `push_config_with_components`.
- **`/api/delete_component`** deletes an unmounted subtree's rows, schemas and tables, and audits
  `delete_component`.

### 1.4 Everything else

- **Dashboard**: `_system/frontend/*` take `componentId` and rerun inside that namespace; the components
  list; `/api/shapes2?component=`; `delete_tables` / scheduling / exports with a component.
- **Export and import**: `_components/<name>/…` directories, nested. Import creates missing components
  as unmounted.
- **Streaming export**: `_component` on each value; selections keyed by component path.
- **Logs and audit**: `componentPath` in logs and OCC info; `{component_id, component}` on
  component-scoped audit events.

## 2. What an app can observe

Everything above. Components are a feature apps opt into, and a large part of the ecosystem
(`@convex-dev/*`) depends on them.

## 3. How bunvex does it today

There are no components. These are the touch points:

- **Push**:
  - `push.ts` refuses `componentDefinitions` (`ComponentsNotSupported`) and stubs the component fields
    of its answers.
  - The CLI sends none and codegens `components = {}` (DV-174).
- **Server routes**: `shapes2?component=`, `delete_tables` with a component, and imports with a
  `componentPath` answer `ComponentsNotSupported`. `data --component` is refused (DV-224).
- **Fields set to the root**: handles store `component: null`; logs, OCC info and
  `getFunctionMetadata` have a root `componentPath`; the audit log and exports have a `null` component.
- **The catalog** is one namespace (by name and number). Tablets are already global, which is the base
  namespaces need.
- **Pushed code** is loaded into `node:vm` modules that link only to bunvex's packages. A
  `@convex-dev/*` package imports `convex/*` and would not resolve.
- **A parity bug found on the way:** the sync protocol parses `componentPath` on Add, Mutation and
  Action, and then **ignores it**. A non-root path runs the root function of that name. Convex refuses
  it for non-admins (and ends the session, an untyped error) and routes it for admins. See K8.

## 4. Decisions (owner, 2026-10-03: all as recommended)

| # | Question | Convex | Recommendation |
|---|---|---|---|
| K1 | Table numbers per namespace (10001 in each component), IDs opaque across components? | yes | **Yes, as Convex.** Export/import round-trips and IDs behave as Convex's. The catalog becomes (namespace, name / number) → tablet. |
| K2 | Running unmodified `@convex-dev/*` packages, which import `convex/server` and `convex/values` and use the `"convex"` condition | native | **An explicit rule-5 exception**: bunvex's bundler and linker alias the `convex` module names and condition to bunvex's. The alternatives (a shim installed as `convex`, or forks) cost the ecosystem. Same family as DV-307 and DV-308. |
| K3 | Bundling the definition graph under Bun (`Bun.build` has no esbuild metafile) | esbuild metafile | Use a plugin's `onResolve` to record the edges. Keep Convex's definition paths (`../node_modules/…`) and the `_componentDeps/<b64url>` rewrite. |
| K4 | Module isolation | one isolate per component call | One `vm` module graph per component per code version, in the same context, plus per-component env and globals. Measure memory against DV-164. |
| K5 | Identity inside a component's query or mutation | the caller's (shared transaction); actions pass only admins | **As Convex today**, with a note to follow if Convex tightens it. |
| K6 | Legacy component `args` / `ComponentArgument` | still read, not written by the JS API | **Do not build**: `env` only, as today's API. |
| K7 | Writes into an unmounted component's tables | modules removed, dashboard read-only | As Convex: no functions remain to write, and the dashboard treats it as read-only. |
| K8 | `componentPath` on sync today (silently ignored) | non-admin: refused; admin: routed | **Fix now in a small PR**: refuse a non-root path for non-admins as Convex, and answer admins with the component-not-found error until components exist. |
| K9 | Order: the dashboard's `componentId` plumbing | — | Phase 4, but new `_system/frontend/*` functions keep accepting `componentId` (they already do). |

## 5. Plan (one PR per step; each its own study section, tests and sabotage checks)

1. **Namespaced catalog** (no user-visible change):
   - `TableNamespace` in core; a `namespace` field on `_tables` rows; the catalog keyed by (namespace,
     name) and (namespace, number); IDs resolved in the current namespace.
   - `_components` (544) and `_component_definitions` (543), with the root row.
   - Per-namespace copies of the component system tables at Convex's numbers.
   - PERSIST-01 conformance for the drivers.
2. **Push of component definitions**:
   - CLI: discovery, the `_componentDeps` rewrite, per-component bundles.
   - Server: evaluating the definitions, typecheck and instantiation (env, HTTP mounts), namespace
     allocation, per-namespace schemas and backfills, the tree diff (create / modify / remount /
     unmount).
   - `/api/delete_component`; audits `push_config_with_components` (DV-276) and `delete_component`.
3. **Calls into components**:
   - `components` references, `runQuery` / `runMutation` / `runAction` with references and handles, the
     same-transaction subtransaction (STUDY-41's nested calls), depth 8, the callee's validation.
   - The identity rule (K5); per-component env; the restrictions (pagination, Node).
   - Component scheduler, crons and storage; HTTP mounts.
   - `componentPath` for admins on sync and `/api/function`; `componentPath` in logs, OCC info and
     metadata.
4. **Tooling and ecosystem**:
   - Codegen of `components`, `ComponentApi` and `env`.
   - The dashboard's component picker and `componentId` rerouting; `shapes2?component=`.
   - Export and import `_components/…`; `_component` in streaming export; `data --component`.
   - `@convex-dev/ratelimiter`, `workpool` and `aggregate` end to end (K2).

## 6. Not verified yet

- Whether `ConvexError` data crosses a component boundary intact.
- A scheduled job's identity across components.
- Whether HTTP storage uploads check the token's component.
- Whether `Bun.build` can give the import graph without a plugin.

## 7. Re-checked against Convex `a4ad353` (2026-10-08)

Paths are in get-convex/convex-backend at `a4ad3530c`.

### 7.1 Already built in bunvex

- **K8** (`componentPath` on sync is admin-only): `3b1f38d1`, `packages/server/src/sync.ts`,
  `test/sync-component-path.test.ts`.
- **The root component's rows** (`_component_definitions` 543, `_components` 544 with `by_parent_and_name`):
  STUDY-133 §12 M2, `packages/server/src/code-store.ts` (`ensureRootComponent`), in Convex's `App` shape.
- **Nested calls** (STUDY-41): the depth limit of 8 with Convex's message and savepoint rollback
  (`functions.ts`): the base for calls into components, which resolve only by name today.
- Dashboard system functions already take `componentId` (root only).

### 7.2 What bunvex refuses or hard-codes today

- Push: `componentDefinitions` refused (`ComponentsNotSupported`); the response stub has empty
  `componentDefinitionPackages`, `allocatedComponentIds` and `environmentVariables` (Convex returns the real
  variables for its race check).
- Server routes refuse a component (`ComponentsNotSupported`): shapes, `delete_tables`, scheduling,
  `run_test_function`, import (`_components/…` paths too).
- CLI: `run --component`, `--typecheck-components`, `--live-component-sources`, `data --component`,
  `codegen --component-dir` refused; `components` is `{}` in `_generated/api`.
- Root-only fields: handles (`component: null`), exports, scheduled jobs (`component: ""`), logs and
  `getFunctionMetadata` (`componentPath`), streaming export (keyed by `""`).
- The `vm` linker resolves only `bunvex/server`, `bunvex/values` and the repl wrapper.
- **DV-420 is not built**: nothing refuses at open a store with non-root components (decided 2026-10-05).

### 7.3 K2 to confirm again

K2 (alias the `convex/*` module names and the `"convex"` export condition to bunvex's, so npm components such
as `@convex-dev/ratelimiter`, `workpool` and `aggregate` run unchanged) was justified as "the same family as
DV-307/DV-308". Both were revisited the same day to "no exceptions" (DV-312), and rule 5 (`check:deps`)
still forbids "convex" in shipped strings. K2 is therefore an exception the owner has to confirm explicitly,
narrowly scoped (module names and the export condition in the bundler and the linker), or turn down (bunvex
components only from packages written for `bunvex/*`). Open.

### 7.4 Corrections and additions to §1

- **§1.3, the push:** `componentDefinitionPackages` is in `start_push`'s **response**
  (`application/src/deploy_config.rs:1238-1252`), echoed back to `finish_push`, which downloads each package
  (`:838-843`). The request is `{adminKey, functions, appDefinition, componentDefinitions[], nodeDependencies,
  nodeVersion, dryRun, forCodegen}` (`:1179-1198`); a component's definition has no unchanged-module diff
  (`:1493-1500`) and refuses Node modules (`NodeActionsNotSupported`, `:1511-1520`).
- **`finish_push`** checks the environment variables did not change since `start_push` and that the app's
  **required** variables are set (`:860-905`); a concurrent push that created the same component under
  another id fails with `RaceDetected` and the CLI retries (`model/src/components/config.rs:506-518`, commit
  `6c8ae5aaa`, after 4577b9031).
- **`_tables.namespace`:** omitted for the root, `{kind: "byComponent", id: "<_components id>"}` for a
  component (`common/src/bootstrap_model/tables.rs:75-148`).
- **Per-namespace system tables** (`model/src/lib.rs:613-625`, `components/config.rs:362-418`):
  `_file_storage`, `_scheduled_jobs`, `_scheduled_job_args`, `_cron_jobs`, `_cron_job_logs`,
  `_cron_next_run`, `_modules`, `_udf_config`, `_source_packages`, `_schemas`, `_schema_validation_progress`,
  `_schema_validations`. `_function_handles` (with a `component` field), `_index`, `_tables` and
  `_environment_variables` stay global.
- **`_components` rows:** a child's must hold `args` (`[]`, K6 builds no legacy args) or Convex cannot load
  it (`common/src/bootstrap_model/components/mod.rs` ~137); `env` is a list of
  `[name, {type: "value", value} | {type: "envVar", name}]`, `state` `active` or `unmounted`.
- **`_component_definitions`:** `exports` are stored empty and filled only in `start_push`'s answer for
  codegen (`deploy_config.rs:846-850`, `:224-235`).
- **Namespaces** are reserved in `start_push` (`initialize_component_namespace`) and the row inserted at
  `finish_push` with that id (`config.rs:571`).
- **Environment variables of components:** `v.optional(...)` declarations; a component has its own
  `component.env.X` refs, and bindings resolve through the chain to a value or a root variable
  (`model/src/components/type_checking.rs:195-285`); `CONVEX_SITE_URL` carries the component's prefix
  (`udf/src/environment.rs:92-205`).
- **Identity (§1.2):** anything but root→root becomes unknown unless the caller is an admin; component→root
  included (`model/src/components/auth.rs:6-19`).
- **References:** `_reference/childComponent/<name>/…` resolves only against the child's file-based public
  exports, with `InvalidReference` texts that changed after 4577b9031 (`model/src/components/mod.rs:62-200`).
- **Deleting a component** requires its whole subtree unmounted (`ComponentMustBeUnmounted`,
  `config.rs:731-790`).
- **The dashboard** reroutes a system function into a component through `currentSystemUdfInComponent`
  (`system-udfs/convex/_system/server.ts:175-183`): what K9 builds on.
- Out of scope: component-scoped custom-role statements (`f9b2d83`, cloud RBAC).

### 7.5 A possible PR series (to replace §5 once the owner decides)

1. A namespaced catalog (`_tables.namespace`, catalog by namespace, the per-namespace system tables); a
   Convex store with components loads (supersedes DV-420).
2. The component registry model (rows, path ↔ id, namespace reservation, unmount and delete).
3. The server push of component definitions, with `defineApp` / `defineComponent` in `bunvex/server`
   (closes DV-429).
4. Running a function in a component, and admin `componentPath` routing.
5. Calls across components (references, handles, identity).
6. The CLI push and codegen (closes DV-174, DV-385).
7. Scheduler, crons, storage and HTTP mounts per component.
8. The npm ecosystem (only if K2 is confirmed).
9. The dashboard and CLI flags (DV-224, DV-391).
10. Export and import (DV-215).

Dependencies: 1 → 2 → 3 → 4 → 5; 6 after 3; 7 after 4; 8 after 5 and 6; 9 and 10 after 2 and 4.

### 7.6 Convex commits to take with components

Commits the weekly bump (docs/parity/upstream.md) left out because they need components. When components are built,
each is studied and taken in, or marked out of scope with a reason.

| Commit | Subject | Note |
|---|---|---|
| `f9b2d83` | component-scoped custom-role statements | Cloud RBAC; out of scope unless bunvex gets custom roles |

