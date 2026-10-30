# STUDY-199 — `@bunvex/workpool`
<!-- index: `@bunvex/workpool`, the fourth own component (STUDY-158 §3.4 step 4.4) and a prerequisite of `@bunvex/resend` (STUDY-200) and built-in auth's email (STUDY-191): a pool of actions, mutations and queries run at most `maxParallelism` at a time on `@bunvex/batch-worker`'s loop, with retries, `onComplete` callbacks, cancelation, recovery from the scheduler's state and JSON log events; written from get-convex/workpool 0.4.14 | open: W-1–W-5 -->

- **Status:** open, waiting for the owner on W-1–W-5 (§7).
- **Convex source read:** get-convex/workpool at `7fde769` (after 0.4.14), cloned at `../workpool`. Paths are
  relative to that repository's root.
  - The npm release 0.4.14 is the tag commit `358fb20`; [upstream.md](../parity/upstream.md#other-repositories) pins
    `fe6f2b8`. `7fde769` is two commits later and changes behaviour in one place: `generateReport` pages with the
    built-in `.paginate()` instead of convex-helpers' `paginator` (§1.13). `e6d685b` also changes `src/test.ts`
    (`register` returns `registerComponent`'s result). Nothing else under `src/` differs from 0.4.14
    (`git diff 358fb20 7fde769 -- src`). W-1 moves the pin.
- **bunvex source:** `main`, with `@bunvex/batch-worker` (STUDY-196) and `@bunvex/rate-limiter` (STUDY-197). Paths
  are relative to the repository's root.
- **Scope:**
  - STUDY-158 §3.4 step 4.4 (STUDY-158 planned two parts, the data and client, then the loop; one study covers both,
    and the build is split in §3.5);
  - a prerequisite of `@bunvex/resend` (STUDY-200), which mounts two pools (`emailWorkpool`, `callbackWorkpool`),
    and through it of Convex Auth v2's email method (STUDY-191 A-7). The owner chose the order workpool → resend →
    auth (2026-10-29).
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md): Q-1–Q-8, DV-538 (`BunvexError`, the non-retryable marker), DV-539;
  - [STUDY-183](STUDY-183-sharded-counter.md): the package model;
  - [STUDY-196](STUDY-196-batch-worker.md): its child, which runs its loop;
  - [STUDY-197](STUDY-197-rate-limiter.md): the previous component, the same layout.

## 1. How Convex does it

### 1.1 The package (`package.json`)

- **Name** `@convex-dev/workpool`, version `0.4.14`, `"type": "module"`, Apache-2.0. `files: ["dist", "src"]`.
- **Exports:**
  - `.` → `dist/client/index.js` (types `dist/client/index.d.ts`): the client.
  - `./convex.config` and `./convex.config.js` → `dist/component/convex.config.js`: the component definition.
  - `./_generated/component.js` → types only (`ComponentApi`).
  - `./test` → `./src/test.ts` (source, uses Vite's `import.meta.glob`).
  - `./package.json`.
- **Dependencies:** `@convex-dev/batch-worker` `^0.2.2` (a regular dependency).
- **Peer dependencies:** `convex` `^1.36.1`, `convex-helpers` `^0.1.94`.
- **convex-helpers use** at `7fde769`: only `assert` from the package root (`src/component/worker.ts:20`,
  `src/component/complete.ts:15`). At 0.4.14 (`358fb20`) `stats.ts` also imported `paginator` from
  `convex-helpers/server/pagination`.
- **devDependencies** worth knowing for the tests: `convex-test` `0.0.64` (its `defineTestApp`), `vitest` 5,
  `@convex-dev/workpool-old` (`npm:@convex-dev/workpool@0.4.7`, mounted in the example as `oldWorkpool`).

### 1.2 The component (`src/component/convex.config.ts`)

- `defineComponent("workpool")`, with one child: `component.use(batchWorker, {env: {LOG_LEVEL: "REPORT"}})`. The
  child's log level is fixed at `REPORT`, whatever the pool's `logLevel`.
- No env of its own. `_generated/server.ts:120` exports `env` but nothing reads it.
- An app mounts it once per pool: `app.use(workpool, {name: "emailWorkpool"})`. Two `Workpool` instances on the same
  mount share one pool (`src/client/index.ts:68-83`, the constructor's doc).

### 1.3 Constants (`src/component/shared.ts`, `lib.ts`, `loop.ts`, `config.ts`, `complete.ts`, client)

| Name | Value | Where | Use |
|---|---|---|---|
| `SEGMENT_MS` | 100 ms | `shared.ts:15` | a segment: `floor(ms / 100)` as an int64 (`toSegment`, `shared.ts:22-24`) |
| `DEFAULT_MAX_PARALLELISM` | 10 | `shared.ts:12` | `globals.maxParallelism` when unset |
| `MAX_POSSIBLE_PARALLELISM` | 200 | `config.ts:6` | above it, an error |
| `MAX_PARALLELISM_SOFT_LIMIT` | 100 | `config.ts:7` | above it, a warning |
| `WORKER_NAME` | `"main"` | `shared.ts:14` | the batch-worker queue's name |
| `DEFAULT_RETRY_BEHAVIOR` | `{maxAttempts: 5, initialBackoffMs: 250, base: 2}` | `shared.ts:67-71` | `retry: true`, or `retryActionsByDefault` |
| `INLINE_METADATA_THRESHOLD` | 8 000 bytes | `lib.ts:32` | args / context at or above it go to `payload` |
| `MAX_DOC_SIZE` | 1 000 000 bytes | `lib.ts:33` | args or context above it are refused |
| `PAYLOAD_DOC_OVERHEAD` | 78 | `lib.ts:34` | added to `payloadSize` |
| `PAGE_SIZE` | 64 | `lib.ts:155` | `cancelAll`'s default page |
| `CANCELLATION_BATCH_SIZE` | 64 | `loop.ts:33` | cancelations read per iteration |
| `RECOVERY_BATCH_SIZE` | 32 | `loop.ts:34` | jobs per scheduled `recover` |
| `START_BATCH_SIZE` | 32 | `loop.ts:35` | action/query items per scheduled `runBatch` |
| `MAIN_BATCH_SIZE` | 64 | `loop.ts:39` | cap on completions and on starts per iteration |
| `RECOVERY_THRESHOLD_MS` | 5 min | `loop.ts:40` | a running job started earlier is checked |
| `RECOVERY_PERIOD_SEGMENTS` | 600 (1 min) | `loop.ts:41` | how often a recovery iteration happens |
| `STATUS_COOLDOWN` | 2 s | `loop.ts:46` | idle `cooldownMs` |
| `SATURATED_STATUS_COOLDOWN` | 10 s | `loop.ts:49` | idle `cooldownMs` when `running.length >= maxParallelism` |
| `COOLDOWN_CHECK_INTERVAL` | 200 ms | `loop.ts:50` | idle `pollIntervalMs` |
| `CURSOR_BUFFER_SEGMENTS` | 150 (15 s) | `loop.ts:58` | scans start this far behind each cursor |
| `monitorLagMs` | 2 min | `kick.ts:24` | batch-worker config passed on every ping |
| `MAX_BATCH_SIZE` (complete) | 2 000 000 bytes | `complete.ts:67` | jobs handled in one `complete` |
| `MAX_BATCH_SIZE` (client) | 8 000 000 bytes | `src/client/index.ts:643` | items per `lib.enqueueBatch` call |
| `DEFAULT_OLDER_THAN` | 24 h | `danger.ts:5` | `danger` cleanup cutoff |
| `MAX_ROWS_READ` / `MAX_BYTES_READ` | 100 / 4 000 000 | `danger.ts:6-7` | `danger` page limits |
| `DEFAULT_LOG_LEVEL` | `"REPORT"` | `logging.ts:3` | |

### 1.4 The schema (`src/component/schema.ts`)

Seven tables. `segment` is `v.int64()` throughout.

- **`globals`** — `vConfig`: `{maxParallelism: number, logLevel}` (`shared.ts:38-41`). A singleton, read with
  `.unique()`. Written by `getOrUpdateGlobals` on enqueue/cancel and by `config:update`. No index.
- **`internalState`** — a singleton written only by `loop:run`:
  - `generation?: int64`, deprecated: batch-worker owns the generation now; still written as `0n` "for rollback
    compatibility" (`schema.ts:19-21`, `loop.ts:61`).
  - `segmentCursors: {incoming, completion, cancelation}` (segments).
  - `lastRecovery: segment`.
  - `report: {completed, succeeded, failed, retries, canceled, conflicted?: number, lastReportTs: number}`.
    `conflicted` is never written by 0.4.14 code (only accepted).
  - `running: [{workId: id("work"), scheduledId: id("_scheduled_functions"), started: number}]`.
- **`work`** — one row per job until it finishes:
  - `fnType: "action" | "mutation" | "query"`, `fnHandle: string`, `fnName: string`;
  - `fnArgs?: any` (absent when in `payload`), `payloadId?: id("payload")`, `payloadSize?: number`;
  - `attempts: number` (completed attempts);
  - `onComplete?: {fnHandle: string, context?: any, excludeKinds?: ("success"|"failed"|"canceled")[]}`
    (`shared.ts:112-120`);
  - `retryBehavior?: {maxAttempts, initialBackoffMs, base}`;
  - `canceled?: boolean`.
  - No index besides the system ones; `by_creation_time` is used by `cancelAll` and `danger`.
- **`pendingStart`** `{workId, segment}`, indexes `workId [workId]`, `segment [segment]`. Written on enqueue and on
  retry; deleted by the loop when started or canceled.
- **`pendingCompletion`** `{segment, runResult: vResult, workId, retry: boolean}`, indexes `workId`, `segment`.
  Written by `complete`; deleted by the loop. A success is stored as `{kind: "success", returnValue: null}`
  (`stripResult`, `complete.ts:229-234`).
- **`pendingCancelation`** `{segment, workId}`, indexes `workId`, `segment`. Written by `cancel`/`cancelAll`.
- **`payload`** `{args?: record(string, any), context?: any}`. Large args and/or a large `onComplete.context`.

`vResult` = `vRunResult(v.any())` (`shared.ts:75-92`): `{kind: "success", returnValue}` |
`{kind: "failed", error: string}` | `{kind: "canceled"}`.

### 1.5 The component's functions

Public (`ComponentApi`, callable by the app as `components.<name>.*`; all are `"internal"` visibility in the
generated API, as every component function is):

| Path | Kind | Args | Returns |
|---|---|---|---|
| `lib:enqueue` | mutation | `{fnHandle, fnName, fnArgs: any, fnType, runAt: number, onComplete?, retryBehavior?, config: Partial<vConfig>}` | `id("work")` |
| `lib:enqueueBatch` | mutation | `{items: [itemArgs], config}` | `id("work")[]` |
| `lib:cancel` | mutation | `{id: id("work"), logLevel?}` | null |
| `lib:cancelAll` | mutation | `{logLevel?, before?: number, limit?: number}` | null |
| `lib:status` | query | `{id: id("work")}` | `status` |
| `lib:statusBatch` | query | `{ids: id("work")[]}` | `status[]` |
| `config:update` | mutation | `Partial<vConfig>` | null |

Internal (dashboard / CLI / scheduler): `loop:getBatch`, `loop:run`, `loop:main` and `loop:updateRunStatus`
(deprecated forwarders that just ping, `loop.ts:742-758`), `worker:runBatch`, `worker:runMutationWrapper`,
`worker:runActionWrapper` (legacy, `worker.ts:95-114`), `worker:getWorkArgs`, `complete:complete`,
`recovery:recover`, `kick:forceKick`, `stats:calculateBacklogAndReport`, `stats:running`, `stats:diagnostics`,
`stats:scheduledFunctionsInRange`, `danger:clearPending`, `danger:clearOldWork`.

### 1.6 Config (`src/component/config.ts`)

- `validateConfig` (`config.ts:19-31`), only when `maxParallelism` is given:
  - `> 200` → `Error("maxParallelism must be <= 200")`;
  - `> 100` → warning `maxParallelism should be <= 100, but is set to <n>. This will be an error in a future version.`
    (logged at the config's `logLevel`, else `REPORT`);
  - `< 0` → `Error("maxParallelism must be >= 0")`. 0 is allowed and pauses starts.
  - No integer check: `2.5` is accepted (unconfirmed what happens downstream; `slice(0, 2.5)` behaves as 2).
- `getOrUpdateGlobals(ctx, config?)` (`config.ts:39-69`): inserts `globals` with the given values or the defaults
  if missing; otherwise replaces it only when a *given* value differs (`maxParallelism !== undefined`,
  `logLevel` truthy). A config validated as invalid throws before any write.
- `config:update` kicks the loop only when `maxParallelism` is truthy and greater than the previous value
  (previous = stored or 10).

### 1.7 Enqueue (`src/component/lib.ts`)

- `enqueue` (`lib.ts:50-59`): `getOrUpdateGlobals(config)`, then `kickMainLoop(ctx, "enqueue")` (a batch-worker
  `ping`), then `enqueueHandler`.
- `enqueueBatch` (`lib.ts:123-135`): the same once, then `Promise.all` of `enqueueHandler` over the items (ids in
  item order).
- `enqueueHandler` (`lib.ts:60-121`):
  1. `runAt = boundScheduledTime(runAt)` (`shared.ts:155-168`): older than now − 1 year → now, logging
     `console.error("scheduled time is too old, defaulting to now", ms)`; later than now + 4 years → now + **1**
     year, logging `"scheduled time is too far in the future, defaulting to 1 year from now"`.
  2. `getConvexSize(fnArgs) > 1 000 000` → `Error("Function arguments for function <fnName> too large: <n> bytes
     (max: 1000000 bytes)")`. Same for `onComplete.context`: `OnComplete context for function <fnName> too large: …`.
  3. Inline vs `payload`:
     - args ≥ 8 000: `payload {args}` (and `context` too if it is ≥ 8 000); `fnArgs` (and `onComplete.context`)
       removed from the work row; `payloadSize = argsSize + 78 (+ contextSize)`.
     - else args + context ≥ 8 000: `payload {context}`; `payloadSize = contextSize + 78`.
  4. Insert `work {…, attempts: 0}`, then `pendingStart {workId, segment: max(toSegment(runAt), currentSegment)}`.
  5. Event `enqueued` (§1.13).
- Validation happens before any write: an invalid `excludeKinds` (`"running"`) fails the whole call with a validator
  error and nothing is written, `globals` included (`lib.test.ts:79-112`).

### 1.8 Cancel and status (`src/component/lib.ts`)

- `shouldCancelWorkItem` (`lib.ts:238-259`): false (with a warning) when the work row is gone
  (`[cancel] work <id> doesn't exist`) or a `pendingCancelation` already exists
  (`[cancel] work <id> has already been canceled`).
- `cancel` (`lib.ts:137-153`): `getOrUpdateGlobals({logLevel})` (it can overwrite the stored log level, never
  `maxParallelism`); if it should cancel, ping and insert `pendingCancelation {workId, segment: current}`.
- `cancelAll` (`lib.ts:155-198`): reads `work` by `by_creation_time` `<= before ?? now`, newest first,
  `take(limit ?? 64)`; inserts a `pendingCancelation` for each that should be canceled; pings once if any. If the
  page is full, schedules itself (`api.lib.cancelAll`, a public function, `runAfter(0)`) with
  `before = last row's _creationTime` (inclusive, so the boundary row is read again and warned about).
- `status` (`lib.ts:205-226`), in order:
  1. no `work` row → `{state: "finished"}` (also for an id that never existed in this table);
  2. a `pendingStart` → `{state: "pending", previousAttempts: work.attempts}`;
  3. a `pendingCompletion` with `retry: true` → `pending`;
  4. otherwise → `{state: "running", previousAttempts}`. A pending cancelation is not consulted.
- `statusBatch`: `Promise.all` of the same.

### 1.9 The loop: batch-worker's contract (`src/component/kick.ts`, `loop.ts`)

workpool has no scheduling loop of its own (since `e1dccc8`, #211); batch-worker runs it.

- **`kickMainLoop(ctx, source)`** (`kick.ts:15-26`): `ping(ctx, components.batchWorker, {name: "main",
  workQuery: internal.loop.getBatch, workerMutation: internal.loop.run, config: {monitorLagMs: 120 000}})` on
  every enqueue, cancel (that cancels something), completion that inserts a `pendingCompletion`, and
  `config:update` raising `maxParallelism`. `source` is unused. It never reads `internalState` (to avoid OCC).
- **`kick:forceKick`** (`kick.ts:32-42`): `components.batchWorker.lib.stop({name: "main"})` then `lib.start`.
- **`loop:getBatch`** (internal query, args `{name: string}`, returns `vBatchResult(v.object(batchFields))`;
  `loop.ts:128-226`). Run by batch-worker with `useStaleSnapshot`, then again with a dependency before idling.
  1. Reads `globals` (defaults if missing), `internalState` (defaults if missing), `segment = now`.
  2. **Recovery iteration** when `running.length > 0` and `segment - lastRecovery >= 600`: scans from segment 0;
     otherwise from each cursor − 150.
  3. `queryPending` (`loop.ts:326-374`):
     - completions: `pendingCompletion` by `segment >= cursor`, `take(min(maxParallelism, 64))`;
     - cancelations: `take(64)`;
     - starts: `startLimit = min(64, max(0, maxParallelism - running + completions))`; if > 0,
       `pendingStart` by `segment >= cursor` `.filter(workId ∉ completions' and cancelations' workIds)`
       `.take(startLimit + 1)` (a `q.and()` with no operands when both lists are empty).
  4. `starts` = those with `segment <= now`. Work if any completion, cancelation, start, or a recovery iteration:
     returns `{kind: "work", batch: {segment, recovery, completions, cancelations, starts}}` (each item reduced to
     `_id`, `workId`, `segment` and, for completions, `runResult`, `retry`).
  5. Otherwise `{kind: "idle", cooldownMs: 10 000 if running >= maxParallelism else 2 000, pollIntervalMs: 200,
     timeoutMs?}`; `timeoutMs = max(0, min(next future start − now, next recovery − now))`, the recovery term only
     when something runs; omitted when neither applies.
- **`loop:run`** (internal mutation, args = `batchFields`, returns `null`; `loop.ts:234-323`), in one transaction
  nested in batch-worker's `loop:loop`:
  1. `getOrCreateState` (inserts `INITIAL_STATE` if missing), globals, logger.
  2. `handleCompletions` (`loop.ts:380-437`): for each, delete the `pendingCompletion`; not in `running` → log
     `[main] completing <id> but it's not in "running"` and skip; `retry` → `rescheduleJob`: if rescheduled,
     `report.retries++` and event `completed` with status `retrying`; if not (canceled meanwhile), `report.canceled++`
     and queue a `{kind: "canceled"}` completion. Non-retry: `succeeded++` / `failed++`. Then drop all those workIds
     from `running`; `report.completed += removed`.
  3. `handleCancelation` (`loop.ts:442-493`): per cancelation (skipping one already gone): delete it; patch
     `work.canceled = true`; if a `pendingStart` exists, delete it, `report.canceled++`, and queue
     `{workId, runResult: {kind: "canceled"}, attempt: work.attempts}`. A running job is only flagged. All queued
     cancel jobs (from 2 and 3) go to one `runAfter(0, complete:complete, {jobs})`.
  4. Recovery: nothing running → `lastRecovery = now`; else if `batch.recovery` → `handleRecovery`, then
     `lastRecovery = now`.
  5. Starts: `capacity = maxParallelism - running.length`; `batch.starts.slice(0, capacity)` (none if ≤ 0) →
     `handleStart`.
  6. Report once a minute (§1.13).
  7. Cursors: completion → last completion's segment; cancelation → last cancelation's; incoming → last started
     segment, or `now` when there was capacity and no start at all.
  8. `replace` `internalState`; return `null` (batch-worker re-runs at once to drain).
- **`handleStart`** (`loop.ts:540-574`): skips (error log `[main] <id> already running (skipping start)`, leaving the
  `pendingStart`) a workId already running; skips a `pendingStart` deleted meanwhile; deletes the `pendingStart`;
  a missing work row logs `Trying to start, but work not found: <id>`.
- **`beginWorkBatch`** (`loop.ts:576-658`):
  - actions and queries: chunks of 32 → one `runAfter(0, worker:runBatch, {logLevel, items: [{workId, fnHandle,
    fnArgs, payloadId, attempt, fnType}]})`; every item of a chunk shares that `scheduledId` and one `started`.
  - mutations: one `runAfter(0, worker:runMutationWrapper, {…, fnType: "mutation"})` each.
  - event `started` per item; any other `fnType` → `Error("Unexpected fnType <t>")`.
- **`rescheduleJob`** (`loop.ts:665-706`): returns false when a `pendingCancelation` exists (warn
  `[main] <id> in pendingCancelation so not retrying`), `work.canceled`, no `retryBehavior` (warn), or a
  `pendingStart` exists already (error). Else `backoff = initialBackoffMs * base^(attempts - 1)` (attempts already
  incremented by `complete`), `delay = backoff * (0.5 + Math.random())` (`withJitter`, ×[0.5, 1.5)), and inserts
  `pendingStart {segment: toSegment(now + delay)}`. With the defaults the waits are ≈ 250, 500, 1 000, 2 000 ms.

### 1.10 Running the work (`src/component/worker.ts`)

- **`runBatch`** (internal action; `worker.ts:116-134`): `Promise.all` over items: `runOne`, then `completeInline`.
  Up to 32 concurrent `ctx.runAction` / `ctx.runQuery` calls from one action.
- **`runOne`** (`worker.ts:161-200`): args from the item, or `ctx.runQuery(worker:getWorkArgs, {payloadId})` (inside
  the `try`, so a missing payload fails only that item); then `ctx.runAction(fnHandle, args)` or
  `ctx.runQuery(fnHandle, args)`. Success → `{runResult: {kind: "success", returnValue}, runOnCompleteInline: true}`.
  Failure → `{runResult: {kind: "failed", error: formatError(e)}, nonRetryable: isNonRetryableError(e)}` and
  `console.error(e)` at the pool's level.
- **`completeInline`** (`worker.ts:144-159`): `ctx.runMutation(complete:complete, {jobs: [job]})`; if that throws,
  log `[runBatch] completing <id> inline failed, falling back to scheduled onComplete: <e>` and
  `runAfter(0, complete:complete, …)`.
- **`runMutationWrapper`** (internal mutation; `worker.ts:35-82`): args from the item or `payload` (via
  `assert`); `ctx.runMutation(fnHandle, args)` (or `runQuery` for `fnType: "query"`, which the loop never sends here);
  success or failure → `runAfter(0, complete:complete, {jobs: [{workId, runResult, attempt, nonRetryable?}]})`.
  The user's mutation is a nested call: when it throws, its writes roll back and the wrapper commits.
  `runOnCompleteInline` is not set, so a mutation's `onComplete` is always scheduled.
- **`formatError`** (`worker.ts:84-93`): the non-retryable data's `message`, else `e.message` for an `Error`, else
  `String(e)`. The text of `e.message` for an error thrown in a nested call is the platform's (§2, oracle).
- **`getWorkArgs`** (internal query): `payload.args`, `assert`ed.

### 1.11 Completion (`src/component/complete.ts`)

`complete:complete` (internal mutation, `{jobs: [{runResult, workId, attempt, nonRetryable?, runOnCompleteInline?}]}`);
`completeHandler` (`complete.ts:31-227`):
1. No jobs → warn `Trying to complete 0 jobs`.
2. Drop jobs whose work is gone (warn `[complete] <id> is done, but its work is gone`) or whose `work.attempts !==
   job.attempt` (warn `[complete] <id> mismatched attempt number`): this is the exactly-once guard.
3. Split by size (`getConvexSize(job) + getConvexSize(work) + payloadSize`, 2 000 000 per batch); batches after
   the first are scheduled as new `complete` calls.
4. Per job in the first batch:
   - `work.attempts++` and patch it — **before** the next check;
   - a `pendingCompletion` for the work already exists → warn `[complete] <id> already in pendingCompletion`, stop;
   - `retry = failed && !nonRetryable && maxAttempts truthy && attempts < maxAttempts`;
   - not retrying:
     - `onComplete` set and its kind not in `excludeKinds`: context from the row or from `payload.context`; args
       `{workId, context, result: runResult}` (the full return value, not stripped);
       - `runOnCompleteInline` (an action/query success): `ctx.runMutation(handle, args)` nested; if it throws, log
         `[complete] caught error while running onComplete inline for <id>, scheduling instead: <e>` and
         `runAfter(0, handle, args)`;
       - otherwise `runAfter(0, handle, args)`;
       - any other throw is logged `[complete] error running onComplete for <id>` and swallowed;
     - event `completed` (status = result kind, with the onComplete scheduled id if any);
     - delete the `payload` (errors swallowed with a warning) and the `work` row.
   - not canceled → collect `{runResult: stripResult(r), workId, retry}`.
5. If any were collected: ping, then insert each as `pendingCompletion` at the current segment.

Who runs `onComplete`, and how:

| Work | Result | `onComplete` runs |
|---|---|---|
| action / query | success | inline, nested in `complete` (itself run by `runBatch` via `runMutation`); scheduled if it throws |
| action / query | failed (final) | scheduled from `complete` |
| mutation | any | scheduled from `complete` (itself scheduled by the wrapper) |
| any | canceled | scheduled from `complete` (scheduled by the loop) |
| any | recovered failure | scheduled from `complete` (run inside `recover`) |

### 1.12 Recovery (`src/component/loop.ts` `handleRecovery`, `src/component/recovery.ts`)

- At a recovery iteration (≤ once a minute, only while `running` is non-empty), `handleRecovery`
  (`loop.ts:495-535`) takes running entries `started` more than 5 min ago:
  - work row gone and no `pendingCompletion` → removed from `running`, error `[main] <id> already gone (skipping
    recovery)`; with one → debug only;
  - otherwise scheduled as `recover({jobs: [{scheduledId, workId, attempt, started}]})`, 32 per call.
- `recover` (`recovery.ts:38-107`), per job: skip if a `pendingCompletion` exists, the work is gone, or the attempt
  number moved; then `ctx.db.system.get("_scheduled_functions", scheduledId)`:
  - `null` (never existed, or garbage-collected) → `{kind: "failed", error: "Scheduled job not found"}`;
  - `state.kind === "failed"` → that state object as the result (`{kind: "failed", error}`, the scheduler's text);
  - `"canceled"` (e.g. from the dashboard) → `{kind: "failed", error: "Canceled via scheduler"}`;
  - `pending`, `inProgress`, `success` → nothing.
  Then `completeHandler` inline with those jobs (no `nonRetryable`), so a recovered failure **can retry**.
- A long-running action is re-checked every minute after 5 min, each time scheduling a no-op `recover`.

### 1.13 Logging and stats (`src/component/logging.ts`, `stats.ts`)

- **Levels** in order `DEBUG, TRACE, INFO, REPORT, WARN, ERROR` (`logging.ts:7-14`); `shouldLog(config, level)` is
  `index(config) <= index(level)`.
- **`createLogger(level?)`** (`logging.ts:45-94`): default `REPORT`; an unknown level → `Error("Invalid log level:
  <level>")`. `debug` at DEBUG; `info` at ≤ INFO; `warn` at ≤ WARN; `error` always; `time`/`timeEnd` at ≤ TRACE
  (labels like `[main] pendingCompletion(<n>)`, `[main] report`).
- **`event(name, payload)`**: `console.info(JSON.stringify({component: "workpool", event, ...payload}))` at ≤ INFO,
  and at exactly `REPORT` only for `report`. At `WARN`/`ERROR` no event at all.
- The level used is `globals.logLevel` (or the `logLevel` arg passed to scheduled functions). There is no
  `LOG_LEVEL` env for workpool; only the child gets `LOG_LEVEL=REPORT`.
- **Events** (`stats.ts`):
  - `enqueued {workId, fnName, runAt, enqueuedAt}`;
  - `started {workId, fnName, enqueuedAt: work._creationTime, scheduledFunctionId, startedAt, startLag}`
    (`startLag = now − segment start`);
  - `completed {workId, fnName, completedAt, onCompleteScheduledFunctionId, attempts, status}`, status
    `success | failed | canceled | retrying`;
  - `report {completed, succeeded, failed, retries, canceled, [conflicted], lastReportTs, running, backlog,
    failureRate, permanentFailureRate}`; `failureRate = (failed + retries) / completed`,
    `permanentFailureRate = failed / (completed − retries)`, each `toFixed(4)` then a number, 0 when the
    denominator is 0.
- **Cadence** (`loop.ts:281-301`): in `run`, when `now − lastReportTs >= 60 s`. The new `lastReportTs` is the old
  one + 60 s, or `now` if that is more than 30 s stale. The counters reset (and `conflicted` disappears). No report
  while the loop is idle.
- **Backlog** (`generateReport`, `stats.ts:69-106`): only if `shouldLog(level, "REPORT")`. `pendingStart` with
  `cursor.incoming <= segment < now`, one page of `max(maxParallelism, 10)`: done → report with the page's length;
  not done → `runAfter(0, stats:calculateBacklogAndReport, {startSegment: 0n, endSegment, report, running,
  logLevel})`, which reports `backlog = ctx.db.query("pendingStart").count()` (the whole table, future starts
  included). The page is `.paginate({numItems, cursor: null})` at `7fde769`; `paginator(ctx.db, schema)` at 0.4.14.
- **Diagnostics** (internal queries): `stats:running` → `[{workId, scheduledId, fnName ("<unknown>" if gone),
  started, attempts}]`; `stats:diagnostics` → `{canceling, waiting, running: inProgress − pendingCompletion,
  completing, spareCapacity, runStatus}` using `.count()` on three tables and
  `ctx.runQuery(components.batchWorker.lib.status, {name: "main"})` from a query;
  `stats:scheduledFunctionsInRange({startTime, endTimeExclusive})` → `{count ≤ 1000, overflow}` over
  `ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time")`, throwing
  `Error("Invalid scheduled-function time range")` for a non-finite, empty or > 24 h range (benchmark only).

### 1.14 `danger.ts`

Two internal mutations for manual cleanup, logging with the global `console` (not the leveled logger):
- `clearPending({olderThan?, before?})`: walks `pendingStart` by `by_creation_time <= before ?? now − (olderThan ??
  24 h)`, newest first; deletes each `pendingStart`, its `work` and `payload`; stops after 100 rows or 4 MB
  (`getConvexSize`) and reschedules itself with `before`. Logs `Clearing pending before <UTC date>`,
  `Continuing after <i> entries, <bytes> bytes`, `Done clearing pending entries. <i> in the last batch.`
- `clearOldWork({olderThan?, before?})`: the same over `work`, also deleting its `pendingStart`,
  `pendingCompletion`, `pendingCancelation`; debug `cleared <fnName>: <fnArgs> (<tables>)`; logs
  `Clearing old work before …`, `Done clearing old work. …`. Neither touches `internalState.running` nor calls
  `onComplete`.

### 1.15 Errors (`src/component/errors.ts`)

- **`NonRetryableError extends ConvexError<{__convexWorkpoolNonRetryable: true, message: string}>`**
  (`errors.ts:17-28`): `constructor(message, options?)`, `name = new.target.name`, `cause` copied when given.
- `isNonRetryableError(e)`: `instanceof NonRetryableError`, or a `ConvexError` whose `data` has the marker `true`
  and a string `message`, or any object with the marker `true` on itself.
- `getNonRetryableErrorMessage(e)`: the data's `message` (for a `ConvexError`), or the object's string `message`.
- Across a function boundary the class is lost: the worker sees the callee's error as a `ConvexError` with the same
  `data`, so the data check is what matters.
- **Thrown messages** (all plain `Error`): `maxParallelism must be <= 200`, `maxParallelism must be >= 0`,
  `Function arguments for function <fnName> too large: <n> bytes (max: 1000000 bytes)`,
  `OnComplete context for function <fnName> too large: <n> bytes (max: 1000000 bytes)`, `Unexpected fnType <t>`,
  `Invalid log level: <level>`, `Invalid scheduled-function time range`; convex-helpers' `assert` throws an
  `Error` with an empty message. `ConvexError` is used only by `NonRetryableError`.
- **`failed.error` strings workpool makes itself:** `Scheduled job not found`, `Canceled via scheduler`.

### 1.16 The client (`src/client/index.ts`, `utils.ts`)

- **Exports:** `Workpool`, `NonRetryableError`, `isNonRetryableError`, `vLogLevel` (+ `LogLevel`),
  `vRetryBehavior`, `vWorkId` (`v.string()` branded `WorkId`), `vResult`, `vRunResult`, `DEFAULT_RETRY_BEHAVIOR`,
  `vOnComplete` (= `vOnCompleteArgs(v.any())`), `vOnCompleteArgs`, deprecated aliases `resultValidator`,
  `workIdValidator`, `vOnCompleteValidator`, and not-deprecated aliases `vWorkIdValidator`, `vResultValidator`;
  types `WorkId`, `WorkpoolComponent`, `RetryBehavior`, `RunResult`, `RetryOption`, `WorkpoolOptions`,
  `WorkpoolRetryOptions`, `EnqueueOptions`, `OnCompleteArgs`; the free functions `enqueue` and `enqueueBatch`.
- **`new Workpool(component, options)`** — `options` is required (pass `{}`): `maxParallelism?`, `logLevel?`,
  `defaultRetryBehavior?`, `retryActionsByDefault?` (default false). No defaults are applied on the client:
  unset values are not sent, so the stored `globals` stay.
- **`getRetryBehavior`** (`index.ts:551-565`): `retry: true` → `defaultRetryBehavior ?? DEFAULT_RETRY_BEHAVIOR`;
  `false` → none; an object → it; unset → the default if `retryActionsByDefault`, else none. Only
  `enqueueAction`/`enqueueActionBatch` compute it: mutations and queries are never retried by the client (the
  component would retry any `fnType` given a `retryBehavior`).
- **Methods** (ctx = a mutation or action ctx unless noted):
  - `enqueueAction(ctx, fn, args, options?)`, `enqueueMutation`, `enqueueQuery` → `WorkId`;
  - `enqueueActionBatch(ctx, fn, argsArray, options?)`, `enqueueMutationBatch`, `enqueueQueryBatch` → `WorkId[]`;
    one `lib.enqueueBatch` call per 8 MB of items (`getConvexSize` of each item);
  - `cancel(ctx, id)` → `lib.cancel {id, logLevel}`; `cancelAll(ctx, {limit?})` → `lib.cancelAll {logLevel,
    limit?}`;
  - `status(ctx, id)`, `statusBatch(ctx, ids)` (query, mutation or action ctx) → `lib.status{,Batch}`; no config
    sent, despite the `logLevel` doc saying `status` updates it;
  - `defineOnComplete({context?, returnValue?, handler})` → `internalMutationGeneric({args:
    vOnCompleteArgs(context, returnValue), handler})`.
- **`EnqueueOptions`**: `name?` (the logged `fnName`), `onComplete?` (a mutation reference, or `null`),
  `onCompleteExcludeKinds?`, `context?`, and either `runAt?` or `runAfter?` (exclusive in the types). `retry?` for
  actions only.
- **`enqueueArgs`** (`index.ts:567-602`): `fn` that is a string starting with `function://` is used as the handle
  (`fnName = name ?? handle`); else `createFunctionHandle(fn)` and `fnName = name ?? safeFunctionName(fn)`
  (`utils.ts:25-35`: the address's `name`, `reference`, `functionHandle`, else `getFunctionName`). `onComplete` →
  `{fnHandle: createFunctionHandle(onComplete), context, excludeKinds: [...kinds] | undefined}`. `runAt` from
  `getRunAt` (`runAt`, else `now + runAfter`, else now). `config: {logLevel, maxParallelism}` from the class
  options: every enqueue overwrites the stored values that the class sets.
- **`vOnCompleteArgs(context?, returnValue?)`** → `v.object({workId: vWorkId, context: context ??
  v.optional(v.any()), result: vRunResult(returnValue ?? v.optional(v.any()))})`.
- **`./test`** (`src/test.ts`): `register(t, name = "workpool")` registers batch-worker under
  `<name>/batchWorker`, then the component with `import.meta.glob("./component/**/*.ts")`, and returns the
  `ComponentApi`. Default export `{register, schema, modules}`.

### 1.17 What workpool needs from the platform, and bunvex's status

| Feature | Used at | bunvex |
|---|---|---|
| A child component with a bound env (`use(batchWorker, {env: {LOG_LEVEL: "REPORT"}})`) | `convex.config.ts` | supported: `packages/server/src/components.ts:31` (`UseOptions.env`), STUDY-154 |
| `createFunctionHandle` for the app's functions (client) and the component's own (inside `ping`) | `index.ts:579,585`, `kick.ts:19` | supported: `packages/server/src/function-handles.ts`; `FUNCTION_HANDLE_PREFIX = "function://"` (`:18`), so the `startsWith("function://")` check holds |
| Calling a handle: `runAction`/`runQuery` from an action, `runMutation`/`runQuery` from a mutation, into the app | `worker.ts`, `complete.ts:155` | supported (STUDY-158 §3.1; `packages/server/src/functions.ts`) |
| A nested mutation that throws rolls back only its own writes | `runMutationWrapper`, inline `onComplete` | supported (subtransactions, `functions.ts`, STUDY-158 §3.1) |
| `ctx.scheduler.runAfter` with a handle (the app's `onComplete`) and with the component's own refs, returning an `Id<"_scheduled_functions">` | everywhere | supported: `packages/server/src/scheduler.ts`; batch-worker already does it |
| `ctx.db.system.get("_scheduled_functions", id)` and its `state` `{kind: "failed", error}` / `canceled` / … | `recovery.ts:68` | supported: `components/batch-worker/src/component/kick.ts:115`; states in `scheduler.ts:599-723` |
| `ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time")` in a component | `stats.ts:235` | supported per namespace (STUDY-157 PR 1); unconfirmed by a test for the index range |
| `v.id("_scheduled_functions")` in a component's schema and args | `schema.ts:41`, `recovery.ts:9` | supported in schema (`components/batch-worker/src/component/schema.ts:25`); in args unconfirmed |
| `getConvexSize` | `lib.ts`, `complete.ts`, `danger.ts`, client | supported as `valueSize` in `@bunvex/values` (`packages/values/src/value.ts:493`, DV-347) |
| `.count()` on a query initializer (internal in Convex's types) | `stats.ts:119,190-196` | supported: `packages/core/src/tx.ts:3365` (`countTable`, STUDY-107) |
| `.paginate()` in a component mutation (7fde769) | `stats.ts:80-90` | supported: `packages/core/src/tx.ts:1734-1742` (one page per *query*, any number per mutation; commit `83c4d884`, STUDY-186 A8). STUDY-158 G3 ("refused in a component") is out of date |
| convex-helpers `paginator` (0.4.14) | `stats.ts` at `358fb20` | supported: `@bunvex/helpers/server/pagination` (STUDY-181 PR 4) |
| convex-helpers `assert` | `worker.ts`, `complete.ts` | supported: `packages/helpers/src/index.ts:99`, same message behaviour |
| `ConvexError` subclass; its `data` kept across `runAction`/`runMutation`/`runQuery` | `errors.ts` | supported as `BunvexError` (DV-538): `packages/values/src/errors.ts`; the caller gets a `BunvexError` with the same `data` (`functions.ts:381-384`, `app-errors.ts:90-116`, `Symbol.hasInstance`) |
| `.filter()` with `q.and()` of zero operands, `q.neq(q.field(...), id)` | `loop.ts:369-371` | supported: `packages/core/src/filter.ts:171` (`every` over none is true) |
| `ctx.runQuery` from a query into a child component | `stats.ts:197` | supported (`packages/server/src/registration.ts:91`) |
| table-first `db.get/patch/replace/delete(table, id)` | everywhere | supported (`packages/core/src/database-types.ts`) |
| `withIndex("by_creation_time", q => q.lte("_creationTime", t))` on component tables | `lib.ts:167`, `danger.ts` | supported (system index) |
| `VObject.partial()`, `VUnion.members`, `schema.tables.x.validator.fields` | `lib.ts:48`, `logging.ts:27`, `stats.ts:114` | supported: `packages/values/src/validators.ts:298,360`; `packages/core/src/schema.ts:177` |
| `Math.random` in a mutation (jitter), `Date.now()` in a query | `loop.ts:709`, `getBatch` | supported (deterministic per execution, STUDY-158 §3.1) |
| `console.time` / `timeEnd` | logger at TRACE | supported: `packages/server/src/logs.ts:472` |
| `getFunctionAddress`, `getFunctionName`, `internalMutationGeneric` | `utils.ts`, `index.ts:381` | supported: `packages/server/src/index.ts:91-92,161`; `packages/protocol/src/api.ts:178` |
| Up to 32 concurrent nested `runAction`s from one action | `runBatch` | supported, with Convex's limiter: each nested action takes a permit of `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` (64, `packages/server/src/action-permits.ts`); how a saturated pool waits for permits is §6 |
| `useStaleSnapshot`, `globalThis.Convex` syscalls, `ctx.meta`, `commitTs` | — | not used by workpool itself (batch-worker uses `useStaleSnapshot`) |
| A test harness with `defineTestApp`, a nested child registered under `<name>/batchWorker` | `src/client/index.test.ts`, `src/test.ts` | **gap for the tests:** `@bunvex/testing` has `registerComponent` and `finishAllScheduledFunctions` (`packages/testing/src/harness.ts:450,483`) but no `defineTestApp`; the child comes with the definition (as rate-limiter's `src/test.ts`) |

### 1.18 What workpool uses of batch-worker, and bunvex's batch-worker

| Feature | workpool | `components/batch-worker` |
|---|---|---|
| client `ping(ctx, component, {name, workQuery, workerMutation, config})` | `kick.ts:19` | yes: `src/client/index.ts:64` |
| `config.monitorLagMs` (120 000) | `kick.ts:24` | yes (`shared.ts` `vConfig`) |
| `vBatchResult(batch)` as `getBatch`'s `returns` | `loop.ts:130` | **not built** (DV-539, STUDY-196 B-1): use `defineBatchWorkerValidators({batch}).vQueryReturns`, which adds `cursor?` to the work branch (`shared.ts:74-94`) |
| `BatchResult<Batch>` type | `loop.ts:3` | yes (with a cursor type parameter) |
| the work query called with `{name}` (no cursor stored, so none passed) | `getBatch` args `{name}` | yes: the cursor is passed only when stored (`loop.ts` `queryArgs`) |
| `{kind: "work", batch}` detected | `getBatch` | yes (`"batch" in result`) |
| idle hints `cooldownMs`, `pollIntervalMs`, `timeoutMs` | `getBatch` | yes (`loop.ts`) |
| the worker mutation returning `null` → re-run at once | `run` | yes (`ret?.debounceMs ?? 0`) |
| `useStaleSnapshot` work query, the dependency re-read before idle, the generation guard, the monitor | implicit | yes (STUDY-196 §1.4-1.5) |
| `lib.stop`, `lib.start` | `forceKick` | yes (`lib.ts:27,33`) |
| `lib.status` | `stats:diagnostics` | yes (`lib.ts:46`) |
| env `LOG_LEVEL` | `convex.config.ts` | yes (`bunvex.config.ts`) |
| cursors, `debounceMs`, `kick`, `getCursor`/`setCursor` | not used | (present) |

### 1.19 Its tests

- `src/component/setup.test.ts`: `setupTest()` (convex-test with the schema, the modules and batch-worker
  registered); an empty test.
- `src/component/config.test.ts` (1): `getOrUpdateGlobals` inserts, then updates `maxParallelism`/`logLevel`.
- `src/component/logging.test.ts` (3): `shouldLog` ordering.
- `src/component/errors.test.ts` (4): `isNonRetryableError` for the subclass, for `ConvexError` data from a nested
  mutation, for a marker-only object; not for ordinary errors.
- `src/component/kick.test.ts` (2): `kickMainLoop` leaves batch-worker `running` from every source, even saturated.
- `src/component/lib.test.ts` (16): enqueue (exclusions stored as given, invalid kinds rejected before any write,
  the parallelism errors), cancel (queues, no duplicate, unknown work), `cancelAll` (batches and self-scheduling),
  `status` in each state.
- `src/component/loop.test.ts` (~20): forward progress, one `runBatch` per 32 action/query starts, capacity
  (never above `maxParallelism`, overflow later, none when already above), retry and canceled retry, cancellation
  (pending, running, finished), `getBatch` (idle, 10 s/2 s cooldowns, work, `timeoutMs` for future work and for the
  next recovery), the recovery iteration, the deprecated `loop:main`/`updateRunStatus` forwarders.
- `src/component/complete.test.ts` (12): success, a vanished payload, retry, non-retryable, max attempts, canceled,
  pings when saturated, `onComplete` called, several jobs, attempt mismatch, duplicate completions.
- `src/component/recovery.test.ts` (8 + 15 parameterized): each skip rule; missing / failed / canceled scheduled
  jobs, each against five `excludeKinds` modes (patching `ctx.db.system.get`); batches; other states ignored.
- `src/component/stats.test.ts` (4): no report above `REPORT`; a small backlog reported inline; a large one via
  `calculateBacklogAndReport`; its count.
- `src/component/stateMachine.test.ts` (~45): every transition between the states S1–S12 for the loop, `complete`,
  `cancel` and recovery; garbage-collected `scheduledId`s (issue #225); invalid states; interleavings. Three are
  named "BUG" and assert today's behaviour (§2.3).
- `src/client/index.test.ts` (~25 + type tests): end to end through `defineTestApp`, with real callback functions:
  every `onCompleteExcludeKinds` filter × result, retries, `NonRetryableError`, cancel while pending / during backoff
  / while running (an `actionGate` promise holds the action), `cancelAll` in batches, large contexts via `payload`,
  omitted context, batch enqueues, a throwing callback, invalid kinds, `onComplete: null`; type tests for
  `vOnCompleteArgs`, `runAt`/`runAfter` exclusivity and the generated API.
- `example/convex/example.test.ts` (5) and `example/convex/test/nonRetryable.test.ts` (1): the example app.

Porting notes: the client tests rely on convex-test's `defineTestApp`, a `vi.fn` spy inside a function and a
module-level `actionGate` shared between the test and an action; `recovery.test.ts` monkeypatches
`ctx.db.system.get` inside `t.run`. Each needs a check against `@bunvex/testing` (unconfirmed).

## 2. What an app can observe

STUDY-158 §2 applies. For workpool:

### 2.1 The contract

- **The client API** of §1.16: names, option names, the absence of client defaults, `retry` resolution, the return
  shapes, the exported validators (`vWorkId` is a plain string validator; `vOnCompleteArgs` makes `context`
  `optional(any)` when no validator is given).
- **The component**: the name `workpool`, its child `batchWorker` with `LOG_LEVEL=REPORT`, the seven tables and
  their indexes (§1.4, so an export imports unchanged, including `internalState.generation` and
  `report.conflicted`), the public function paths and validators (§1.5), the internal paths a scheduled job in an
  export may name (`worker:runBatch`, `worker:runMutationWrapper`, `complete:complete`, `recovery:recover`,
  `lib:cancelAll`, `stats:calculateBacklogAndReport`, `danger:*`; plus batch-worker's `loop:loop`,
  `monitor:monitor`).
- **The lifecycle:** enqueue → `pending` → `running` → `finished`; a retry shows `pending` again with
  `previousAttempts` up by one; `finished` for anything gone.
- **`onComplete`**: called at most once per job (barring the inline-throw case below), with `{workId, context,
  result}`; never for an intermediate failed attempt; filtered by `excludeKinds`; `canceled` only when the
  cancelation lands before the start or before a retry; a running attempt ends with its own result.
- **Timing:** 100 ms segments; the retry formula and jitter; the 2 s / 10 s cooldowns and 200 ms polling (via
  batch-worker); recovery after ≥ 5 min, checked once a minute; the monitor's 2 min lag; the report once a minute.
- **Limits:** `maxParallelism` 0–200 (warning above 100); args and context ≤ 1 000 000 bytes each.
- **Errors:** the messages of §1.15; `NonRetryableError`'s data (DV-538 renames the marker to
  `__bunvexWorkpoolNonRetryable`).
- **Logs:** the leveled lines and the four JSON events with `component: "workpool"` (§1.13). Log pipelines parse
  them (the README's Axiom queries).

### 2.2 Corrections to STUDY-158 §1.2–§1.4

- "convex-helpers `paginator`": true at 0.4.14 only; at `7fde769` workpool pages with the built-in `.paginate()`
  and still uses convex-helpers for `assert`. bunvex supports both.
- "Only actions are retried": true of the client; the component retries any `fnType` that carries a
  `retryBehavior`.
- "±50% jitter": confirmed, ×`(0.5 + Math.random())`.
- "Recovery after 5 min": a running job started ≥ 5 min ago is checked at the next recovery iteration (≤ once a
  minute, only while something runs); a recovered failure goes through the retry rules.
- "An unknown id reads as finished": for an id of the `work` table; any other string fails `v.id("work")`.
- "A pending cancelation reads as `running`": only when there is no `pendingStart`. A pending job with a pending
  cancelation reads `pending` until the loop processes it.
- "`logLevel` and `maxParallelism` are overwritten by every caller": by every *enqueue* that has them on the class;
  `cancel`/`cancelAll` overwrite only `logLevel`; `status` overwrites nothing (its doc says otherwise).
- "a `report` about once a minute": only while the loop runs; none while idle.
- Missing from the platform list: function handles of the app called from component actions and mutations,
  nested-mutation rollback, `db.system.query` with `by_creation_time`, `ctx.runQuery` from a query, error data
  across calls, the child's env binding.

### 2.3 Quirks an oracle will show

Found while reading; each is what 0.4.14 does.

- **Duplicate `complete` with the right attempt** increments `work.attempts` before it notices the existing
  `pendingCompletion` (`complete.ts:111-120`; `stateMachine.test.ts:596`, `:873`, named "BUG").
- **Two `pendingCancelation`s for one work** crash the loop iteration with a delete of a missing document
  (`stateMachine.test.ts:1046`, "BUG"); `cancel` normally prevents the duplicate. The exact interleaving under
  `Promise.all` may differ on bunvex.
- **A success `onComplete` that throws runs twice** for actions and queries: inline (rolled back), then scheduled
  (`complete.ts:153-165`).
- **`maxParallelism: 0`** pauses starts *and* completions: `take(min(0, 64))` reads none, so finished jobs stay in
  `running`, and a retry stays `pending` (§1.9 `queryPending`).
- **`boundScheduledTime`**: a `runAt` beyond 4 years becomes now + 1 year; older than 1 year becomes now.
- **`cancelAll({limit: 1})`** re-reads the same row each page (`lte` on `_creationTime`) and keeps rescheduling
  itself while that work exists; **`limit: 0`** throws a `TypeError` reading `_creationTime` of `undefined`
  (`lib.ts:190-195`).
- **Backlog**: the inline count excludes future starts, the scheduled one counts the whole `pendingStart` table
  (`stats.ts:80-128`), so the `report.backlog` meaning changes with size.
- **`report.canceled`** counts only cancelations before a start and prevented retries, not canceled running work.
- **`report.conflicted`** is never incremented; it vanishes from the row at the first reset.
- **`enqueueQuery`'s doc** says the query runs in a mutation; since 0.4.9 it runs from `runBatch`, an action.
- **`WorkpoolOptions.logLevel`'s doc** says `status` updates it; it does not.
- **README**: the status shape is `{state: …}`, not `{kind: …}`; `pool.status(args.id)` lacks `ctx`.
- **Shared `scheduledId`**: all items of one `runBatch` record the same `scheduledId`; if that action dies, every
  item still open is recovered as failed with the same error.
- **A long action** (`inProgress` past 5 min) makes each recovery iteration schedule a `recover` that does nothing.
- **`failed.error` texts** come from the platform for nested-call errors (`e.message` of what `runAction`,
  `runQuery`, `runMutation` throw) and from the scheduler for recovered jobs. convex-test gives `"work failed"`;
  Convex's backend may prefix (`Uncaught Error: …`) or add a request id (unconfirmed). This is the main thing a
  differential test must compare.
- **No integer check** on `maxParallelism` (`2.5` accepted).
- **A `pendingStart` for a work already running** is left in place and re-read every iteration, so the loop spins
  until that work completes (`stateMachine.test.ts:856`; unreachable in normal use).
- **Cursor buffer**: a `pendingStart` committed more than 15 s behind the incoming cursor is found only by a
  recovery iteration, which happens only while something runs (`loop.ts:139-159`; README of the component).

### 2.4 Rule 5 (no "convex" in shipped code)

Occurrences in workpool's shipped code (outside comments and docs), for the owner:

| Where | Occurrence | Kind | Note |
|---|---|---|---|
| `src/component/errors.ts:3` | `"__convexWorkpoolNonRetryable"` | data key an app can see | DV-538: `__bunvexWorkpoolNonRetryable` |
| `src/component/errors.ts:17,34,48` | `ConvexError` | identifier (base class) | DV-538: `BunvexError` |
| `lib.ts:1,67,77`, `complete.ts:2,76-77`, `danger.ts:1,29,86-89`, `src/client/index.ts:15,653` | `getConvexSize` | identifier | DV-347: `valueSize` |
| `src/test.ts:2,22,24` | `TestConvex` | type from convex-test | `@bunvex/testing`'s `TestBunvex` |
| `src/component/convex.config.ts` and the exports `./convex.config`, `./convex.config.js` | file and subpath names | package surface | bunvex's `bunvex.config.ts` / `./bunvex.config.js` (DV-533, as batch-worker) |
| `package.json` | name `@convex-dev/workpool`, dependency `@convex-dev/batch-worker`, keyword `convex`, `homepage`/`bugs` URLs on convex.dev | package metadata | `@bunvex/workpool`, `@bunvex/batch-worker` (Q-2) |
| imports from `convex/server`, `convex/values`, `convex-helpers` | module specifiers | imports | `@bunvex/server`, `@bunvex/values`, `@bunvex/helpers` |

No error message, log line or event names Convex: the event's `component` is `"workpool"`. Comments and doc
comments mention Convex (`index.ts:160-161`, `stats.ts:20` with a github.com/convex URL, the component README);
those are allowed but ship in `.d.ts`/`src`, and a rewrite has its own.

## 3. How bunvex does it

### 3.1 The package

STUDY-183's model, as STUDY-196 and STUDY-197:
- `components/workpool/`, version 0.1.0, with a README naming workpool 0.4.14 (`7fde769`);
- `src/component/{bunvex.config.ts, schema.ts, shared.ts, config.ts, lib.ts, kick.ts, loop.ts, worker.ts,
  complete.ts, recovery.ts, stats.ts, logging.ts, errors.ts, danger.ts}` and `_generated/`;
- `src/client/index.ts`, `src/client/utils.ts` and `src/test.ts` (`register(t, name = "workpool")`, as
  rate-limiter's: the child comes with the definition);
- `@bunvex/batch-worker` as a regular dependency, mounted as the child with `env: {LOG_LEVEL: "REPORT"}`;
- `@bunvex/helpers` for `assert`, as a dependency (Convex's is a peer of `convex-helpers`; bunvex's components depend
  on `@bunvex/helpers` directly, STUDY-196).

The export map is STUDY-183's: `.`, `./bunvex.config`, `./bunvex.config.js`, `./_generated/component.js`, `./test`.

### 3.2 The platform is ready

Every feature of §1.17 is in bunvex, each with the file that provides it. Two things in that table are checked by
the build's tests, not assumed:
- `v.id("_scheduled_functions")` in a component function's arguments (`recovery:recover`);
- `db.system.query("_scheduled_functions").withIndex("by_creation_time", …)` with a range, in a component
  (`stats:scheduledFunctionsInRange`).

If either fails, the fix is its own PR, as #923 was for rate-limiter.

### 3.3 Written from scratch

It follows §1 with Convex's names, paths, tables, validators, defaults, constants, messages, log lines and events,
and keeps every quirk of §2.3 (an app moving between the two sees the same pool). The renames are those already
decided:
- DV-538: `NonRetryableError extends BunvexError`, with the marker `__bunvexWorkpoolNonRetryable` in its `data`;
  `isNonRetryableError` checks `instanceof BunvexError` and the data;
- DV-347: `valueSize` for `getConvexSize`;
- DV-533: `bunvex.config.ts` and `./bunvex.config.js`;
- DV-539 and W-2: `getBatch` declares batch-worker's `vQueryReturns`.

The deprecated surface is not built (DV-539, STUDY-158 Q-4): the forwarders `loop:main`, `loop:updateRunStatus`
and `worker:runActionWrapper`, and the aliases marked `@deprecated` (`resultValidator`, `workIdValidator`,
`vOnCompleteValidator`). A Convex export holding a pending job of an older version fails as a missing function, as
DV-539 says. The aliases `vWorkIdValidator` and `vResultValidator`, which 0.4.14 marks "not deprecated yet", are W-5.

### 3.4 Tests

- **The upstream tests, ported** (§1.19) to `@bunvex/testing`, with its virtual clock for vitest's fake timers:
  `config`, `logging`, `errors`, `kick`, `lib`, `loop`, `complete`, `recovery`, `stats`, `stateMachine` (the three
  "BUG" cases assert the same behaviour), and the client's; not the deprecated forwarders' cases (DV-539).
  - The client tests use convex-test's `defineTestApp`: they run on an app fixture that installs the package by its
    name, as rate-limiter's client tests do.
  - A spy inside a function, and the `actionGate` promise shared between the test and an action: `t.run` inline
    functions run in the test's realm (STUDY-159), so a module-level gate works if the action is defined in the
    test's file; otherwise a table row is the gate. Checked while porting.
  - `recovery.test.ts` patches `ctx.db.system.get` inside `t.run`; the same is done with a scheduled function's real
    states (canceling or failing it), which needs no patching.
- **More:**
  - every message of §1.6–§1.15, and each `failed.error` text;
  - `onComplete` in every row of §1.11's table, including the inline throw that runs it twice;
  - a pool of 200 actions draining with `maxParallelism` 200 under the 64-action limiter (§6);
  - recovery from a dead `runBatch` with several items sharing its `scheduledId`.
- **A differential test.** The same app runs `@convex-dev/workpool` 0.4.14 on Convex's binary and `@bunvex/workpool`
  on bunvex. They compare:
  - `status` through each job's life, and `onComplete`'s arguments, in order per job;
  - the `failed.error` text of an action, a mutation and a query that throw, a `NonRetryableError`, and a recovered
    job (the main unknown, §2.3);
  - the errors of §1.15, word for word;
  - the component's rows once the pool settles (ids and times normalized);
  - the JSON events' fields.
  Retry delays and segments are compared by their bounds, since jitter is random on each side.
- **Sabotage checks:** the `maxParallelism` cap, the retry decision (`attempts < maxAttempts`), the exactly-once
  attempt guard, the cancel-before-start path, and the recovery of a missing scheduled job.

### 3.5 The build, in PRs

1. The component and the client, with the ported tests and the differential test.
2. The example (W-4).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| W-2 | `loop:getBatch` declares batch-worker's `vQueryReturns`, whose work branch has an optional `cursor`, where Convex's declares `vBatchResult` (which bunvex's batch-worker does not build, DV-539) | DV-539; only the function's declared return validator shows it (the dashboard's function spec) | open |

Beyond W-2, the renames of DV-538, DV-347 and DV-533 (§3.3).

## 4b. Additions

None.

## 5. Tests

As §3.4, once built.

## 6. Not verified yet

- **`failed.error` on Convex's backend.** convex-test gives `"work failed"`; the backend's text for an error from a
  nested `runAction`, `runMutation` or `runQuery`, and a scheduled function's `{kind: "failed", error}`, are read in
  the differential test first. bunvex's nested-call messages already match Convex's (STUDY-41, #935).
- **A saturated pool under the action limiter.** With `maxParallelism` above 64, `runBatch` actions and the actions
  they call compete for the 64 permits. On Convex, a nested `runAction` that waits past
  `APPLICATION_ACTION_SEMAPHORE_TIMEOUT` fails (unconfirmed for nested calls); bunvex's limiter follows Convex's. The
  differential test runs a pool at 100.
- **The interleaving of `Promise.all` writes** in `enqueueBatch` and `runBatch`: bunvex runs a function's database
  calls in the order they are made, as Convex does; the "BUG" case with two cancelations is checked against the
  oracle, not only against upstream's test.

## 7. Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| W-1 | The pin: move [upstream.md](../parity/upstream.md#other-repositories)'s workpool row from `fe6f2b8` to `7fde769`, two commits after 0.4.14, whose report pages with `.paginate()` | **Yes.** It is the code Convex ships next, and bunvex already allows paging in a component (§1.17). The behaviour is otherwise 0.4.14's, and the differential test still runs 0.4.14 from npm, where the report's page is the same |
| W-2 | `getBatch`'s declared return validator (§4): batch-worker's `vQueryReturns` instead of `vBatchResult` | **Accept**, extending DV-539. Building `vBatchResult` back into batch-worker only to change a declared validator would undo B-1 |
| W-3 | The quirks of §2.3 (a duplicate `complete` raising `attempts`, two cancelations crashing an iteration, a throwing success `onComplete` run twice, `maxParallelism: 0` stopping completions, `cancelAll({limit: 0})`'s `TypeError`, …) | **Keep them all**, as rate-limiter's quirk: match Convex by default, with the oracle as judge. Each is a candidate for an upstream issue, not a bunvex fix |
| W-4 | The example: Convex's `example/` (≈1 500 lines: several pools, a crons file, a React page; it also mounts workpool 0.4.7 as `oldWorkpool` and static hosting) | **Port it as `examples/workpool`, after the package**, without the old version and static hosting (as batch-worker's): its e2e test is the end-to-end check of the pools, retries and callbacks |
| W-5 | `vWorkIdValidator` and `vResultValidator`: 0.4.14 exports them as "Older name, not deprecated yet" (`src/client/index.ts:55-57`), but STUDY-158 §3.3 counted `vWorkIdValidator` among DV-539's deprecated aliases | **Build both.** They are current names an app may import, two lines each; DV-539 covers the deprecated surface, and STUDY-158 listed one of them by mistake |
