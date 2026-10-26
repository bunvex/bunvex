# STUDY-158 — bunvex's own components (STUDY-152 step 8)
<!-- index: Components, step 8: bunvex's own `@bunvex/*` components (sharded-counter, batch-worker, rate-limiter, workpool, aggregate, migrations) — Convex's packages read, the platform gaps (the CLI's externals, two exports, paging inside a component, a test harness, publishing), the order, the differential oracle | decided (owner, 2026-10-20): Q-1–Q-8; DV-538 (rule 5), DV-539; the order is the platform fix, `@bunvex/testing` (STUDY-159), `@bunvex/helpers` in parts, then the six components, each studied from its repository at a commit pinned in upstream.md -->

- **Status:** decided (owner, 2026-10-20), §7:
  - Q-1 A: in the monorepo, each package on its own version;
  - Q-2: `@bunvex/<Convex's name>`;
  - Q-3: everything in §2 matches, quirks included;
  - Q-4: the deprecated surface is not built (DV-539);
  - Q-5 B: `@bunvex/helpers` first, a port of convex-helpers in parts;
  - Q-6 B: `@bunvex/testing` first, so the packages ship `./test` (no divergence);
  - Q-7: `BunvexError` and `bunvex` names only, never `Convex*` (DV-538);
  - Q-8: the order of §3.4, with testing and helpers before the components.

  Each piece is studied in its own study from its source repository, at a commit pinned in
  [upstream.md](../parity/upstream.md). A large piece is split into several studies. This study is the plan.
- **Convex source read:**
  - The published `@convex-dev/*` packages, at the newest version at least a week old on 2026-10-20 (read only;
    nothing copied):
    - `sharded-counter` 0.2.3;
    - `batch-worker` 0.3.5, and 0.2.2 for the differences;
    - `rate-limiter` 0.4.2;
    - `workpool` 0.4.14;
    - `aggregate` 0.3.2;
    - `migrations` 0.3.7.
  - The backend at `72ce13c`, the reference commit ([upstream.md](../parity/upstream.md)), for the syscalls they
    use. Paths into a package are relative to its root.
- **bunvex source:** `main` at `65fd85c7`, after STUDY-157. Paths are relative to `packages/`.
- **Scope:** what it takes to ship bunvex's own `@bunvex/*` components. The owner decided (STUDY-152 §9 C1,
  DV-493) that they are written from scratch for `bunvex/*`, with the same client API, component name and schema
  as Convex's packages, so that:
  - an app moves by changing its imports;
  - a Convex export of its data imports unchanged.
- **Related:**
  - [STUDY-152](STUDY-152-components-restudy.md) §6 (the packages), §8 (the step 8 row) and §9 (C1, C6, C7);
  - [STUDY-156](STUDY-156-component-cli.md): components from npm, DV-532, DV-533;
  - [STUDY-157](STUDY-157-component-services.md);
  - DV-312, DV-492, DV-493, DV-495;
  - AD-23, the convex-helpers port.

## 1. How Convex does it

### 1.1 The common shape

Every package follows one template.

- **`package.json`**:
  - `files: ["dist", "src"]`.
  - `exports`:
    - `.`: the client wrapper (`dist/client`);
    - `./convex.config` and `./convex.config.js`: the definition (`dist/component/convex.config.js`);
    - `./_generated/component.js`: types only (`ComponentApi`);
    - `./test`: raw `src/test.ts`, with no condition.
  - `peerDependencies.convex`.
- **Inside the component.** Its functions are plain `query` / `mutation` / `action`. The parent sees them as
  internal references (`components.<name>.<module>.<fn>`).
- **The client wrapper.** A class takes `components.<name>` and calls into it with `ctx.runQuery`,
  `ctx.runMutation` and `ctx.runAction`. When the component must call back into the app, the wrapper passes the
  app's functions as function handles (`createFunctionHandle`).
- **`./test`.** It exports `register(t, name)`, which calls convex-test's
  `t.registerComponent(name, schema, import.meta.glob("./component/**/*.ts"))`. A package with a child also
  registers the child under `<name>/<child>`.

### 1.2 The packages

| Package | Component name, children | Tables | What it needs from the platform |
|---|---|---|---|
| sharded-counter | `shardedCounter` | `counters {name, value, shard}`, index `name [name, shard]` | queries and mutations; `Math.random` in a query |
| batch-worker | `batchWorker`, declares env `LOG_LEVEL` | `workers` (index `name`), `workerState` | the scheduler (`runAfter`, `runAt`, `cancel`) and `_scheduled_functions` reads; handles of the parent's functions called from a mutation; `useStaleSnapshot`; `v.commitTs()` cursors; `v.int64`; convex-helpers `customQuery` / `customMutation` |
| rate-limiter | `rateLimiter` → `batchWorker` | `rateLimits` (index `name [name, key, shard]`), `pendingUpdates {update, updatedAt: v.commitTs()}` | `db.vars.commitTs`; `useStaleSnapshot`; `ctx.meta.getFunctionMetadata()` and `getTransactionMetrics()`; a `./react` hook (`useRateLimit`) |
| workpool | `workpool` → `batchWorker` (`env: {LOG_LEVEL: "REPORT"}`) | `globals`, `internalState`, `work`, `pendingStart`, `pendingCompletion`, `pendingCancelation`, `payload` | all of batch-worker's; scheduled function state; `getConvexSize`; `.count()`; convex-helpers `paginator` |
| aggregate | `aggregate` → `batchWorker` | `btree` (index `by_namespace`), `btreeNode`, `pendingOperations` (`commitTs`), `deadLetterOperations` | a nested mutation whose error rolls back only its own writes; `useStaleSnapshot`; `getTransactionMetrics()`; `getConvexSize` / `getDocumentSize`; `paginator` |
| migrations | `migrations` | `migrations` (indexes `name`, `isDone`) | the scheduler and `_scheduled_functions` reads; handles of the app's migrations; `useStaleSnapshot`; `paginator`; the raw `1.0/getFunctionMetadata` syscall |

**Children.** batch-worker is a child of rate-limiter, workpool and aggregate, so it comes before them.
workpool 0.4.14 no longer has a scheduling loop of its own: its loop is batch-worker's.

**Version skew.** The packages do not all ask for the same batch-worker:
- workpool depends on `^0.2.2`;
- rate-limiter on `0.3.5`;
- aggregate on `0.3.3`.

batch-worker 0.2.2 ran its work query through a private syscall (`1.0/runUdf` with
`udfType: "snapshotQuery"`). 0.3.5 uses the public `ctx.runQuery(handle, args, {useStaleSnapshot: true})`,
which is the same thing: Convex's `runQuery` maps `useStaleSnapshot` to that `udfType`
(`npm-packages/convex/src/server/impl/registration_impl.ts:63-66`). Convex allows it only from a mutation
(`crates/isolate/src/environment/udf/async_syscall.rs:513-519`).

### 1.3 Behaviour that shapes a rewrite

- **sharded-counter.**
  - 16 shards by default, the shard picked with `Math.random`.
  - A client instance remembers the last shard it wrote per key.
  - `rebalance` writes fractional values.
  - `estimateCount` reads a random subset of shards.
- **rate-limiter.**
  - The token bucket and the fixed window, each with its own math:
    - a new limit starts full;
    - a fixed window gets a random phase unless `start` is given.
  - `reserve` and `maxReserved`.
  - Shards with "power of two choices".
  - The error is `ConvexError({kind: "RateLimited", name, retryAfter})`.
  - Asynchronous updates go through batch-worker and are eventually consistent.
- **batch-worker.**
  - It runs a query, then a mutation in one transaction, and reschedules itself.
  - Polling: every 200 ms during a 2 s cooldown.
  - A monitor 60 s behind the loop restarts it.
  - Work is done at least once.
  - Its log events are JSON (`{component: "worker", event}`).
- **workpool.**
  - 100 ms segments.
  - `maxParallelism`: 10 by default; it warns above 100 and refuses above 200.
  - Only actions are retried: `{maxAttempts: 5, initialBackoffMs: 250, base: 2}`, with ±50% jitter.
  - Recovery after 5 min.
  - `onComplete` gets `{workId, context, result}`.
  - Its status is `pending`, `running` or `finished`. An unknown id reads as finished.
  - Its log events are JSON: `enqueued`, `started`, `completed` and a `report` about once a minute.
  - `NonRetryableError` marks its data with `__convexWorkpoolNonRetryable`.
- **aggregate.**
  - A B-tree:
    - node size 16 (even, ≥ 4);
    - the root lazy by default;
    - each node keeps its subtree's `{count, sum}`.
  - Keys are stored as positions `[explodedKey, id, ""]` and ordered by the package's own JS comparator, not the
    index order. For example, `-0` equals `0`, and NaN sorts after every number.
  - A synchronous mode and a queued mode (`pendingOperations` by commit timestamp, batch-worker, dead letters).
    The two refuse to mix (`PENDING_OPERATIONS`).
  - Its errors are `ConvexError`s with codes such as `DELETE_MISSING_KEY`.
- **migrations.**
  - A migration is named by its function name.
  - It runs batches of 100 by default. The batches page with convex-helpers' JSON cursors, and the next batch is
    scheduled by `runAfter(0)`.
  - Dry run: the batch's writes are rolled back by throwing `ConvexError({kind: "DRY RUN"})`.
  - Its status is derived from the worker's `_scheduled_functions` row.
  - Its log hints name the CLI (`npx convex run --component …`).
  - It calls the `1.0/getFunctionMetadata` syscall itself, through `globalThis.Convex.asyncSyscall`, to find its own
    name when invoked directly.

### 1.4 Quirks an oracle will show

Found while reading. Each is what the package does today.

- **aggregate:**
  - `get` on a namespace with no tree throws a `TypeError` (it reads `root` off `null`);
  - `insertIfDoesNotExist` overwrites an existing item's `sumValue`;
  - `DirectAggregate.replace` without `namespace` moves the item to the undefined namespace;
  - the README's `clear(ctx, 16, false)` no longer matches the signature.
- **migrations:**
  - `getStatus({names})` answers in reverse order of the names;
  - a migration that failed inside a series does not resume the series.
- **rate-limiter:** with `throws`, an `ok: true` result that reserved still throws `RateLimited`.
- **workpool:** a pending cancelation reads as `running`; `logLevel` and `maxParallelism` are overwritten by
  every caller.

## 2. What an app can observe

The contract for each `@bunvex/*` package:

- **Its client API.** Classes, methods, option names and defaults, return shapes, the exported validators
  (`vOnComplete`, `vWorkId`, `vResult`, …) and the helpers (`isRateLimitError`, `runToCompletion`, …).
- **Its component name and schema.** The tables, fields and indexes, so a Convex export of the component's data
  imports unchanged (DV-493).
- **Its functions as paths.**
  - An app can call them directly through `components.<name>.<module>.<fn>`.
  - The dashboard and the CLI can run them (`run --component <path> lib:cancel`).
  - The scheduled jobs in an export name them (`loop:loop`, `lib:migrate`).
- **Its errors.** The error class, the `data` shapes and kinds (`RateLimited`, `DRY RUN`, `DELETE_MISSING_KEY`,
  `PENDING_OPERATIONS`) and the message texts.
- **Its timing.** Defaults and constants: backoff, polling, cooldown, segments and the recovery window.
- **Its logs.** Apps and log pipelines parse the JSON events.

## 3. How bunvex does it

### 3.1 The platform is ready

Step 7 left almost nothing for these packages. Each feature in §1.2 exists in bunvex:

- **Calls:**
  - `runQuery` and `runMutation` from a mutation as a subtransaction (`server/src/functions.ts:2070-2098`), with
    the depth limit 8;
  - `useStaleSnapshot` (`functions.ts:2084-2093`);
  - `transactionLimits` (`functions.ts:2254-2302`).
- **Database:**
  - `db.vars.commitTs`, `CommitTsPlaceholder` and `v.commitTs()` (`core/src/database-types.ts:272-276`,
    `values/src/validators.ts:133`; STUDY-53);
  - the table-name-first `db.get/patch/replace/delete(table, id)` (`core/src/database-types.ts:220-300`);
  - `.count()` (`core/src/tx.ts:3030`).
- **Metadata:** `ctx.meta.getFunctionMetadata()` with `componentPath` (#763) and `getTransactionMetrics()`
  (`functions.ts:2041`).
- **The scheduler:**
  - with function handles, in and into components;
  - `_scheduled_functions` per namespace (STUDY-157 PR 1).
- **Components:**
  - a child's env declared by the child and passed by the parent (`server/src/components.ts:9-78`, STUDY-154);
  - nested components (STUDY-156).
- **Determinism:** `Math.random` and `Date` deterministic in queries and mutations (`server/src/code-version.ts:8-10`).

### 3.2 What is missing

- **G1. `@bunvex/*` components are not found, and their client code does not link.**
  - The CLI leaves every `@bunvex/*` import external (`cli/src/bundle.ts:33`). The component graph skips external
    imports (`cli/src/components.ts:85, 102`), so `import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js"`
    is never seen as a child.
  - The server links only `bunvex/server`, `bunvex/values` and their `@bunvex/*` names
    (`server/src/code-version.ts:139-144`). A function that imports `@bunvex/rate-limiter`'s client fails to link.
  - Every package-component test so far uses `@acme/limiter` (`cli/test/component-push.test.ts:99-135`).
  - Fix: the CLI's external list names the platform packages exactly. That is the same set the server links:
    `bunvex`, `bunvex/*`, `@bunvex/server` and `@bunvex/values`, and only the subpaths it serves. Everything else
    in `@bunvex/*` is bundled like any npm package. No divergence.
- **G2. Two exports and four types are missing.**
  - `asObjectValidator` is private (`server/src/builders.ts:45`).
  - These types are missing: `PaginationOptions`, `UserIdentity`, `GenericSchema` and `SchemaDefinition`.
  - Convex exports all of them. Matching is a gap fix.
- **G3. No paginator for use inside a component.**
  - `.paginate()` is refused in a component, as on Convex (`core/src/tx.ts:1606`).
  - Convex's packages page with convex-helpers' `paginator`, which reads an index range by hand and returns a
    JSON cursor.
  - bunvex has no convex-helpers port (AD-23, deferred). See Q-5.
  - **Built (2026-10-20, STUDY-181 PR 4):** `@bunvex/helpers/server/pagination` has convex-helpers' `paginator` and
    `getPage`, with its cursors byte for byte; a component can page its own tables with it.
- **G4. No custom function builders.**
  - batch-worker uses convex-helpers' `customQuery` / `customMutation`, only to add a logger to `ctx`.
  - A rewrite does not need them.
- **G5. No test harness.**
  - `@bunvex/testing` is an empty stub (`testing/src/index.ts`), so there is nothing like `t.registerComponent`.
  - See Q-6.
- **G6. Publishing.**
  - Changesets fixes every `@bunvex/*` package to one version (`.changeset/config.json`,
    `"fixed": [["@bunvex/*", "bunvex"]]`).
  - `scripts/npm-packages.ts:17-33` lists the published packages by hand.
  - Components living in the monorepo need their own versions. See Q-1.

The raw `1.0/getFunctionMetadata` syscall that migrations calls is not a gap. bunvex's migrations reads
`ctx.meta.getFunctionMetadata()`, which gives the same `{name, componentPath}` since #763.

### 3.3 The packages

- **Location:** proposed `components/<name>/` in the monorepo (Q-1), one npm package each.
- **The export map** is Convex's template with bunvex's conditions (DV-533):
  - `.`: the client;
  - `./bunvex.config.js`: `{"@bunvex/component-source": src, "bunvex": dist}`;
  - `./_generated/component.js`: types;
  - `./react` where Convex's package has one.
- **Dependencies:**
  - Each package imports `@bunvex/server` and `@bunvex/values`, as peer dependencies with a `0.x` range.
  - A child is a regular dependency, as in Convex's packages: rate-limiter, workpool and aggregate depend on
    `@bunvex/batch-worker`.
- **No module state** (DV-492). A component's modules are evaluated once per code version, so a package keeps
  nothing in module scope across calls.
  - sharded-counter's remembered shard lives on the client instance, in the app's module. It only changes which
    shard takes the write, never a result.
- **Rule 5.** bunvex's packages have no "convex" in code, identifiers or strings. That touches what an app sees in
  three places:
  - the error class is `BunvexError` (DV-312), with the same `data`;
  - migrations' log hints name `bunvex run`;
  - workpool's non-retryable marker key in the error data is renamed.

  See DV-538.
- **Deprecated surface.** These exist only for jobs scheduled by older versions of the packages:
  - workpool's `loop:main`, `loop:updateRunStatus` and `worker:runActionWrapper`;
  - the aliases `resultValidator`, `vWorkIdValidator` and the like;
  - batch-worker's `vBatchResult`.

  bunvex starts at the current version, so they are not built: the rule of CLAUDE.md (no paths for older stores
  or clients). A Convex export taken while such a job was pending would carry a job to a function that does not
  exist. That job fails as any missing function does. See Q-4.

### 3.4 Order (decided, Q-8)

Every step below has its own study. Each study reads its source repository, cloned next to bunvex
(`~/sandbox/<clone>`) at a commit pinned in [upstream.md](../parity/upstream.md#other-repositories), and bunvex's version is written
from scratch.

1. **The platform.** No study is needed beyond this one; there is no owner choice.
   - G1: the CLI's externals and the server's linker, so that an `@bunvex/*` package is bundled like any npm
     package. `@bunvex/testing` and `@bunvex/helpers` need this as much as the components do.
   - G2: `asObjectValidator` and the four types.
   - G6: packaging. The packages live in the monorepo (Q-1): the libraries in `packages/`, the components in
     `components/<name>/`. Each has its own version outside changesets' fixed group, and is in the publish list.
2. **`@bunvex/testing`** (STUDY-159). Convex's is convex-test (`get-convex/convex-test`), about 4,000 lines: a backend
   written in JS. bunvex's keeps its API, renamed for rule 5. The question its study answers is whether it runs
   bunvex's real engine in memory, in the test's own process, instead of a mock. It includes
   `registerComponent`.
3. **`@bunvex/helpers`.** Convex's is convex-helpers (`get-convex/convex-helpers`), about 15,000 lines without
   tests. It realises AD-23 and is studied and built in parts, in this order:
   1. what the components use: `customFunctions`, `pagination` and `stream`, `triggers`, `validators`;
   2. data: `relationships`, `filter`, `rowLevelSecurity`, `crud`;
   3. Zod (3 and 4) and `standardSchema`;
   4. HTTP: `cors`, `hono`;
   5. the React side: `sessions`, the hooks, the query cache.

   `server/rateLimit` and `server/migrations` are left out. They are the older forms of the rate-limiter and
   migrations components.
4. **The components**, each from its own repository (`get-convex/<name>`), in this order:
   1. sharded-counter: the smallest, queries and mutations only. **Built (2026-10-21,
      [STUDY-183](STUDY-183-sharded-counter.md)):** `@bunvex/sharded-counter` 0.1.0 in `components/sharded-counter/`,
      the package model every later component follows (STUDY-183 §3.1); its tests on `@bunvex/testing`, a differential
      test against `@convex-dev/sharded-counter` 0.2.3 on Convex's binary, and `examples/sharded-counter`;
   2. batch-worker: the child of the next three;
   3. rate-limiter: a child, env, `commitTs`, `useStaleSnapshot`, the React hook;
   4. workpool: the scheduler, handles, retries, recovery;
   5. aggregate: the B-tree, the comparator, the queued mode;
   6. migrations: handles to the app's functions, the CLI flow.

   workpool and aggregate are each studied in two parts: the data and the client first, then the loop or the
   queued mode.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-538 | Rule 5 in the components: `BunvexError` for `ConvexError` (DV-312); migrations' hints name `bunvex run`; workpool's non-retryable marker in the error data has no "convex" (`__bunvexWorkpoolNonRetryable`) | Rule 5 (no "convex" in shipped strings) | rule 5; the names confirmed by the owner, 2026-10-20 (Q-7) |
| DV-539 | The deprecated functions and aliases kept only for older package versions are not built (§3.3) | CLAUDE.md: no paths for older clients | owner, 2026-10-20 (Q-4) |

## 4b. Additions (beyond Convex)

None in this step. The owner wants the packages to grow beyond Convex's (C1). Each growth is proposed in its own
study once the package matches Convex.

## 5. Tests

- **The oracle is the Convex package on the Convex binary.**
  - The differential harness already deploys apps with components to Convex's local backend with Convex's CLI
    (`differential/harness/backends.ts:251`).
  - Each package gets a differential app that runs the same calls against `@convex-dev/<name>` on Convex and
    `@bunvex/<name>` on bunvex, and compares the answers, the errors and the component's tables.
  - The `@convex-dev/*` packages become test-only dev dependencies of `@bunvex/differential`, pinned to the
    versions this study read.
  - Randomness (shards, the fixed window's phase, jitter) is compared through invariants, not values.
- **Unit tests in each package**, on the server's in-memory harness (`server/test/component-runtime.test.ts`),
  including:
  - scheduler draining with `TestRuntime`'s virtual time;
  - aggregate's comparator and B-tree invariants by property (fast-check);
  - workpool's retry, cancel and recovery paths;
  - migrations' dry run, failure and resume.
- **Data portability.** Export a Convex app's component data and import it into bunvex. The bunvex package then
  reads it: the rate limits keep their values, an aggregate's counts and offsets hold, a migration resumes from its
  cursor. This needs step 10 (export and import by component, DV-215). Until then, it is checked by writing the
  same rows through both backends.

## 6. Not verified yet

- What aggregate 0.3.3 (published within the last week; npm here refuses younger versions) changes from 0.3.2,
  and batch-worker 0.3.3 (which aggregate pins) from 0.3.5. To read before the aggregate PR.
- Whether a stale-snapshot read in bunvex sees what Convex's does inside a nested component mutation. Convex
  clones the transaction's snapshot for it (`async_syscall.rs:571-572`). To check in the batch-worker PR.

## 7. Questions for the owner

All decided by the owner on 2026-10-20, each as recommended except Q-5 and Q-6, where the owner chose B:
the test harness and the helpers come first, since they unblock more than the components.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q-1 | Where the packages live, and how they are versioned (C1 left it open) | A: the monorepo, `components/<name>/`, each on its own version outside the fixed group; B: the monorepo on the platform's one version; C: another repo | **A.** The components test the runtime, and the runtime's changes break them, so one CI catches both. Their own versions let each follow its Convex package (0.x) without bumping every platform package |
| Q-2 | npm names | `@bunvex/<convex-name>` (`@bunvex/rate-limiter`, `@bunvex/workpool`, …), sharing the scope with the platform (needs G1's exact list); or a separate scope | **`@bunvex/<same name>`.** The move from Convex is then one rename per import, and G1 is a small fix |
| Q-3 | How far "the same" goes (DV-493 says client API, component name and schema) | Also the component's function paths, their validators and errors, the timing constants and the JSON log events (§2); or only the client API and schema | **All of §2.** Apps call component functions directly, the CLI and dashboard name them, and exports carry scheduled jobs that name them. Quirks (§1.4) are matched too. The aggregate `TypeError` is matched as an error, since an app cannot depend on its message |
| Q-4 | The deprecated functions and aliases (§3.3) | Build none (DV-539); or build them for exports taken mid-run | **Build none.** That is CLAUDE.md's rule. An export with a pending job of an older package version is a corner case, and the job fails visibly |
| Q-5 | Paging and helpers inside the components (G3, G4): convex-helpers is a dependency of five of the six | A: a private workspace helper bundled into each package; B: port convex-helpers first (AD-23) and depend on it | **A now.** It is a few dozen lines (an index-range reader with a JSON cursor). AD-23 stays its own decision, and the components can switch to it later |
| Q-6 | Tests for apps (convex-test's `register(t)`) | A: no `./test` entry until `@bunvex/testing` exists (a divergence), the harness its own study; B: build a minimal `@bunvex/testing` with `registerComponent` first | **A.** An app on convex-test cannot run on bunvex's test harness anyway until that harness exists. The packages test themselves on the server's in-memory engine |
| Q-7 | workpool's non-retryable marker key (`__convexWorkpoolNonRetryable` cannot ship, rule 5) | `__bunvexWorkpoolNonRetryable`; or a neutral `__workpoolNonRetryable` | **`__bunvexWorkpoolNonRetryable`**, the same rename DV-312 applied elsewhere |
| Q-8 | Order (§3.4) | As §3.4; or C7's order (workpool, rate-limiter, aggregate, migrations) without sharded-counter | **§3.4.** sharded-counter proves the packaging cheaply, and batch-worker has to come before the three that use it |
