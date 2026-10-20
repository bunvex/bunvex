# STUDY-159 — `@bunvex/testing`, the equivalent of convex-test

- **Status:** decided (owner, 2026-10-20): T-1–T-8 as recommended (§7); DV-540–542 decided, AD-34 and AD-35
  accepted. To build in §3.4's four PRs.
- **Convex source read:** get-convex/convex-test at `8fe3dda` (0.0.62), pinned in
  [upstream.md](../parity/upstream.md#other-repositories). Paths are relative to its root. `index.ts` is one file of
  about 4,000 lines; line numbers are from it.
- **bunvex source:** `main` at `65fd85c7`. Paths are relative to `packages/`.
- **Scope:** the library an app uses to test its functions, and that component packages use for their `./test` entry
  (`register(t, name)`). It is step 2 of [STUDY-158](STUDY-158-own-components.md) §3.4.
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md): bunvex's own components;
  - [STUDY-90](STUDY-90-examples.md) l.85: the `convex-test` example waits for this;
  - [STUDY-150](STUDY-150-error-internal-frames.md) and [STUDY-95](STUDY-95-error-stacks.md): errors of functions
    registered in-process;
  - ARCHITECTURE.md: `testing/` is "the REAL engine in memory", with `testing ──► server, core, values`.

## 1. How Convex does it

### 1.1 The API

- **`convexTest(schema?, modules?)`** (`index.ts:2994`), or `convexTest({schema?, modules?, transactionLimits?})`
  (`:3024`). The two forms are told apart by `schema.tables`.
- **`modules`** is a map from path to loader, normally `import.meta.glob("./**/*.*s")`.
  - Without it, convex-test globs `./convex/**/*.*s` itself (`moduleCache`, `:2488`).
  - The root is the path before the first `_generated` (`findModulesRoot`, `:2509`). With no `_generated`, it throws
    a message asking to run the CLI's `dev`.
- **`defineTestApp({schema, components?})`** (`:2167`, new in 0.0.61). It returns the builders and
  `defineModules(modules)`, which returns `{api, internal, createTest({transactionLimits?})}`. The modules are
  already-evaluated exports.
- **`transactionLimits`** is off by default. `true` or `{}` turns Convex's limits on (`transactionMetrics.ts:23-28`).
- **The test object `t`** (`:2237-2422`):
  - `t.query`, `t.mutation`, `t.action` take a reference or an inline `(ctx) => …`. Internal functions are callable.
  - `t.run(fn)` runs a mutation with `ctx.storage` as an action's writer. `fetch` and timers are refused inside it.
  - `t.fetch(path, init?)` calls the app's `http` router. An unmatched route answers 404.
  - `t.withIdentity(partial)` fills in defaults (`:3121-3135`):
    - `subject`: a hash of the identity;
    - `issuer`: `https://convex.test`;
    - `tokenIdentifier`: `${issuer}|${subject}`.
  - `t.withRequestMetadata({ip?, userAgent?})`.
  - `t.finishInProgressScheduledFunctions()`.
  - `t.finishAllScheduledFunctions(advanceTimers, maxIterations = 100)` (`:3713`) advances the timers and awaits the
    jobs in a loop.
  - `t.registerComponent(path, schema, modules)` (`:2431`) registers a component; a nested one is
    `"parent/child"`. Component packages ship `./test` with `register(t, name)`, which calls it.
- **Types:** `TestConvex<Schema>`, `TestConvexForDataModel`, `ComponentRegistration`, `TestApp`,
  `TestAppDefinition`.

### 1.2 How it works: a backend written in JS

- **Execution.**
  - A handler runs in the test's own process, wrapped by the real `convex` package's builders. Only the syscalls
    are faked.
  - `globalThis.Convex` is a proxy over the current test's state in AsyncLocalStorage (`:159`, `:2788`).
  - An unknown syscall throws.
- **Data.**
  - Documents are kept in a plain object (`DatabaseFake`, `:161`), with one write layer per nested transaction.
  - IDs are a counter and the table name (`:233`), not Convex's format.
  - `_creationTime` is `Date.now()`, nudged by 0.001 to stay unique (`:267`).
- **Queries.**
  - There are no index structures: a query scans the table, filters by the range and sorts (`:700-760`).
  - Text search is a prefix match on words, with no ranking (`:1094`).
  - Vector search is brute-force cosine (`:787`).
  - Pagination encodes the sort keys in its cursors (`:511-660`).
- **Validation.**
  - Args and returns are validated.
  - The schema is validated only when `schemaValidation` is on (`:450`).
  - No size, depth or field-count limit is enforced.
- **Transactions.**
  - There is no OCC: one global lock serializes every query and mutation (`:2848-2895`).
  - A nested call is "not isolated" (`:2875`).
- **Scheduler.**
  - A job is a `setTimeout`, so vitest's fake timers drive it (`:2669`).
  - A job runs once, with no identity, and ends `success` or `failed`, with no retry.
  - Crons are never run.
- **Globals.**
  - In queries and mutations, `fetch`, `setTimeout` and `setInterval` throw (`:2690`).
  - `Date` and `Math.random` are not frozen or seeded.
- **Auth.**
  - The identity is the one given.
  - Across a component boundary it is anonymous (`:3167`).
  - `t.fetch` ignores `Authorization`.
- **Env.** The test's own `process.env`; tests use `vi.stubEnv`.
- **Storage.** Blobs are kept in memory, and the URLs are fake (`:1940-1958`), so an upload to them does not work.
- **Runner.** Vitest, in the `edge-runtime` environment.

## 2. What an app can observe

A test written for convex-test, ported to bunvex, keeps:

- the shape of `t`;
- `api` and `internal` from `_generated/api`;
- `withIdentity`'s defaults;
- `finishAllScheduledFunctions(vi.runAllTimers)`;
- `register(t, name)` from a component package;
- `expect(...).rejects.toThrow(message)` on the backend's errors.

What convex-test does differently from Convex's backend (§1.2) is not something an app relies on on purpose. A test
that passes on convex-test and fails on the real backend has found a bug.

## 3. How bunvex does it

### 3.1 The design: the real engine, in the test's process

bunvex can do what convex-test cannot: run its real engine inside the test, since the engine is TypeScript in the same
runtime. A test then sees exactly what a deployment does: OCC and retries, the planner, search, pagination, IDs,
limits, the scheduler's states, determinism, env and the import phase.

The cost was measured on Bun 1.4.2:

| What | Time |
|---|---|
| Importing core and server | 51 ms, once |
| An engine on memory persistence | 47 ms the first time, about 9 ms after |
| A mutation | about 0.05 ms |
| A query over 1,000 documents | about 0.3 ms |
| A bundle of an example's functions | 2.5–10 ms |

The server's tests already work this way:
- `functions.test.ts`: 6 tests in 126 ms;
- `component-runtime.test.ts`: an install per test, about 85 ms each.

A real-engine harness is not slower than the mock in practice.

### 3.2 Loading the app: pushed, not imported

There are two ways to get the app's functions into the engine.

- **Embedded.** Import the modules and register them in-process (`Functions.register`, `server/src/functions.ts:1500`).
  - It is fast.
  - But the functions share the host's module state and `process.env`.
  - Components cannot work this way: `installComponent` takes pushed code.
- **Pushed.** Bundle the functions directory as the CLI does (`cli/src/bundle.ts:246`, `bundleComponents`) and install
  the result as a push does, in the same process and without HTTP. The code then runs in its `vm` contexts with:
  - the deployment's env;
  - deterministic `Date` and `Math.random`;
  - the import phase;
  - `"use node"`;
  - components, crons and the HTTP router.

  Proposed: **pushed** (T-2). It needs two things:
  - a programmatic install. `push.ts` exports none today; the HTTP push's steps become a function that `@bunvex/testing`
    calls;
  - `testing ──► cli` in the dependency rules, for the bundler.

  One bundle per functions directory per test process is cached by its sources' hash, so a test file pays it once.

### 3.3 The API

- **Names (rule 5, DV-538).**
  - `bunvexTest(schema?, modules?)` and `bunvexTest({schema?, modules?, …})`;
  - `defineTestApp`;
  - the types `TestBunvex<Schema>`, `TestBunvexForDataModel`, `ComponentRegistration`, `TestApp`, `TestAppDefinition`.
  - Every method of `t` keeps its name.
- **Modules.**
  - Bun has no `import.meta.glob`; a probe returned `undefined` under `bun test`.
  - With no `modules`, the functions directory comes from `bunvex.json` (as the CLI reads it). Without one it is
    `./bunvex`.
  - A map in `import.meta.glob`'s shape is accepted too, so a test under Vite-based runners keeps working. Only its
    keys are used, to find the directory.
- **Components.** `t.registerComponent(path, definition)` takes the component's definition file (its
  `bunvex.config.js`). A package's `./test` entry is `register(t, name)`, which passes its own definition, as
  Convex's packages do.
- **Identity.**
  - `withIdentity` fills in the same defaults. The issuer is `https://bunvex.test` (rule 5, DV-538).
  - A call runs as a client's call with that identity, through `callerOf` (`functions.ts:460`), with no JWT.
- **Time.**
  - The engine runs on `TestRuntime`'s virtual clock (`core/src/test-runtime.ts`).
  - The scheduler and the cron executor read `Date.now()` and `setTimeout` directly today
    (`server/src/scheduler.ts:174, 217, 410`; `cron-executor.ts:176, 190, 288`). They move to `engine.runtime`, which
    also lets the server's own scheduler tests drop their `Bun.sleep` polling (25 tests take 7.3 s today).
  - `finishAllScheduledFunctions(advanceTimers?, maxIterations = 100)` keeps its signature. It calls `advanceTimers`
    when given, then moves the virtual clock to each next due job and runs it, until none is left.
  - `finishInProgressScheduledFunctions()` awaits the running ones.
  - Bun's fake timers are native: they also fake the engine's own timers, which is why the virtual clock is used
    instead.
- **Behaviour.** The real backend's (T-3):
  - OCC with retries;
  - Convex's transaction limits on (convex-test's default is off);
  - scheduled mutations retried on conflict, as on a deployment;
  - real storage URLs, so an upload to them works.
- **`t.fetch`.**
  - It calls the HTTP router in-process (`server/src/http-actions.ts:127`), with no port.
  - As in convex-test, the identity is `t`'s, and `Authorization` is not read.
- **Env.** `bunvexTest({env})` sets the deployment's variables, and `t.setEnv(name, value)` changes them (AD-34).
  `process.env` is not seen, as on a deployment. `vi.stubEnv` does not exist in `bun test` anyway.
- **Runner.**
  - `bun test` is supported first.
  - Vitest only under Bun (`bunx --bun vitest`). The engine uses Bun's APIs (`Bun.CryptoHasher`, `bun:sqlite`,
    `Bun.serve`, `vm.SourceTextModule` and others) and does not run on Node.
- **Persistence.** One engine on memory persistence per `bunvexTest()`, released when the test ends.

### 3.4 What is built in which PR

1. **The engine side, which changes no behaviour:**
   - the scheduler and the cron executor on `engine.runtime`;
   - a programmatic install of a bundle;
   - the dependency rule.
2. **`bunvexTest` with the app:**
   - modules, `query`, `mutation`, `action`, `run`;
   - `withIdentity`, `withRequestMetadata`;
   - the scheduled functions;
   - `fetch`, env;
   - the types.
3. **Components:** `registerComponent` and `defineTestApp`. The `./test` convention for `@bunvex/*` packages.
4. **The `convex-test` example of STUDY-90**, ported.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-538 | The names: `bunvexTest`, `TestBunvex*`; the default issuer `https://bunvex.test`; messages naming `bunvex dev` | Rule 5 | rule 5 (no owner choice), as STUDY-158 |
| DV-540 | `@bunvex/testing` behaves as the real backend, where convex-test is a mock: OCC, limits on, real IDs, the planner's and search's real results, real storage URLs, deterministic `Date` and `Math.random`, retried scheduled mutations | It is the real engine; a test then checks what a deployment does | owner, 2026-10-20 (T-3) |
| DV-541 | A test's functions see the env given to `bunvexTest`, not `process.env` | As a deployment; `bun test` has no `vi.stubEnv` | owner, 2026-10-20 (T-5) |
| DV-542 | Runs under `bun test` (and Vitest only under Bun), not on Node | The engine uses Bun's APIs | owner, 2026-10-20 (T-4) |

## 4b. Additions (beyond Convex)

| # | Addition | Why | Decision |
|---|---|---|---|
| AD-34 | `bunvexTest({env})` and `t.setEnv(name, value)` | Without `vi.stubEnv`, a test needs a way to set the deployment's variables | accepted, owner 2026-10-20 (T-5) |
| AD-35 | Crons run in tests: `t.finishAllScheduledFunctions` runs due cron jobs too, and `t.runCron(name)` runs one now | convex-test never runs `crons.ts`; the real executor can | accepted, owner 2026-10-20 (T-6) |

## 5. Tests

- **The package's own tests** port convex-test's own suite (`convex/` in its repository) as bunvex tests:
  - the same scenarios, written for bunvex;
  - each expectation where convex-test's mock and the real backend differ, decided by the real backend's answer.
- **A differential check.** A few scenarios run as a test through `@bunvex/testing`, and the same calls run on a
  deployment through the differential harness. The answers must be the same.
- **The ported example** (STUDY-90's `convex-test`) passes under `bun test`.
- **Speed.** The time of a typical test file is measured and kept in the PR.

## 6. Not verified yet

- Whether `bunx --bun vitest` runs the harness.
- The cost of a pushed install with components per test. It is about 85 ms over HTTP with SQLite. Without HTTP and on
  memory persistence it should be lower, to be measured in PR 2.

## 7. Questions for the owner

All decided by the owner on 2026-10-20, as recommended.

| # | Question | Options | Recommendation |
|---|---|---|---|
| T-1 | The API | Keep convex-test's whole API, renamed for rule 5 (`bunvexTest`, `TestBunvex*`, `defineTestApp`); or a new API | **Keep it.** A test moves with an import change, as the components do |
| T-2 | Loading the app | A: pushed, as a deployment (bundle + install in-process); B: embedded imports; C: both | **A.** It is the only one with components, env, the import phase and `"use node"`, and costs a few ms per test. It needs `testing ──► cli` in the dependency rules |
| T-3 | Mock-like or real (DV-540) | The real backend's behaviour (OCC, limits on, real IDs and search); or copy convex-test's simplifications | **The real backend.** It is the point of running the engine; a port that fails has found a real bug |
| T-4 | Runners (DV-542) | `bun test` only; also Vitest under Bun; also Node | **`bun test`, and Vitest under Bun if it works.** Node would mean shimming every Bun API in core and server |
| T-5 | Env (DV-541, AD-34) | The deployment's env given to `bunvexTest` plus `t.setEnv`; or the host's `process.env` as convex-test | **The deployment's env.** It matches a deployment, and `bun test` has no `vi.stubEnv` |
| T-6 | Crons in tests (AD-35) | Run due crons in `finishAllScheduledFunctions` and add `t.runCron`; or never run them, as convex-test | **Run them.** The engine has the executor, and an app's crons are otherwise untestable |
| T-7 | Time | The engine on a virtual clock that `finishAllScheduledFunctions` drives (still accepting `vi.runAllTimers`); or Bun's fake timers | **The virtual clock.** Bun's fake timers also fake the engine's internals. Moving the executors to `engine.runtime` also speeds up the server's own tests |
| T-8 | Scope of v1 | §3.4's four PRs; additions such as `t.subscribe` (reactivity) or rooms later, each as its own AD | **§3.4.** The additions come after the port matches |
