# STUDY-35 — Pushing and deploying functions

- **Status:** accepted: P1–P6 as recommended (owner, 2026-10-02)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend.
- **Related:**
  - ARCH-01 §6 open decisions 2 (restart or hot swap) and 3 (sandboxing), and ENGINE-00 C10.
  - [STUDY-29](STUDY-29-index-backfill.md): "the push is the engine's open"; B1/DV-126, no push gate.
  - [STUDY-30](STUDY-30-scheduler-and-crons.md) S1/DV-139 and [STUDY-31](STUDY-31-http-actions.md) H1/DV-143: crons and routes passed at start "until the CLI".
  - [STUDY-27](STUDY-27-auth.md) A1/DV-100: the auth config passed at start, "revisit with the CLI".
  - [STUDY-14](STUDY-14-schemas.md) D1: existing documents are not validated against a new schema.
  - [STUDY-03](STUDY-03-deterministic-execution.md) D2/DV-02: determinism by global patches.
  - [STUDY-34](STUDY-34-admin-keys.md): a push needs the `Deploy` operation.
  - [platform §12–§14](../parity/platform.md#14-deploy--push-flow).

Paths: CLI ones are relative to `npm-packages/convex/src`, backend ones to `crates/`.

## 1. How Convex does it

### 1.1 The CLI bundles the functions directory

**Where the functions are.** The directory is `convex/` by default, or the `functions` key of
`convex.json` (`cli/lib/config.ts:137, 550`).

**Which files are modules** (`bundler/index.ts:400-498`). Every `.js .mjs .cjs .ts .tsx .mts .cts .jsx`
file under the directory is an entry point, except:
- `_generated/`, dotfiles and editor temp files;
- `schema.ts`;
- files whose name has more than one dot (`*.test.ts`, `auth.config.ts`, `convex.config.ts`);
- paths with a space;
- nested component directories;
- TypeScript files that neither import nor export.

A file under `_deps/` is an error. Files starting with `_` are modules.

**`"use node"` files** (:501-584) are bundled apart, for Node. The directive is not allowed in `http`,
`crons`, `schema` or `auth.config`.

**esbuild** (`debugBundle.ts:60-90`) bundles with:
- ESM, `esnext`, `bundle`;
- code splitting into `_deps/[hash]` chunks;
- `minifySyntax` and `minifyIdentifiers`, but not whitespace, and `keepNames`;
- source maps always on;
- `process.env.NODE_ENV = "production"`;
- the platform `browser` for the default runtime (Node builtins fail to resolve) and `node` for `"use node"`.

Each module is `{ path, source, sourceMap, environment: "isolate" | "node" }`. The schema and
`auth.config` are bundled separately. Crons and HTTP routes are ordinary modules (`crons.js`, `http.js`).

**Diff push.** Each module's hash is `sha256(source + sourceMap)`. `POST /api/get_config_hashes` returns
the deployment's hashes, and unchanged modules travel only as hashes. The body is JSON, compressed with
brotli.

### 1.2 The deploy2 protocol

Every step is `POST`, with `Authorization: Convex <adminKey>` and the `Deploy` operation
(`local_backend/deploy_config2.rs:307-480`).

**1. `start_push`** (`application/deploy_config.rs:197`). The request is
`{ adminKey, dryRun, functions, appDefinition: { schema, changedModules, unchangedModuleHashes, udfServerVersion, … }, componentDefinitions, nodeDependencies }`.
The server then:
- **Uploads the code.** One zip per package (`modules/<path>.js`, `.js.map`, `metadata.json`) goes into
  module storage. A `_source_packages` row points at it; the source never sits in a document.
- **Analyzes the modules.** Each module is evaluated in a fresh V8 context, and its exports are read:
  - functions, with their kind, visibility and `args`/`returns` JSON (`exportArgs()`);
  - the HTTP routes of `http.js`;
  - the crons of `crons.js`.

  There is one isolate request per module, with a 4 s user timeout, a 64 MiB heap and at most 4096 modules
  (`isolate/environment/analyze.rs:272-645`). Cron targets are checked (`validate_cron_jobs`).
- **Evaluates `auth.config.js`** with the deployment's environment variables, and **evaluates the schema**
  (`InvalidSchema`).
- **Commits the schema change.** New and changed indexes start backfilling, and the schema is stored as
  `Pending` (`model/components/config.rs:313-332`).

The response carries the analysis, the environment variables it read, and the `schemaChange`. The CLI then
runs codegen from the analysis and typechecks.

**2. `wait_for_schema`.** It long-polls `{ schemaChange, timeoutMs }` and answers one of:

| Answer | Meaning |
|---|---|
| `inProgress { indexesComplete, indexesTotal, schemaValidationComplete }` | still working |
| `failed { error, tableName }` | a document does not match (see below) |
| `raceDetected` | another push replaced the schema |
| `complete` | indexes backfilled and documents validated |

A schema worker validates every existing document. The error is `Document with ID "<id>" in table "<t>"
does not match the schema: …`.

**3. `finish_push`.** The request echoes the `start_push` answer. It is **one transaction**, retried on
OCC up to 8 times; an OCC conflict there becomes `ConcurrentPush`. The transaction:
- refuses if the environment variables changed since `start_push` (`RaceDetected`);
- writes the auth config;
- writes the `_modules` rows, `{ path, sourcePackageId, environment, analyzeResult, sha256 }`;
- applies the crons diff;
- marks the schema active;
- enables backfilled indexes and drops removed ones.

It returns a diff of what changed. `report_push_completed` is telemetry.

**Failure.** Nothing serving changes until `finish_push` commits, so the old code keeps serving. Errors are
prefixed "Hit an error while pushing:":
- `InvalidModules`: "Failed to analyze <path>: Uncaught …", with source-mapped frames;
- `InvalidCron`, `InvalidSchema`, `InvalidAuthConfig`, and the size and count limits.

### 1.3 Running the new code

**Per request.** A request runs in a fresh V8 context of a pooled isolate. The module's code comes from a
content-addressed `ModuleCache` (keyed by path and sha256), so unchanged modules stay cached across pushes.

**Import phase.** Importing a module is deterministic: `Math.random` is seeded and `Date.now` is fixed by
the deployment's `UdfConfig`, and `performance.now()` returns 0. At import time, the database, fetch and
other syscalls fail with `No…DuringImport` errors (`analyze.rs:157-257`).

**Live traffic.** Each run reads its module's `_modules` row in its transaction, so a push re-runs exactly
the subscriptions whose module changed. Running requests finish on the code they started with.

**Node actions** run in a separate Node process, `LocalNodeExecutor` on the local backend.

### 1.4 `convex dev` and `convex deploy`

**`dev`** loops:
1. it bundles, pushes, then runs codegen and typechecks;
2. it watches exactly the files the push read, with 500 ms of quiet before the next push;
3. it retries transient errors with backoff from 500 ms up to 16 s.

Its options are `--once`, `--until-success`, `--run <fn>` and `--start <cmd>`.

**`deploy`** pushes once, after an optional `--cmd`.

**Self-hosted** use takes `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`.

## 2. What an app can observe

1. **The files that are modules and their names.** A file `convex/dir/file.ts` is the module `dir/file`; a
   function in it is `dir/file:name`.
2. **The push's atomicity.**
   - Either everything of a push is live (functions, crons, routes, auth config, schema, indexes) or none
     of it.
   - A failed push leaves the old code serving.
   - Subscriptions on changed modules re-run on the new code.
3. **The errors and states.**
   - analyze errors with the import-time restrictions;
   - schema validation failures naming the document;
   - `raceDetected` and `ConcurrentPush`;
   - the backfill progress.
4. **Determinism at import time.**
5. **What each runtime offers.** The default runtime has web APIs only. `"use node"` files have Node and
   may export only actions.
6. **Module-level state.** It does not survive between requests, because each request has a fresh context.

## 3. How bunvex does it

### 3.1 What exists

**Functions are registered in process.** `new Functions(engine).register("m", {...})` is called before
`createServer`. There is no module discovery, no dynamic import and no replace. Calls look a function up by
name each time, so a swapped registry would be picked up by the next run.

**These are fixed at start:**
- the schema: reconciled once in `init()`, while `planCatalog`/`finishCatalog` are already push-shaped
  diffs (STUDY-29);
- crons (`applyCrons`, a diff, also push-shaped);
- the HTTP router;
- the auth config.

**Determinism** comes from process-wide patches keyed by `AsyncLocalStorage`. Functions share the server's
realm.

**What Bun offers** (measured here):
- `Bun.build` bundles.
- `import()` of a new file loads a new version. But a loaded ES module is never freed: re-importing a
  0.9 MB bundle retained **~6 MB per version** (100 versions: +561 MB).
- `node:vm` with `SourceTextModule`:
  - loads a version in its own context;
  - links its imports to the server's modules (`SyntheticModule`);
  - lets the context get its own deterministic `Date` / `Math.random`.
  - Dropped versions are collected: 100 versions plateaued at +192 MB. A call into the context costs
    ~0.4 µs more than a native one.
  - Values coming out of the context have the other realm's prototypes, so they are copied at the boundary.
- A Worker round trip costs ~13 µs.

### 3.2 The design

#### Code versions in their own context (P1)

A push's modules become a **code version**: one `vm` context per version, in the server's process.

**Loading a version:**
1. Each module is a `SourceTextModule` in that context.
2. Its imports are linked:
   - `bunvex/*` and `@bunvex/*` to the server's own modules, so the builders and validators are the
     server's;
   - the bundle's own chunks to each other;
   - for `"use node"` modules only, Node and Bun builtins;
   - anything else is an error, as an unresolvable import is on Convex.
3. The context gets the runtime's globals, as Convex's isolate offers them:
   - `console`, `URL`, `TextEncoder`/`TextDecoder`, `Blob`, `Request`/`Response`/`Headers`, `crypto`,
     `atob`/`btoa`, `structuredClone`, `AbortController`, streams;
   - `fetch` and timers, in actions only;
   - deterministic `Date`, `Math.random` and `performance.now` installed per context;
   - no `process` / `Bun` / `require` outside `"use node"`.
4. Values cross the boundary as copies: `Tx` already copies what it is given (B9), and results are copied
   once.

**Swapping and freeing.** The server swaps versions atomically. An old version is released when its last
request ends, and its memory is collected.

**What this is not.** It is not a security sandbox (`vm` is not one). Real isolation (Workers, a separate
process) stays open for later (ARCH-01 open decision 3). Open decision 2 is settled: **hot swap**, with no
restart.

#### Bundling

`bunvex deploy` (in `@bunvex/cli`) bundles as Convex does:
- the same entry-point rules;
- `Bun.build` with ESM, splitting into `_deps/` chunks, source maps, `NODE_ENV=production` and `keepNames`;
- `bunvex/*` left external;
- `"use node"` modules bundled for Bun with the rest external to its builtins.

The diff push uses `sha256(source + sourceMap)` and `get_config_hashes`.

#### The protocol: Convex's deploy2 shape

The endpoints are `/api/deploy2/{start_push, wait_for_schema, finish_push, evaluate_push, report_push_completed}`
and `/api/get_config_hashes`, with the `Deploy` operation, the same request and response fields that apply
(no components yet), and Convex's error codes.

- **`start_push`:**
  - stores the package;
  - analyzes each module by loading it in a fresh context, with the import-time restrictions and the
    4 s import timeout (`SourceTextModule.evaluate({ timeout })`);
  - reads the functions (the builders already mark kind, visibility and validators; `args`/`returns` are
    exported as Convex's validator JSON), `http.js`'s router and `crons.js`'s crons, and checks the cron
    targets;
  - evaluates `auth.config` with the environment and the schema;
  - commits the schema change: `planCatalog`, with indexes backfilling and a pending schema.
- **`wait_for_schema`** reports the backfill, and the validation of existing documents by a new worker that
  closes STUDY-14 D1, with Convex's states and messages.
- **`finish_push`** is one commit:
  - `_modules` rows (`path`, `sourcePackageId`, `sha256`, `analyzeResult`), the auth config, the crons diff
    (`applyCrons`), the schema made active and `finishCatalog`;
  - on commit, the server swaps the registry, the router, the auth verifier and the document validators;
  - it re-runs exactly the subscriptions whose module's hash changed, since a query cache entry is keyed by
    its module's hash;
  - environment variables changed meanwhile give `RaceDetected` (once they exist, item 9).

#### Startup and storage

- **Startup.** A deployable server loads the latest committed version from the store: `_modules`, then the
  package blob, through the content-addressed cache.
- **Storage.** The package is one blob, Convex's zip, in the deployment's file-storage backend (P3), recorded in
  `_source_packages`.
- **Limits** are Convex's: 4096 modules, 90 MB zipped / 230 MB unzipped, 4 s import, and the index limits.

**Embedded servers stay (P4).** `createServer({ functions, http, crons, auth })` keeps working for tests
and embedding. A server is either embedded or deployable.

### 3.3 PRs

1. **Code versions** (`@bunvex/server`):
   - loading a set of modules into a `vm` context, with linking, the runtime globals and per-context
     determinism;
   - analysis into Convex's `AnalyzedModule`;
   - the registry, router and verifier swap;
   - re-running subscriptions per changed module;
   - tests, sabotage checks, and a measurement of memory per push and call overhead.
2. **Storage and startup:** the `_modules` and `_source_packages` system tables, the package blob, and
   loading the latest version on start.
3. **The deploy2 endpoints:**
   - a mutable engine schema (re-runnable reconcile, rebuilt validators, a per-push ready);
   - `start_push` / `wait_for_schema` / `finish_push` / `get_config_hashes`;
   - crons, router and auth from the push.
4. **Existing-document validation** on a schema push (closes STUDY-14 D1).
5. **`bunvex deploy`**: the bundler and the protocol client, without codegen or typecheck (item 8). `dev`'s
   watch loop is item 9.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| P1 | Functions run in the server's process, **one `vm` context per code version** (not a fresh V8 context per request): not a security boundary; hot swap with no restart (ARCH-01 decision 2); a real sandbox (Workers, a process) left for later (decision 3) | per-version contexts free superseded code (re-importing leaks ~6 MB per push of a 0.9 MB bundle), give each version its own deterministic globals and control what a module can reach, at ~0.4 µs per call; a Worker would cost ~13 µs per database call and move `Tx` behind messages | **accepted** (owner, 2026-10-02) |
| P2 | Module-level state lives as long as its code version: a counter at module scope keeps counting across requests (Convex: a fresh context per request; its `experimental_reuseContext` keeps it) | evaluating every module per request would cost a full import (milliseconds for a real bundle) on every call; apps cannot rely on module state on Convex either | **accepted** (owner, 2026-10-02) |
| P3 | A pushed package is stored as one gzip-compressed JSON blob (modules, source maps, metadata) in the file-storage backend, not a zip | internal; Bun writes gzip natively; the `_source_packages` / `_modules` rows are Convex's | **accepted** (owner, 2026-10-02); **revisited: match** (owner, 2026-10-08): the package is Convex's zip (`zipInMemory`, read with the snapshot `ZipReader`), equal in speed or faster (1 MB: 8 / 5 ms to write / read, gzip 7 / 4; 30 MB: 28 / 26 ms, gzip 95 / 58) and about 10% larger (per-file deflate) |
| P4 | Embedded servers stay: `createServer({ functions, http, crons, auth })` without a push, beside deployable servers | tests and embedding need no CLI; a server is one or the other | **accepted** (owner, 2026-10-02) |
| P5 | Code written for Convex is not pushed as is: apps import `bunvex/*` (`bunvex/server`, `bunvex/values`); bunvex's bundler does not alias `convex/*`, and the server does not implement Convex's syscall interface, so `npx convex deploy` cannot target bunvex | rule 5 (no "convex" in shipped names); a syscall layer is a second runtime to keep. Migration changes the import lines | **accepted** (owner, 2026-10-02) |
| P6 | `"use node"` modules run in the same process (no separate Node runtime): they get Node and Bun builtins, and Convex's rules for them (actions only; not in `http`, `crons`, `schema`, `auth.config`) are enforced at analysis | Bun implements Node's APIs; a second runtime is not needed | **accepted** (owner, 2026-10-02) |

## 5. Tests

**Loading:**
- modules load into a context and their exports are analyzed as Convex's `AnalyzedModule`;
- imports that are not `bunvex/*`, the bundle's chunks or (in `"use node"`) builtins fail;
- import-time database, fetch and timers fail with Convex's messages;
- the import timeout;
- `Date` / `Math.random` are deterministic per context, without touching the server's globals.

**Swapping:**
- a push swaps everything atomically;
- requests in flight finish on the old version;
- subscriptions re-run only for changed modules;
- the query cache does not serve the old version's results;
- old versions are freed (memory measured across 100 pushes).

**Failure:**
- a failing analyze, schema or cron leaves the old version serving;
- two pushes racing give `raceDetected` and `ConcurrentPush`.

**Schema:**
- the backfill progress;
- validating existing documents (`failed` with the document's id);
- staged indexes.

**Restart:** the latest version loads from the store.

**End to end:** `bunvex deploy` of an example app to a running server, then queries, mutations, actions,
HTTP routes and crons work, and a second deploy changes them.

**Measurement:**
- memory per push and after 100 pushes;
- call overhead against today's in-process functions;
- push time for a 1 MB app.

## 6. Open questions

- **Codegen and typecheck** after `start_push` are item 8, and `dev`'s watch loop is item 9.
- **Environment variables** (`RaceDetected` on a change during a push, and `auth.config` reading them) come
  with item 9. Until then the auth config reads the process environment.
- **Components** (`convex.config.ts`, `componentDefinitions`) are out of scope, as are node external
  packages (`node.externalPackages`).

## 7. A push of a schema already there (2026-10-05)

### 7.1 How Convex does it

`SchemaModel::submit_pending` (crates/database/src/bootstrap_model/schema/mod.rs:207–258) records a push's schema
as follows:

- **Equal to the active schema:** it marks the pending and validated schemas `overwritten` and returns the active
  schema's id, state `Active`. There is nothing to validate. `mark_active` (:324–347) is then a no-op at
  `finish_push`.
- **Equal to the pending (or validated) schema:** it returns that schema's id. It is not overwritten, and its
  validation goes on.
- **Otherwise:** it marks the pending or validated schema `overwritten` and inserts a new pending schema.

"Equal" is `DatabaseSchema`'s `PartialEq` (crates/common/src/schemas/mod.rs:144). Its tables and each kind of
index are `BTreeMap`s keyed by name, and an object validator's fields are a `BTreeMap`. So declaration order does
not matter. The order of an index's fields and of a union's members does.

### 7.2 What bunvex did, and does now

Before this section, `Engine.startSchemaPush` always marked the earlier pending schema `overwritten` and inserted a
new pending one, even for the schema already active. A second push of the same schema raced the first.

Now it does what `submit_pending` does (owner, 2026-10-05):

- **The comparison.** `schemaKey` (schema-json.ts) is the schema JSON with the tables and indexes sorted by name
  and objects' keys sorted. It is compared to each stored schema's key.
- **Equal to the active schema:** the unfinished schema is overwritten, and the active id is returned.
  - Nothing is validated, and `schemaPushStatus` is `complete`.
  - `commitSchemaPush` on the active schema runs the catalog step and the push's body, and leaves the row as it
    is, like Convex's no-op `mark_active`.
- **Equal to the pending or validated schema:** that id is returned, and its validation goes on.
- **The index catalog step is unchanged:** it still runs for every push, as Convex prepares the indexes apart
  from `submit_pending`.

Two pushes of the same schema at once now share it, as on Convex. The race test in `push.test.ts` now uses two
different schemas.

### 7.3 Divergences

None.

### 7.4 Tests

- `packages/core/test/schema-push.test.ts`:
  - the active schema pushed again, with its fields in another order: the active id, complete at once, the commit
    runs its body, and a single `_schemas` row stays;
  - the pending schema pushed again: the same id, not overwritten, and a different schema overwrites it;
  - a pending push followed by the active schema: the pending one is overwritten.
- `packages/server/test/push.test.ts`: over HTTP, a second push of the same schema answers the active schema's id,
  finishes, and leaves one `active` row.

Sabotage checks, each caught:

| Sabotage | Caught by |
|---|---|
| The active schema not reused | core (2 tests), HTTP |
| The pending schema not reused | core |
| The comparison keeps declaration order | core (fields in another order) |
| The commit re-activates (deletes and patches) the active row | core, HTTP (4 tests) |
| Unfinished schemas not overwritten when the active one is reused | core |
