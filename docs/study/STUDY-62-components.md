# STUDY-62 — Components

- **Status:** draft; decisions pending (owner): K1–K9. No code yet: this study and its plan are the first
  PR.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031, npm `convex` 1.46.0), 2026-10-03
- **Related:** [STUDY-04](STUDY-04-table-and-index-metadata.md) D4 (DV-55: no namespaces),
  [STUDY-36](STUDY-36-codegen.md) G2 (DV-174), [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md)
  (nested calls, the depth limit), [STUDY-43](STUDY-43-data-command.md) D1 (DV-224),
  [STUDY-50](STUDY-50-function-handles.md) (handles), STUDY-42 X1 (DV-215), STUDY-48 A2 (DV-276).
  The divergences waiting on components: DV-55, DV-174, DV-186, DV-215, DV-224, DV-276.

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

## 4. Decisions for the owner

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
