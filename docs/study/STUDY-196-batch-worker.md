# STUDY-196 — `@bunvex/batch-worker`
<!-- index: `@bunvex/batch-worker`, the second own component (STUDY-158 §3.4 step 4.2) and the child of rate-limiter, workpool and aggregate: the loop (a stale-snapshot work query, then the worker mutation in one transaction), the monitor, the cursor, `ping`/`start`/`stop`/`kick`; written from get-convex/batch-worker 0.3.6, one package serving the 0.2.2, 0.3.3 and 0.3.5 that the three dependents ask for | decided (owner, 2026-10-27): B-1–B-3 as recommended; built: the package, its tests and the differential test; the example to come -->

- **Status:** decided (owner, 2026-10-27): B-1–B-3 as recommended (§7); B-1 extends DV-539. Built (2026-10-27):
  `components/batch-worker/`, its tests and `packages/differential/test/batch-worker.test.ts` (§5). The example
  (B-2) comes in its own PR.
- **Convex source read:** get-convex/batch-worker at `f299a7b` (0.3.6), pinned in
  [upstream.md](../parity/upstream.md#other-repositories), with the tags `v0.2.2`, `v0.3.3` and `v0.3.5` for the
  versions the dependents ask for. Paths are relative to that repository's root. Backend paths are from
  convex-backend `db19afd`.
- **bunvex source:** `main`. Paths are relative to the repository's root.
- **Scope:** STUDY-158 §3.4 step 4.2. It is also a prerequisite of built-in auth (STUDY-191 §3.6): Convex Auth v2
  depends on `@convex-dev/rate-limiter`, which depends on batch-worker.
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md): the plan, Q-1–Q-8, DV-538, DV-539;
  - [STUDY-183](STUDY-183-sharded-counter.md): the package model every component follows (S-1–S-4);
  - [STUDY-159](STUDY-159-testing.md): `@bunvex/testing`, `registerComponent`, DV-546;
  - [STUDY-181](STUDY-181-helpers-core.md): `@bunvex/helpers`' `customFunctions`;
  - [STUDY-191](STUDY-191-convex-auth-v2.md): why auth needs it.

## 1. How Convex does it

### 1.1 The component

- **Definition.** `defineComponent("batchWorker", {env: {LOG_LEVEL: v.optional(logLevel)}})`, with no children
  (`src/component/convex.config.ts`). `logLevel` is `DEBUG | TRACE | INFO | REPORT | WARN | ERROR`, in that order.
- **Schema** (`src/component/schema.ts`). Two tables, one row each per named worker:
  - `workers {name, workQuery, workerMutation, config: vConfig.partial(), status, stateId: id("workerState")}`,
    index `name [name]`. The two handles are strings from `createFunctionHandle`. It is written only on
    transitions, so `ping`, called on every insert, can read it without conflicting with the loop.
  - `workerState {generation: int64, lastWorkTs: number, runnerId?, monitorId?: id("_scheduled_functions"),
    monitorRunAtMs?, cursor?: any}`. The loop writes it every iteration.
- **Config** (`src/component/shared.ts`): `{debounceMs: 0, monitorLagMs: 60 000}` by default.
- **Constants** (`shared.ts`, `loop.ts`):

  | Name | Value | Use |
  |---|---|---|
  | `RUNNING_THRESHOLD_MS` | 1 s | a delay at or below it keeps the worker `running` |
  | `MONITOR_LAG_MS` | 60 s | the monitor's default distance behind the loop |
  | `MONITOR_REFRESH_WITHIN_MS` | 10 s | the monitor is moved only when it would fire within this; also the minimum lag |
  | `STUCK_RUNNER_GRACE_MS` | 60 s | a pending run this late is stuck |
  | `DEFAULT_POLL_INTERVAL_MS` | 200 ms | polling while cooling down |
  | `DEFAULT_COOLDOWN_MS` | 2 s | how long an idle queue is polled before going idle |

- **Status** (`vStatus`): `{kind: "idle" | "running" | "stopped"}`.

### 1.2 The public functions (`src/component/lib.ts`)

- `ping({name, workQuery, workerMutation, config?})` → `null` (`kick.ts` `ping`).
  - No worker: insert `workerState {generation: 0n, lastWorkTs: 0}` and `workers` with status `running`, then
    schedule the loop after `config.debounceMs ?? 0`.
  - A worker exists: if a handle changed, or `config` was given and its `debounceMs` or `monitorLagMs` differs,
    `replace` the row with the new handles and config.
  - Not `idle` (running or stopped): no-op. Otherwise `wake`.
- `start({name})` → `null`: wakes a `stopped` worker; no-op otherwise, and for an unknown name.
- `stop({name})` → `null`: cancels the pending run (bumping the generation), cancels the monitor, sets `stopped`.
- `kick({name})` → `null` (0.3.2): from any status, cancels the run and the monitor, sets `running`, and schedules
  the loop now. Manual recovery when both were canceled from the dashboard.
- `status({name})` → the status, or `null` for an unknown name.
- `getCursor({name})` → the stored cursor, or `null`.
- `setCursor({name, cursor?})` → `null`. It throws `Error('[setCursor] no worker named "<name>". Ping it first.')`
  for an unknown name; an omitted cursor clears it.

### 1.3 Waking and scheduling (`src/component/kick.ts`)

- **`wake`.** Sets `running`. If the pending run is already due before `now + max(debounceMs, 1 s)`, it keeps it
  and moves `lastWorkTs` up to its `scheduledTime`. Otherwise it cancels it and schedules a run after `debounceMs`
  with `lastWorkTs = now + debounceMs`.
- **`scheduleLoopRun`.** `generation + 1`, `runAfter(delay, loop, {name, generation})`, and one patch of
  `workerState` with the generation, the runner, `lastWorkTs` and the cursor (each only when given). Then
  `ensureMonitored(now + delay)`.
- **`ensureMonitored`.** `lag = max(10 s, config.monitorLagMs ?? 60 s)`. It reschedules only when there is no
  monitor or it would fire within `min(lag / 2, 10 s)`, at `max(loopRunAt, now) + lag`, cancelling the old one.
- **`continueRunning`.** From a status other than `running`, it sets `running` and starts a fresh cooldown
  (`lastWorkTs ≥ now + delay`).
- **`scheduleWaiting`** schedules the run and sets `idle`, so a ping can interrupt the wait.
- **`goIdle`** bumps the generation, clears the runner, cancels the monitor and sets `idle`.
- Cancelling goes through `_scheduled_functions`: only a `pending` job is cancelled.

### 1.4 The loop (`src/component/loop.ts`)

An internal mutation `loop({name, generation})`:
1. A missing worker, or a generation that is not the stored one, exits silently.
2. The work query runs through `ctx.runQuery(handle, {name, cursor?}, {useStaleSnapshot: true})`: at the
   transaction's start snapshot, with no read dependencies, so inserts racing the loop do not make it retry.
3. **A batch** (`"batch" in result`): the worker mutation runs in the same transaction
   (`ctx.runMutation(handle, batch)`). The next run is after its `debounceMs ?? 0`. The cursor stored is the
   mutation's if it returned one, else the query's; it commits with the batch.
4. **No batch, still cooling down** (`now < lastWorkTs + (cooldownMs ?? 2 s)`): run again after
   `pollIntervalMs ?? 200 ms`.
5. **Cooled down:** the query runs again as an ordinary read, which takes a dependency. If it now returns a batch,
   the loop logs a warning (`snapshot query mismatch`) and runs again at once.
6. **`timeoutMs` given:** at or below 1 s or the poll interval, it stays running; otherwise it waits (`idle`).
7. **Otherwise** it goes idle; only a ping wakes it.

If the query or the mutation throws, the loop's transaction fails and nothing reschedules it. The monitor
restarts it. Work is therefore done at least once, and one item that always throws wedges the queue
(README, "Failure handling").

### 1.5 The monitor (`src/component/monitor.ts`)

An internal mutation `monitor({name})`, which only fires when the loop missed its run:
- a run pending more than 60 s past its time, and the worker not stopped: log an error and an event
  `restart {name, stuck: true}`, cancel the run, run again now;
- not `running`: cancel itself;
- a pending run: fired early, so re-arm behind it;
- otherwise: log an error and `restart {name}`, run again now.

### 1.6 Logging (`src/component/logging.ts`, `functions.ts`)

- The builders wrap `_generated/server`'s with convex-helpers' `customQuery` / `customMutation`, adding
  `ctx.log = createLogger(env.LOG_LEVEL)`. The default level is `REPORT`.
- `debug` logs at `DEBUG`; `info` at `INFO` and below; `warn`, `error`; `time` / `timeEnd` at `TRACE`.
- `event(name, payload)` writes `console.info(JSON.stringify({component: "worker", event, ...payload}))` at `INFO`
  and below, and at `REPORT` only for the event `report`.
- An unknown level throws `Invalid log level: <level>`.

### 1.7 The client (`src/client/index.ts`)

- `ping(ctx, component, {name, workQuery, workerMutation, config?})`: makes the two handles with
  `createFunctionHandle`, then runs `component.lib.ping` with `config ?? {}`. It takes a mutation or an action
  ctx.
- The types: `BatchQueryArgs<Cursor>`, `BatchResult<Batch, Cursor>`, `WorkerResult<Cursor>`, `DefaultCursor`,
  `WorkerConfig`, `WorkerStatus`.
- `defineBatchWorkerValidators({batch, cursor?})` → `{vQueryArgs, vQueryReturns, vMutationArgs,
  vMutationReturns}`. The cursor defaults to `v.commitTs()` (`vDefaultCursor`).
- Deprecated since 0.3.0: `vBatchQueryArgs`, `vBatchResult(batch)`, `vWorkerResult`.
- `./test`: `register(t, name = "batchWorker")` returns the `ComponentApi` (0.3.6, for convex-test's
  `defineTestApp`).

### 1.8 The versions the dependents ask for

| Package | Asks for | Imports |
|---|---|---|
| workpool (`7fde769`) | `^0.2.2` | `ping`, `vBatchResult`, `BatchResult` |
| rate-limiter (`dee5af1`) | `0.3.5` | `ping`, `defineBatchWorkerValidators` |
| aggregate (`9387465`) | `0.3.3` | `ping`, `defineBatchWorkerValidators` |

From 0.2.2 to 0.3.6 every change is additive (`git diff v0.2.2 f299a7b`): the cursor (an optional field), `kick`,
`getCursor`, `setCursor`, `defineBatchWorkerValidators`, and the 0.3.2–0.3.3 scheduling fixes. 0.2.2 ran the work
query through the private `1.0/runUdf` syscall with `udfType: "snapshotQuery"`; 0.3.x uses the public option,
which maps to the same thing (STUDY-158 §1.2). So one package at 0.3.6's behaviour serves all three.

### 1.9 Its tests

- `src/component/lib.test.ts` (22 cases): creation and scheduling, the monitor's distance, ping's no-ops, status,
  stop and start, logging through a mock logger, a superseded generation, waking a long sleep, the cooldown
  window, the stuck runner (four cases), `kick` after cancelled jobs, independent named workers.
- `src/client/index.test.ts`: the loop end to end, stop and start, and the cursor (round trip, the mutation's
  override, `setCursor`, seeding, a non-`commitTs` cursor).
- `example/`: a task queue, denormalized aggregates, and actions behind `@convex-dev/rate-limiter`.

## 2. What an app can observe

STUDY-158 §2 (Q-3) applies:
- the component's name `batchWorker`, its env `LOG_LEVEL`;
- the schema, so a Convex export of its data imports unchanged;
- the function paths (`lib:ping`, `lib:start`, `lib:stop`, `lib:kick`, `lib:status`, `lib:getCursor`,
  `lib:setCursor`, `loop:loop`, `monitor:monitor`), their validators and results;
- the timing contract: the defaults of §1.1, the cooldown, the monitor's lag, and at-least-once processing;
- the log lines and the JSON events, at each level;
- the `setCursor` error.

Exact times are the scheduler's. Tests compare outcomes once the worker is idle: the rows processed, the cursor,
the status, and the jobs left in `_scheduled_functions`.

## 3. How bunvex does it

### 3.1 The package

STUDY-183's model, unchanged:
- `components/batch-worker/`, version 0.1.0, its README naming batch-worker 0.3.6;
- `src/component/{bunvex.config.ts, schema.ts, lib.ts, kick.ts, loop.ts, monitor.ts, logging.ts, functions.ts,
  shared.ts}` and `_generated/`, committed;
- `src/client/index.ts` and `src/test.ts` (`register(t, name = "batchWorker")`, returning `ComponentApi`);
- the export map of STUDY-183 §3.1.

The builders use `@bunvex/helpers`' `customQuery` / `customMutation` (STUDY-181), as Convex's package uses
convex-helpers. `@bunvex/helpers` is a regular dependency.

### 3.2 The platform is ready

Everything §1 uses exists in bunvex (STUDY-158 §3.1):
- `ctx.runQuery(handle, args, {useStaleSnapshot: true})` from a mutation (`packages/server/src/functions.ts:2401`),
  into the app through a handle;
- `runMutation` as a subtransaction;
- the scheduler and `db.system.get("_scheduled_functions", id)` per component;
- the component's env;
- `v.commitTs()`, `VCommitTs`, `asObjectValidator`, int64.

**The stale snapshot in a nested call.** STUDY-158 §6 left this to this PR. It is checked:
- Convex clones the transaction for a snapshot query and resets its writes and its read set
  (`crates/database/src/transaction.rs:1460-1485`), so the query reads the snapshot the transaction began at.
  In a nested component call, that transaction is the top-level one (`async_syscall.rs:694-698`).
- bunvex runs the query as its own read at `db.snapshot`, the outer transaction's begin snapshot, with no
  read set (`functions.ts:2401-2426`). Same result.

**The env's type.** bunvex's `_generated/server` types `env` as `Record<string, string | undefined>` (DV-176), not
with the declared `LOG_LEVEL` union. `functions.ts` casts it, which is safe because the push checks a binding against
the declared validator (`packages/server/src/component-tree.ts`). Nothing observable.

### 3.3 Written from scratch

It follows §1 exactly, with Convex's names, paths, validators, constants, log lines and events. Nothing names
Convex: the event's `component` is `"worker"`, and the one thrown error has no product name. DV-538 has nothing to
rename here.

The deprecated validators are covered by B-1.

### 3.4 The dependents

When they are written, `@bunvex/rate-limiter`, `@bunvex/aggregate` and `@bunvex/workpool` depend on this one
package. workpool's port uses `defineBatchWorkerValidators({batch}).vQueryReturns`, which is the same validator as
`vBatchResult(batch)`.

### 3.5 Tests

- **The upstream tests, ported** on `@bunvex/testing`: all of §1.9's `lib.test.ts` and `index.test.ts` cases. They
  call the loop and the monitor directly. Time moves on the harness's virtual clock
  (`finishAllScheduledFunctions`, `finishInProgressScheduledFunctions`), as convex-test's fake timers do.
- **More:**
  - the log levels and the JSON events;
  - `setCursor`'s error;
  - a worker mutation that throws: it is retried after the monitor's lag, and the same batch comes back;
  - a 0.2.2-shaped row (no cursor) keeps working.
- **A differential test.** The same app runs on Convex's binary with `@convex-dev/batch-worker` 0.3.6 and on bunvex
  with `@bunvex/batch-worker`. It enqueues N items, pings, waits until both are idle, and then compares:
  - the processed rows;
  - both components' tables, without ids or times;
  - `status` and `getCursor`;
  - the errors of bad arguments.
- **The example** (B-2).
- **Sabotage checks:** the generation check, the stale-snapshot option (read with a dependency and watch the
  racing-insert test conflict), the cooldown, and the monitor's stuck-runner branch.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | none beyond DV-176 (the env's type) and DV-538; B-1 extends DV-539 to the two other deprecated validators | | owner, 2026-10-27 |

## 4b. Additions

None.

## 5. Tests

As §3.5, built:
- `components/batch-worker/test/lib.test.ts`: upstream's 22 component cases. A runner stuck pending in the past is
  made by scheduling the loop's run at a time 10 minutes ago: the harness's clock runs what falls due as it moves,
  where upstream moves vitest's clock without running anything.
- `test/client.test.ts`: upstream's 7 client cases, on an app that installs the package by its name.
- `test/behaviour.test.ts`: a throwing worker mutation retried after the monitor's lag with the same batch, the
  cooldown's polls, `setCursor`'s error, and the logger's levels and events.
- `packages/differential/test/batch-worker.test.ts`: the same queue and cursor-driven worker drained on Convex with
  `@convex-dev/batch-worker` 0.3.6 and on bunvex give the same batches, status, cursor and component rows; bad
  arguments give the same errors.

**Sabotage checks** (each one breaks a test): the generation check, the cooldown, the stuck-runner branch, the
mutation's cursor winning over the query's, the monitor's lag, and the `report` event at `REPORT`. Dropping
`useStaleSnapshot` breaks none: telling a snapshot read from an ordinary one needs an insert racing the loop's
transaction, which the harness runs one at a time. The option itself is covered by the server's tests
(`packages/server/test/nested-calls.test.ts`).

**Found by the differential test, outside the package:** when a caller catches a nested call's argument
validation error, the message ends with one newline on Convex and two on bunvex (`ValidatorError.args`,
`packages/server/src/errors.ts`). The test drops that newline and names the gap; the server's fix is its own PR.

## 6. Not verified yet

- A snapshot query on a table this same transaction created. Convex clones the metadata, so the table reads as
  empty (`transaction.rs:1477-1481`, ENG-10621). bunvex reads it at the begin snapshot, where the table does not
  exist. To check in the PR; batch-worker never does this.
- Whether a loop that reschedules itself every 200 ms while cooling down fits within
  `finishAllScheduledFunctions`' default of 100 steps. To check when porting the tests.

## 7. Questions for the owner

All decided by the owner on 2026-10-27, as recommended.

| # | Question | Recommendation |
|---|---|---|
| B-1 | `vBatchQueryArgs`, `vBatchResult` and `vWorkerResult`, deprecated since 0.3.0: build them, or leave them out under DV-539. DV-539 already lists `vBatchResult`; the other two are the same kind | **Leave them out**, and add the two names to DV-539's row. The bunvex dependents use `defineBatchWorkerValidators` |
| B-2 | The example. Convex's `example/` has a task queue, aggregates, and actions limited through `@convex-dev/rate-limiter` (and static hosting) | **Port the queue and the aggregates as `examples/batch-worker` now.** Add the rate-limited part with `@bunvex/rate-limiter` |
| B-3 | One package for all three dependents, at 0.3.6's behaviour, with no 0.2.x or 0.3.3 variant (§1.8) | **Yes.** Every change since 0.2.2 is additive, and a 0.2.2 row reads the same |
