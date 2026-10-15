# STUDY-152 — Components, studied again before building them

- **Status:** study; decisions C1–C7 open (owner). Extends [STUDY-62](STUDY-62-components.md), which it corrects
  in §7; STUDY-62's plan (§7.5) stays the base, revised in §8.
- **Convex source read:** `d8bdde0` of get-convex/convex-backend (the reference commit,
  [upstream.md](../parity/upstream.md)), with `origin/main` checked where noted; the published `@convex-dev/*`
  packages (npm, 2026-10-14); Convex's js-integration-tests at snapshot `c358201e1` (read only, STUDY-122 D1).
- **Related:** STUDY-62 (K1–K9), [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md) (nested calls),
  [STUDY-35](STUDY-35-push-and-deploy.md) P1 (DV-164, one `vm` context per code version), STUDY-122 (the
  js-integration-tests), DV-55, DV-174, DV-215, DV-224, DV-312, DV-385, DV-391, DV-420, DV-429.

The owner asked, before any code: how components work, how fast they are (users report that they are slower than
plain Convex code), what else is not obvious, how their data is kept apart and stored, how the dashboard shows it,
how export and import carry it, and whether Convex's own published components can run on bunvex before bunvex
writes its own. Each section answers one of these.

## 1. Where a component's data lives

- **One set of physical tables.** A component's documents and index entries sit in the same persistence tables as
  the app's (`documents (id, ts, table_id, json_value, deleted, prev_ts)`, `indexes` keyed by index id;
  `crates/postgres/src/sql.rs:59-130`). Nothing in a row names a component: only the tablet id, and `_tables`
  maps each tablet to a namespace.
- **Namespaces.** `TableNamespace` is `Global` or `ByComponent(id)`; the root is `Global`, so the app's tables
  share the namespace of `_tables` and `_index` (`value/src/table_mapping.rs:17-34`,
  `common/src/components/mod.rs:71-87`). `_tables.namespace` is omitted for the root and
  `{kind: "byComponent", id}` for a component (STUDY-62 §7.4).
- **Table numbers per namespace.** User tables start at 10001 in every namespace; a new number comes from the
  `_tables` rows of that namespace (`database/src/bootstrap_model/table.rs:316-332`). `MAX_USER_TABLES` (10000)
  counts **all** namespaces together (`table.rs:62,535`).
- **Indexes** — database, text and vector — belong to a tablet, so to its namespace; a search inside a component
  resolves the table in that namespace. No per-component index limit.
- **Per-namespace system tables:** `_file_storage`, `_scheduled_jobs` (+ args), the three cron tables, `_modules`,
  `_udf_config`, `_source_packages`, `_schemas` and the schema validation tables (STUDY-62 §7.4). bunvex's tablets
  are already global, which is what this layout needs.
- **IDs.** An ID encodes table number and internal id, not the namespace: the same string means a different
  table in another namespace. A component's `v.id("x")` resolves the number in the callee's namespace only
  (`common/src/schemas/validator.rs:117-137`), so an app's ID can pass it when the numbers coincide, and any
  `_storage` ID does (inferred from the validator; to confirm on the binary).

## 2. What a call into a component costs (the performance question)

A component is reached only through `ctx.runQuery` / `runMutation` / `runAction` (or a handle); there is no
plain function call across the boundary. In Convex such a call (`1.0/runUdf`,
`isolate/src/environment/udf/async_syscall.rs:504-695, 1686-1775`):

1. **moves the caller's transaction into the callee** inside `begin_subtransaction`
   (`database/src/transaction.rs:417-455`): a failed mutation's writes are rolled back; reads always join the
   caller's read set, so a query calling a component re-runs when the component's data changes;
2. **creates a new V8 context and evaluates the callee's module graph from the top** (`udf/mod.rs:777-821`,
   `context_cache.rs:99-113`), helped only by the module and code caches;
3. by default **runs it as a separate request on another isolate**, through the scheduler's internal queue
   (`SUBFUNCTIONS_IN_SAME_ISOLATE = false`, `common/src/knobs.rs:1324-1327`, still false on `origin/main`);
4. reads 5–8 system rows (`_components`, `_udf_config`, `_modules`, env bindings, canonical URLs;
   `phase.rs:164-239`, `validation.rs:584-596`);
5. encodes and decodes arguments and result about four times (`convexToJson`, `JSON.stringify`, serde,
   `serde_v8`) and validates both against the **callee's** tables;
6. is not batched: `Promise.all` over component calls runs them one at a time (inferred from the syscall loop,
   `async_syscall.rs:262-274`).

None of it is specific to components: a root `ctx.runQuery` pays the same. Components make it unavoidable. Convex
says so (`registration.ts:150-154`: "overhead of … validation, and creating a new isolated JS context"), and the
cost grows with the component's bundle, since step 2 re-runs its imports.

- **The nested query never uses the query cache**; called from an **action**, a component query is its own
  transaction and is cached (`application_function_runner/mod.rs:2009-2020, 2132-2186`).
- **Limits** (reads, writes, sizes) are the caller's, shared. Depth limit 8. `transactionLimits` (lower only)
  and `useStaleSnapshot` are options of `runQuery` / `runMutation` (`registration.ts:1236`,
  `execution_size.rs:96-170`).
- **Convex's fix** is `export const experimental_reuseContext = true` on a module (commits `944367928` …
  `3c25419f3`, June–July 2026, undocumented): a cached context reused while its import-time reads stay valid. No
  `@convex-dev` component uses it yet.
- **What users measured** (anecdotal, better-auth PR #445, local backend, 2026-10): an empty query 2.0 ms p50, a
  lean component query 4.7 ms, Better Auth's session lookup through its generic adapter 36 ms (blamed on the
  adapter's large import graph). Other reports: "> 50 ms, growing with app size" (udecode/better-auth-convex),
  > 100 ms on an empty database (better-auth #284), a 1.3 MB bundle (r2 #84).
- **Contention** is built into some components: aggregate's README warns of conflicts between `count` reads and
  inserts in range, and of `_creationTime` keys serialising inserts; workpool and workflow had OCC storms and
  background loops billed silently (workpool #225: ~27 mutations/s for 10 h; #166 on self-hosted). Convex added
  primitives for them: `useStaleSnapshot` (1.42, "for Workpool"), `ctx.db.vars.commitTs` / `v.commitTs()` (1.43),
  `transactionLimits` (1.41). Current workpool, aggregate and better-auth need them.
- **Billing:** a component call from a query or mutation is not a function call on Convex's limits page; from an
  action each `runQuery` / `runMutation` is one (no staff statement found).

**bunvex today** runs every function of a code version in one `vm` context whose modules are evaluated once
(DV-164); a nested `runQuery` evaluates nothing and stays on the same thread. So steps 2, 3 and 6 cost nothing in
bunvex, and step 5 is a JSON round trip (STUDY-41). Components built the same way keep that: a component call
would cost what a root `runQuery` costs today, plus the validation against the callee's tables. That is the
largest gap in bunvex's favour, and it raises C2 (module state).

## 3. Other things that are not obvious

- **`ctx.auth` in a component.** The docs say it is not available; the code gives a component's query or mutation
  the **caller's** identity, and only samples a metric (`async_syscall.rs:972-996`). Actions and HTTP actions
  reaching a component get an unknown identity unless the caller is an admin
  (`model/src/components/auth.rs:6-19`). A scheduled job runs with no identity, in any component
  (`scheduled_jobs/mod.rs:264-267`). K5 (as Convex today) means as the **code**, not the docs.
- **Refused in a component:** `.paginate()` (`async_syscall.rs:1998-2004`, still on `origin/main`); `"use node"`
  (de-prioritised by Convex staff, backend #335). Components page with convex-helpers' `paginator` instead.
- **Node actions of the app** can call a component's queries, mutations and actions, schedule them and create
  handles to them (js-integration-tests `componentFunctionsInNodeActions`).
- **`ConvexError` crosses intact**, class and `data`; the message gains the callee's frames
  (`helpers/promise.rs:74-88`, `syscall.ts:38-52`).
- **Storage.** The upload token names the component the file goes to (`keybroker/src/broker.rs:1361-1378`); a
  component's `getUrl` adds `?component=<id>` (`file_storage/src/core.rs:164-166`) and the download route reads it.
- **Scheduler and crons**: one worker across every namespace, ordered by time, one global concurrency limit
  (`scheduled_jobs/mod.rs:449-512`, `cron_jobs/mod.rs:433-467`). A job scheduled by a parent into a child is
  stored in the parent's `_scheduled_functions`; `db.system.get` of another namespace's job ID is `null`.
  Scheduling a query handle is accepted, and the job fails later (`UnsupportedScheduledFunctionType`).
- **Env.** A component sees only its declared variables (`defineComponent(name, {env})`, string validators,
  `v.optional`), bound by `app.use(c, {env})` to values or the parent's variables, plus a `CONVEX_SITE_URL`
  carrying its HTTP prefix. batch-worker uses this, so workpool, rate-limiter, aggregate and presence do too.
- **Unmounting** (removing `app.use`) keeps data and schema, read-only, shown "(unmounted)"; only
  `/api/delete_component` (the dashboard) removes it, subtree included.
- **Bundling.** A component file may import from outside its own directory (the test app's search component
  imports `../foodData`). Entry points follow Convex's multi-dot rule exactly: aggregate ships
  `arbitrary.helpers.js`, which imports vitest and is skipped only because of it.
- **Tooling pain on Convex** (issues, for what bunvex's CLI should avoid): re-exported component configs made
  push 500 and the dashboard run out of memory (backend #467); "found wrong number of app bundles" (convex-js
  #125); a CLI stuck at "Finding component definitions" (#79).

## 4. The dashboard

- The picker lists components with `_system/frontend/components:list` (`ViewData`), puts an "App" entry on top,
  and keeps the choice in the URL (`?component=<_components id>`). It includes unmounted components
  (`useNents.ts:23-82`, `frontend/components.ts:4-40`).
- It appears on Data, Schema, Files, Functions (and the runner), Schedules and Logs. Logs filter on the client by
  `componentPath`. Settings → Components deletes unmounted components.
- **Rerouting.** A system query or mutation given a non-null `componentId` calls itself again with
  `currentSystemUdfInComponent(componentId)` and `componentId: null` (`secretSystemTables.ts:106-175`,
  `system-udfs/convex/_system/server.ts:165-187`). The backend allows that only from a root system function and
  runs the same path inside the child (`model/src/components/mod.rs:140-168`). The same system functions then
  serve every namespace.
- HTTP routes taking a component id: `shapes2?component=`, `delete_tables`, `get_indexes?component_id=`,
  `run_test_function`, `cancel_job`, `cancel_all_jobs` (also a path filter), `GET /api/storage/{id}?component=`.
  The CLI's `data --component` and `run --component` send a **path** over sync instead.
- **bunvex today:** system functions accept a `componentId` and ignore it, acting on the root (DV-55), while the
  HTTP routes refuse one (DV-391); the dashboard (STUDY-149) always sends `null`. The routing is sandbox-86's area
  (coordinate before changing it).

## 5. Export and import

- **ZIP.** Each path segment adds `_components/<name>/`: `a/b` is `_components/a/_components/b/`
  (`crates/exports/src/lib.rs:476-487`). Under each prefix, as at the root: `_tables/documents.jsonl` (that
  namespace's tables), `<table>/documents.jsonl`, `<table>/generated_schema.jsonl`, `_storage/documents.jsonl`
  and the files. One `README.md`. Unmounted components are exported (inferred: no state filter,
  `component_registry.rs:151-174`). The request's `component` argument is stored and never used: an export always
  holds every component.
- **Import.** `_components/<name>/` prefixes are peeled from the right and appended to `--component`'s path
  (`snapshot_import/parse.rs:105-113, 324-401`); a single file goes into that component. Missing components and
  parents are created **unmounted** with a synthetic definition (`prepare_component.rs:39-133`). Table numbers are
  kept per namespace; IDs are not remapped; `_storage` goes to that namespace's `_file_storage`
  (`mod.rs:787, 871-881, 1165-1300, 1392-1411`). `--replace-all` appears to clear user tables in **every**
  namespace, not only `--component`'s (`mod.rs:1075-1100`; to confirm on the binary before matching).
- **Streaming export.** Every value carries `_component` (`""` for the root); selections by table, component or
  an exact map; `json_schemas?byComponent=true`; Fivetran maps components to schemas (the root to `app`).
- **bunvex today:** the same ZIP layout for the root only; `_components/` paths and `componentPath` answer
  `ComponentsNotSupported` (DV-215); streaming export always `""` (a non-root selection returns nothing instead of
  failing — to fix with the step).

## 6. Running Convex's published components

### 6.1 The packages

- **Most used** (npm, week to 2026-10-12): workpool 623k, batch-worker 616k, rate-limiter 609k, migrations 483k,
  workflow 352k, aggregate 305k, better-auth 293k, action-retrier 213k, agent 196k, resend 192k; crons, r2,
  stripe, presence, rag ~100–125k.
- **They nest.** batch-worker is a child of rate-limiter, aggregate, workpool and presence; workpool of workflow,
  rag and resend; so the top five already need nested instances and component env.
- **Shape** (the same template in all): `files: ["dist", "src"]`; `exports` `.` (the client wrapper),
  `./convex.config(.js)` (`dist/component/convex.config.js`), `./_generated/component.js` (types,
  `ComponentApi<Name>`), `./test`. **No current package uses the `"convex"` or `"@convex-dev/component-source"`
  export condition**, so that half of K2 is moot. `peerDependencies.convex` from `^1.24.8` to `^1.46.0`.
- **What they import at runtime:** from `convex/server` — `componentsGeneric`, `defineComponent`, `defineApp`,
  `getFunctionAddress`, `createFunctionHandle`, `getFunctionName`, `makeFunctionReference`, the `*Generic`
  builders, `cronJobs`, `httpRouter`, `paginationOptsValidator`, `paginationResultValidator`, `anyApi`,
  `defineSchema`, `defineTable`; from `convex/values` — `v`, `ConvexError`, `convexToJson`, `jsonToConvex`,
  `getConvexSize`, `getDocumentSize`, `compareValues`, `CommitTsPlaceholder`, `asObjectValidator`; `version` from
  `convex`. Their `/react` entries import `convex/react`. And convex-helpers, which most depend on.
- **Below the API:** migrations calls `globalThis.Convex.asyncSyscall("1.0/getFunctionMetadata")`; workflow reads
  `getFunctionAddress().reference`; better-auth refuses `convex` older than 1.25.0 by version string; several read
  `CONVEX_SITE_URL` / `CONVEX_CLOUD_URL` (bunvex: `BUNVEX_*`, DV-179). The `function://` handle prefix and
  `Symbol.for("functionName")` are the same in bunvex.
- **What bunvex lacks for them:** the components runtime (STUDY-62 §7.5 steps 1–7, with env, nesting and HTTP
  mounts); `componentsGeneric`, `defineComponent`, `defineApp`, `getFunctionAddress`; 23 type names
  (`ComponentDefinition`, `SchemaDefinition`, `PaginationOptions`, `UserIdentity`, `GenericSchema`, …);
  `FunctionReference` with Convex's five type parameters (every generated `ComponentApi` passes five);
  `asObjectValidator` public; and the Convex names themselves (`ConvexError`, `convexToJson`, … — bunvex's are
  `BunvexError`, `toJsonValue`, …, DV-312).

### 6.2 How Convex's CLI takes them in

An esbuild plugin finds `convex.config.*`; the metafile gives the graph; child definition imports become
`./_componentDeps/<base64url(path)>`; each component is re-bundled from its compiled `dist/component` JS with the
`convex` package bundled in (`cli/lib/components/definition/bundle.ts`, `bundler/external.ts:184`). `Bun.build`
(Bun 1.4.2, CI's) returns an esbuild-shaped metafile with `metafile: true` (checked), so bunvex needs no plugin for
the graph (corrects STUDY-62 K3).

### 6.3 Ways to run them unchanged

In every way the word "convex" has to exist somewhere — module names (`convex/server`) and exported names
(`ConvexError`) are the packages' API. The ways differ in where it lives and who ships it.

| | How | For | Against |
|---|---|---|---|
| **A. Alias in bunvex's CLI and linker** (K2 as written) | The bundler maps `convex/*` to `bunvex/*`; the server's linker serves a namespace with the Convex names | Nothing for the user to set up on the backend | A rule-5 exception inside `packages/cli` and `packages/server`; does not reach the app's front-end bundler (the `/react` entries) nor TypeScript |
| **B. A compatibility package the user installs as `convex`** (`"convex": "npm:<name>@1.46.x"`) | A thin package re-exporting bunvex's API under Convex's names, versioned 1.x to meet the peer ranges | The only way that covers the backend, the front end and the types at once; outside bunvex's shipped packages; the user opts in | Its source holds the Convex names; must claim a 1.x Convex-like version (peer ranges, better-auth's check); naming / trademark question for its npm name; follows Convex's API every week; the app cannot also have the real `convex` |
| **C. Rewrite on install** (`bunvex components add`) | Rewrites specifiers and names in the package's `dist` and `.d.ts`, vendored | Can also fix env names and syscalls | The rename table ships in the CLI; transitive (convex-helpers, batch-worker, workpool); redone at every install; front end too |
| **D. Forks under `@bunvex/*`** | Republished ports | Clean under rule 5; the path to the owner's goal (b) | 24+ packages releasing often; apps change imports; third-party components stay out; needs a ruling, as they are Convex's Apache-2.0 code |

Whatever the choice, the components runtime comes first, proven with a component written for `bunvex/*`
(sharded-counter is the smallest: queries and mutations only), then rate-limiter (nesting, env), then workpool
(scheduler, `useStaleSnapshot`, `commitTs`).

## 7. Corrections to STUDY-62

- **K4 / §1.2** say "one isolate per component call". Convex creates a new **context** per call, by default as
  another isolate request, for **every** nested call, not only component ones (§2).
- **K3:** no `onResolve` plugin needed; `Bun.build`'s metafile gives the graph (§6.2).
- **K2:** the export-condition half is moot (§6.1); the module names remain, and §6.3 replaces §7.3.
- **K5:** follow the code (the caller's identity in queries and mutations), not the docs (§3).
- **§6 "Not verified yet"** is answered: `ConvexError` crosses intact; a scheduled job has no identity; uploads
  trust the token's component; `Bun.build` gives the graph.
- **To add:** `transactionLimits` and `useStaleSnapshot` on nested calls, `commitTs`; the global 10000-table
  limit; the `v.id` pass across namespaces; storage URLs' `?component=`; Node actions calling components;
  imports from outside a component's directory.

## 8. The plan, revised

STUDY-62 §7.5's order stands, with the js-integration-tests as acceptance oracles (none is copied into the repo;
each step writes its own tests and checks against these):

| Step | What | Oracle (js-integration-tests, snapshot `c358201e1`) |
|---|---|---|
| 1 | Namespaced catalog; a Convex store with components opens (supersedes DV-420) | B6–B8's `null` for another namespace's job ID |
| 2 | The registry (rows, path ↔ id, reservation, unmount, delete) | — |
| 3 | Server push of definitions; `defineApp` / `defineComponent` / `componentsGeneric` | every test (all push a `convex.config.ts`) |
| 4 | Running a function inside a component; admin `componentPath` | A13–A15, B4/B5, frame paths in B1–B3 |
| 5 | Calls across components (references, handles, identity, subtransaction) | A1–A3, A5–A12, A13–A17, B1–B3, and every test's cleanup |
| 6 | CLI push and codegen (DV-174, DV-385) | every test |
| 7 | Scheduler, crons, storage, HTTP mounts, env per component | B4–B8, A4, A16, A17 |
| 8 | Convex's packages (C1) | sharded-counter, rate-limiter, workpool end to end |
| 9 | Dashboard and CLI flags (DV-224, DV-391), with sandbox-86 | — |
| 10 | Export, import, streaming export (DV-215) | — |

Not covered by those tests, and needing oracles from the binary: env, `httpPrefix`, nesting beyond one level,
identity, the depth limit, the pagination and Node refusals, unmount and delete, crons in a component. Steps 1–3
change no behaviour an app sees on its own and can start before C1 is decided.

## 9. Decisions for the owner

| # | Question | Convex | Recommendation |
|---|---|---|---|
| C1 | How Convex's published components run on bunvex (§6.3) | native | **B, a compatibility package the user installs as `convex`**, kept out of bunvex's shipped packages: the only way that reaches the front end and the types too. Built after steps 1–7 |
| C2 | Module state across calls: Convex evaluates a component's modules afresh on every call (unless `experimental_reuseContext`); bunvex evaluates once per code version (DV-164) | fresh per call | **Keep bunvex's (evaluate once)**, extended to components: the performance gap in §2 is mostly this. Observable only by code keeping state in module variables between calls. Recorded as an extension of DV-164 |
| C3 | Isolation of a component's globals (K4: one module graph per component in the version's single context) | a separate context per call | **One `vm` context per component per code version**, revising K4: its own `globalThis`, env and realm, values crossing as JSON as today; measure memory against DV-164 |
| C4 | `v.id` of a component accepting another namespace's ID when the numbers match (§1) | accepts (inferred) | As Convex, once confirmed on the binary |
| C5 | `import --replace-all --component` clearing every namespace (§5) | appears so | As Convex, once confirmed on the binary |
| C6 | Order: the runtime first with a component written for bunvex, Convex's packages after (§6.3, §8) | — | Yes |
| C7 | Native bunvex versions of the main components (goal b): which first | — | After C1 works: workpool, rate-limiter, aggregate, migrations (the most used), written from scratch for `bunvex/*` |

## 10. Sources

- Convex source at `d8bdde0` (files cited above); `origin/main` for `paginate`, `SUBFUNCTIONS_IN_SAME_ISOLATE`.
- docs.convex.dev/components/using, /components/authoring, /understanding/best-practices,
  /production/state/limits; news.convex.dev/components-authoring (authoring GA, 2025-12-01).
- Issues: get-convex/convex-backend #40, #335, #432, #467, #496; better-auth #284, #445; workpool #166, #225;
  r2 #84; convex-js #79, #125, #147; udecode/better-auth-convex.
- npm tarballs of 25 `@convex-dev/*` packages and convex-helpers (2026-10-14).
