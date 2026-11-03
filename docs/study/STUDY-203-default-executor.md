# STUDY-203 — The default executor: what `vm` costs an app, and what `process` and execution workers change
<!-- index: the divergences an app can observe because functions run in `vm` contexts by default (DV-528 unhandled rejections, DV-208/DV-146 synchronous loops, DV-553 memory, DV-165/DV-492/DV-573 module state, DV-02 determinism), how Convex's isolates avoid each, and what the `process` sandbox (AD-44) and the execution workers (STUDY-190/194) change; which default to aim for | open: owner questions E-1–E-4 -->

- **Status:** open. Owner questions E-1–E-4 (§6). Docs only; nothing is built here.
- **Why now:** the owner asked (2026-11-02) which divergences could make an app behave differently on bunvex
  than on Convex. Most of the ~180 app-visible rows are names and message text. The ones that change behaviour
  come from one choice: functions run in `vm` contexts in the server's own process (DV-164). The owner approved
  this study (2026-11-03).
- **Convex source read:** `../convex-backend` at `db19afd4a` (2026-10-22). Paths are relative to `crates/`.
- **bunvex source:** `main` at `980928b2` (2026-11-03), and #1021 (`perf/exec-query-workers`, queries on
  execution workers, open) as its author described it (bunvex-55, 2026-11-03).
- **Related:**
  - [STUDY-03](STUDY-03-deterministic-execution.md) (DV-02): determinism;
  - [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md) (DV-208): the 1 s limit;
  - [STUDY-35](STUDY-35-push-and-deploy.md) (DV-164, DV-165): one `vm` context per code version;
  - [STUDY-168](STUDY-168-process-sandbox.md) and [STUDY-171](STUDY-171-function-sandbox-seam.md) (AD-44): the
    `process` sandbox;
  - [STUDY-188](STUDY-188-runtime-test-gaps.md) (DV-553): the memory cap under `process`;
  - [STUDY-190](STUDY-190-offthread.md) and [STUDY-194](STUDY-194-execution-protocol.md) (DV-573, DV-574,
    AD-47): execution workers.

## 1. How Convex does it

Every function runs in a V8 isolate, and each call gets its own context:

- **An isolate pool.** `MAX_ISOLATE_WORKERS` threads, 300 by default (`common/src/knobs.rs:1017`), each running
  one call at a time (`isolate/src/isolate_worker.rs`, `isolate/src/client.rs`). An isolate is recycled after
  `ISOLATE_IDLE_TIMEOUT` (600 s) or `ISOLATE_MAX_LIFETIME` (1 h) (`knobs.rs:1044-1049`).
- **A fresh context per call.** `isolate/src/environment/udf/mod.rs:801` builds a new context for each request.
  The exception is a function that opts in with `experimental_reuseContext` (read at analysis,
  `environment/analyze.rs:451-466`). `isolate/src/context_cache.rs:163-174` then routes it to an isolate that kept
  that module's context, and routes every other request away from warmed contexts.
- **Unhandled rejections fail the call.** After each microtask checkpoint, the runner looks for rejections still
  unhandled. If one is there, it terminates the context with `UnhandledPromiseRejection`
  (`environment/udf/mod.rs:1121-1138`). A mutation that fails this way commits nothing.
- **A hard time limit.** The user timeout (`DATABASE_UDF_USER_TIMEOUT`, 1 s, `knobs.rs:980`; actions their own)
  is enforced by `isolate/src/timeout.rs`. Past it, `termination.rs:169` calls V8's `terminate_execution`, which
  stops even a synchronous loop. The other calls are on other isolates and never notice.
- **A memory cap per call.** `ISOLATE_MAX_USER_HEAP_SIZE` is 64 MiB (`knobs.rs:1165`), plus array buffers.
  Past it the call fails uncatchably: "JavaScript execution ran out of memory (maximum memory usage: 64 MB)"
  (`isolate/src/termination.rs:271`).
- **Deterministic globals.** Each context replaces `Date`, `Math.random` and the other non-deterministic globals,
  and offers no API outside the syscalls. Code cannot reach the host.

## 2. What an app can observe

This is the contract. On Convex:

1. A function that leaves a rejected promise unhandled **fails**. A mutation's writes are discarded.
2. A synchronous infinite loop **fails that call** at the time limit. Other calls are unaffected.
3. A call that allocates past 64 MiB **fails**. The server is unaffected.
4. Module-level variables **start fresh on every call**, unless the function opts into `experimental_reuseContext`.
5. A query **cannot escape determinism**: there is no non-deterministic API to reach.

## 3. How bunvex does it

### 3.1 Under `vm`, the default (DV-164)

One `vm` context per code version, in the server's own process and event loop (`packages/server/src/function-executor.ts`,
`vmExecutor`). Each point of §2:

| §2 | bunvex under `vm` | Row | Effect on an app |
|---|---|---|---|
| 1 | The rejection is printed to stderr, and the function goes on. It can succeed | DV-528 | **A mutation that fails on Convex commits on bunvex** |
| 2 | The 1 s limit is checked at database calls and at the end. A synchronous loop is never interrupted | DV-208, DV-146 | **One bad call blocks the whole server**: every deployment's functions, the sync WebSockets, the HTTP API |
| 3 | No cap | DV-553 | A call that fails on Convex runs. A large one can take the server's memory |
| 4 | Module state lives as long as the code version, shared by every call | DV-165, DV-492 | A module-level cache can carry one user's data into another user's call |
| 5 | Determinism is installed in the context, but code can escape it (`Date.now` captured before the install, `Bun.*`) | DV-02 | A query can stop being deterministic. Its cached result and its invalidation can then be wrong |

Why `vm` cannot do better, from the rows:

- 1: every call shares one event loop, and Bun's `unhandledRejection` listener runs with no `AsyncLocalStorage`
  context. So a rejection cannot be traced to its call when several calls run at once (DV-528, STUDY-171 §11.9).
- 2 and 3: JavaScriptCore has no isolate API. Nothing can stop or cap one `vm` context without stopping the
  process (AD-44's "why").

### 3.2 Under `process` (AD-44, opt-in)

App code runs in a child Bun process. Built so far: queries, mutations, actions, HTTP actions and components
(STUDY-171 §7–§15). Not built yet: the OS isolation layers (STUDY-168 PR 8; only `ISOLATION=none` runs), the pool
(PR 9; one child per code version until then) and `"use node"` actions (PR 10).

| §2 | bunvex under `process` | Matches Convex? |
|---|---|---|
| 1 | The call fails with the value as thrown, at the end of the checkpoint that left it (STUDY-171 §13) | yes |
| 2 | A call that never yields fails at its time limit ("Function execution timed out (maximum duration: …)", STUDY-188 R12's sabotage table; actions: a cut-off, then a kill, STUDY-171 §12); the child is replaced | yes, for that call. While the pool is one child per code version, the calls sharing the child fail with it |
| 3 | Approximate cap: 64 MiB of `ArrayBuffer`s, or 96 MiB of heap after a full collection; a watchdog past 256 MiB of process growth (DV-553, STUDY-188 R12, gaps G1–G7) | approximately |
| 4 | One context per code version inside the child, as under `vm` | no (DV-165 still holds) |
| 5 | The child holds no host key and no store (DV-579). Without PR 8's layers it can still reach the OS | partly |

**Cost** (STUDY-171 §8.10, `bench/calls.ts`, one call at a time, p50 µs):

| Function | Mac, `vm` | Mac, `process` | VPS 2 vCPU, `vm` | VPS 2 vCPU, `process` |
|---|--:|--:|--:|--:|
| empty query | 19 | 74 | 58 | 199 |
| 1 × `db.get` | 25 | 113 | 74 | 488 |
| 10 × `db.get` | 55 | 500 | 165 | 2 122 |
| 100 × `db.get` | 349 | 4 358 | 1 154 | 28 808 |
| insert mutation | 42 | 150 | 136 | 610 |

Every database operation is a round trip to the host: about 40 µs on the Mac, and 80–280 µs on the VPS
depending on pinning. A query that reads 100 documents one at a time is 12–25× slower. Convex batches consecutive
reads in one round trip (`isolate/src/environment/async_syscall.rs`, STUDY-171 §8.10). Batching is the lever
STUDY-168 §13.4 names, and it is not built.

### 3.3 Execution workers (STUDY-190 / STUDY-194, #1021 for queries)

App code runs under the same `vm` executor, inside Bun Workers beside the main thread. #1021 covers only queries
of pushed code on a SQLite file, under `vm`. Mutations (PR 3), actions (PR 4), Postgres and MySQL (step v) come
later. Each worker can have several calls in flight: a call goes to the ready worker with the fewest
(`execution-workers.ts`).

| §2 | bunvex with execution workers (as of #1021) | Matches Convex? |
|---|---|---|
| 1 | Unchanged: the same `vm` executor, several calls per worker | no (DV-528) |
| 2 | A query that never yields is caught by a shared progress counter. Its worker is terminated and replaced, and the call fails with the user time limit's message. The main thread keeps answering (`query-workers.test.ts`, "a query that never yields") | yes for queries, except that the other calls in flight on that worker fail too, as system errors. Mutations and actions: unchanged (DV-208) |
| 3 | Unchanged: no Worker resource limits are set | no (DV-553) |
| 4 | Per code version and per worker (DV-573, owner 2026-10-26) | no |
| 5 | Unchanged: the same determinism hooks inside the worker | no (DV-02) |

**Cost:** one worker call is 250–450 µs off the main thread (STUDY-190 §4.5), and the outcome encoding is
4–6 µs of that (STUDY-194 §4.2). Throughput **gains**: uncached queries are 1.83× faster on DO c-4 (1741–1764 →
3201 req/s, p99 71 → 46 ms). Cached queries and inserts are unchanged, and `0` workers costs nothing
(#1021, `bench/results/cloud/2026-11-02-s194-vi/`).

## 4. Options for the default

| | Fixes §2 | Cost | Ready |
|---|---|---|---|
| **A. Keep `vm`, document it** | none | none | now |
| **B. `process` by default** | 1, 2, 3; 5 with PR 8 | +55–140 µs per call, +40–280 µs per database op; 12–25× on read-heavy queries until batching | no: PR 8 (isolation), PR 9 (pool), PR 10 (`"use node"`), batching |
| **C. Execution workers by default** (already DV-574's default for what they cover) | 2 for queries today; 2 for everything once PR 3–4 land; 1 and 3 only with the change in E-3 | gains throughput (1.83× uncached queries) | partly: queries on SQLite (#1021) |
| **D. C, with `process` kept opt-in** for code the operator does not trust (a cloud running others' code) | as C; B where chosen | as C; B where chosen | as C |

**Recommendation: D.** Workers already beat `vm` on throughput and already fix point 2 for queries. Once
mutations and actions move to workers, point 2 is fixed for every call. `process` remains the wall for hostile
code, where its cost is the price of the boundary.

Points 1 and 3 need one more step, E-3. A worker that runs **one call at a time** can trace an unhandled
rejection to its call. It can also measure that call's heap growth, the way the `process` child does (STUDY-188
R12). That trades concurrency inside a worker for Convex's behaviour; it needs a spike and a measurement on c-4
before any decision, as the owner asked for 2b (spike first, no gain no merge).

Point 4 (module state): bunvex's DV-165/DV-573 behave like Convex's `experimental_reuseContext`, but for every
function instead of only those that opt in. Matching Convex exactly means a fresh context per call, which is the
cost DV-164 avoided (~0.4 µs per call against a new context's evaluation). This study does not propose to change
it. It proposes to say it plainly in the user docs (E-4).

Point 5 (determinism) needs a real boundary. `process` with PR 8 gives one; workers do not.

## 5. Divergences

No new divergence. This study revisits DV-528, DV-208, DV-146, DV-553, DV-165, DV-492, DV-573 and DV-02, and
proposes how they could close. If E-1 changes the target, the affected rows get a note pointing here.

## 6. Owner questions

| # | Question | Recommendation |
|---|---|---|
| E-1 | Which default to aim for: A (`vm`), B (`process`), C (workers) or D (workers, with `process` opt-in for untrusted code)? | **D** |
| E-2 | Until workers cover mutations and actions, document the `vm` limits for self-hosters (README, `docker/README.md`, `docs/upgrading.md`)? The text would say: a synchronous loop blocks the server, there is no memory cap per function, an unhandled rejection does not fail the function, and module state is shared | **yes**, a docs PR now |
| E-3 | Spike a worker mode that runs one call at a time, measured on c-4, to see whether it can match Convex on unhandled rejections (DV-528) and the memory cap (DV-553) at an acceptable throughput? It would be built in the execution-workers area (bunvex-55), after PR 3–4 | **yes**, after PR 3–4, as a spike: no gain, no merge |
| E-4 | Keep module state per code version (DV-165/DV-573), and say in the user docs that it behaves like Convex's `experimental_reuseContext` for every function? | **yes** |

## 7. Tests

None: docs only. Each follow-up brings its own tests. E-3's spike would bring a differential test against
Convex's binary for unhandled rejections and the memory cap (`packages/differential`, as
`unhandled-rejections.test.ts` does under `process`).
