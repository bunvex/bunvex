# STUDY-30 — Scheduled functions and cron jobs

- **Status:** draft — S1–S3 open
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** platform.md §4–§5, server-api.md §14–§15; STUDY-23 (session requests, the pattern for system
  tables written with app writes); STUDY-28 (built-in auth delivers its email through the scheduler)

## 1. How Convex does it

### 1.1 The API (`npm-packages/convex/src/server/scheduler.ts`, `impl/scheduler_impl.ts`)

- **Methods** on `ctx.scheduler`, which exists on mutation and action contexts only (`registration.ts`
  L118, L401; not queries):
  - `runAfter(delayMs, fnRef, ...args)` and `runAt(timestamp | Date, fnRef, ...args)` return
    `Promise<Id<"_scheduled_functions">>`.
  - `cancel(id)` returns `Promise<void>`.
- **Targets:** mutations and actions, public or internal. The scheduler caller runs with
  `AllowedVisibility::All` (`crates/common/src/types/functions.rs` L286-298).
- **Client checks** (`scheduler_impl.ts` L87-122):
  - `` `delayMs` must be a number ``, `` must be a finite number ``, `` must be non-negative ``;
  - `The invoke time must a Date or a timestamp` (Convex's typo).
  - `runAfter` computes `ts = (Date.now() + delayMs) / 1000` in seconds. `Date.now()` is the frozen time
    inside a mutation.
  - `runAt` takes a `Date` (`valueOf()`) or milliseconds; past times are allowed.
- **Server checks** (`crates/udf/src/validation.rs` L181-251, `async_syscall.rs` L1092-1157):
  - `ts` parses with `Duration::try_from_secs_f64`, so NaN and negative are argument errors;
  - more than 5×366 days ahead: `"{ts} is more than 5 years in the future"`; or behind: `"… in the past"`;
  - the module must exist: `Attempted to schedule function at nonexistent path: {module}`;
  - the export must exist: `Attempted to schedule function, but no exported function {name} found in the file: {module}. Did you forget to export it?`.
  - **The function's kind and its args validator are checked only when the job runs.**
- **Limits per transaction** (`SchedulerModel::check_scheduling_limits`, `crates/model/src/scheduled_jobs/mod.rs`
  L162-196; knobs L500-522):
  - 1000 jobs: `Too many functions scheduled by this mutation (limit: 1000)`;
  - 16 MiB total args: `Too large total size of the arguments of scheduled functions from this mutation (limit: 16777216 bytes)`.
    The docs say 8 MB; the code allows 16 MiB.
  - A 4 MiB per-job size is only a warning (`crates/udf/src/warnings.rs` L117-147).

### 1.2 Transactions and cancel

- **From a mutation**, the job (an `_scheduled_job_args` doc plus a `_scheduled_jobs` doc) is written in
  the mutation's own transaction. It exists only if the mutation commits; a mutation that schedules and
  then throws schedules nothing.
- **From an action**, each call is its own transaction (`application_function_runner/mod.rs`
  L2304-2361). It commits at once, and the limits apply per call.
- **`cancel`** (`mod.rs` L398-412):
  - `pending` or `inProgress` become `canceled` (`completedTs` = now).
  - Finished or missing jobs are a **silent no-op**, although the TSDoc says it throws.
  - An id of another table fails: `Invalid scheduled function ID. The ID must be an ID on the '_scheduled_functions' table.`
  - A scheduled mutation canceling itself fails: `A mutation cannot cancel itself`.
  - Canceling a running action lets it finish, but what it schedules afterwards is inserted already
    `canceled` (`mod.rs` L276-322), and its final state is dropped.

### 1.3 Storage

- **`_scheduled_jobs`** (`types.rs` L140-154): `{udfPath, argsId, state, nextTs?, completedTs?, originalScheduledTs, attempts?}`.
  - The state is `pending | inProgress{requestId, executionId} | success | failed{error} | canceled`.
  - `nextTs` exists only while pending or in progress, and is `max(original, now)` at schedule time.
  - Indexes: `by_next_ts`, `by_udf_path_and_next_event_ts`, `by_completed_ts`.
- **`_scheduled_job_args`:** `{args: bytes}`.
- **Apps see the virtual table `_scheduled_functions`** (`virtual_table.rs` L58-155), through
  `ctx.db.system.get(id)` and `ctx.db.system.query("_scheduled_functions")`, with indexes `by_id` and
  `by_creation_time` only.
  - Its documents: `{_id, _creationTime, name, args: any[], scheduledTime: ms(original), completedTime?, state}`.
  - The state's `type` is renamed `kind`, other fields kept, so in progress reads
    `{kind:"inProgress", requestId, executionId}`.
  - The other system tables are invisible to apps (`ExcludePrivateSystemTables`, `async_syscall.rs`
    L355-361).

### 1.4 The executor (`crates/application/src/scheduled_jobs/mod.rs`)

- **The loop.** It reads `by_next_ts`, ascending, as `Identity::Unknown`. It starts every due job not
  already running, up to `SCHEDULED_JOB_EXECUTION_PARALLELISM` = 8 (knobs L548). Then it sleeps until the
  earliest of:
  - a job finishing;
  - the next `nextTs`;
  - its read set being invalidated (a new job);
  - a 5 s re-poll while behind.
- **Ordering.** Jobs start in `nextTs` order, but they run concurrently, so there is no completion order.
- **Before each attempt** the job is re-read; if it changed at all, the attempt is dropped (L1066-1091).
- **The target is resolved at run time.** A missing function, or a query or HTTP action, fails the job.
  For the wrong kind the message is `Unsupported function type. … Only mutation and action can be scheduled.`
- **Mutations run exactly once** (L732-936). The job goes `inProgress`, visible only to itself; the
  mutation runs; `success` is written **in the same transaction**, which commits.
  - OCC and `TooManyWrites` are retried indefinitely, with backoff from 100 ms to 60 s.
  - A deterministic user error records `failed{error}` in a new transaction.
  - A system error reschedules the job: `attempts.systemErrors++`, `nextTs` = now + backoff (500 ms to 2 h).
- **Actions run at most once** (L938-1063). `inProgress` is committed first, then the action runs, then
  `success` or `failed` is recorded (retried until it sticks).
  - A job found already `inProgress` (after a crash) is recorded
    `failed("Transient error while executing action")`, never re-run.
- **Identity:** none (`Identity::Unknown(None)`). The docs: "auth is not propagated".
- **Logs** go to the function log with the caller `Scheduler{jobId}`.
- **GC** (L1122-1228): completed jobs and their args are deleted after `SCHEDULED_JOB_RETENTION` = 7 days,
  100 per batch.
- **Dashboard** (`dashboard-common/src/features/schedules/`):
  - the `paginatedScheduledJobs` system query lists pending and in-progress jobs (optionally by function);
  - `POST /api/cancel_job` cancels one job;
  - `POST /api/cancel_all_jobs` cancels in batches of 1000, by function or for all.

### 1.5 Cron jobs

**The API** (`npm-packages/convex/src/server/cron.ts`):
- **Builders.** `cronJobs()` returns a `Crons` object with:
  - `interval(id, {seconds|minutes|hours}, fn, args?)`;
  - `hourly(id, {minuteUTC}?, fn, args?)`;
  - `daily(id, {hourUTC, minuteUTC?})`, `weekly(id, {dayOfWeek, hourUTC, minuteUTC?})`, `monthly(id, {day, hourUTC, minuteUTC?})`;
  - `cron(id, "m h dom mon dow")`.
- **Shape.** `export default crons` in `convex/crons.ts`. Each entry is `{name, args: [args], schedule}`.
- **Client errors:**
  - `Invalid cron identifier {s}: use ASCII letters that are not control characters` (`/^[ -~]*$/`);
  - `Cron identifier registered twice: {id}`;
  - `Must specify one of seconds, minutes, or hours`;
  - `Interval must be an integer greater than 0` (no minimum: 1 s is allowed);
  - `Hour of day must be an integer from 0 to 23`, `Minute of hour must be an integer from 0 to 59`,
    `Day of month must be an integer from 1 to 31`;
  - `Day of week must be a string like "monday".` (lowercase only);
  - args not an object: `The arguments to a Convex function must be an object. Received: …`.
- **Server checks at push** (`crates/model/src/cron_jobs/types.rs` `CronSpec::from_exported_json`
  L270-478):
  - the ranges again;
  - the cron string through the `saffron` crate: `The cron spec {cron} will never match any time`;
  - args under 1 MiB: `Cron job args too large`.
  - All of these are `InvalidCron` errors. `validate_cron_jobs` (`application_function_runner/mod.rs`
    L1847-1898) refuses a missing target, a query and an HTTP action.

**The next run** (`next_ts.rs` L53-214):
- **Intervals:** `prevTs + seconds`, anchored to the previous *scheduled* time. A new interval cron runs
  **at once**.
- **Clock schedules** become 5-field cron strings (an omitted minute is 0), evaluated in UTC with saffron.
- **Splay:** without `minuteUTC`, a stable random offset of 0–3600 s; otherwise 0–`CRON_SPLAY_SECONDS`
  (60). It is stored implicitly as `prevTs mod period`.
- **Missed runs:** an overdue cron runs once, late; later missed occurrences are skipped, never replayed.
  - For intervals, the skip logs `SkippingPastScheduledRuns` and writes a `canceled{numCanceled}` run log.
  - Clock schedules just search forward from now.
- **No overlap:** one run per cron at a time.

**Deploy** (`CronModel::apply`, `crates/model/src/cron_jobs/mod.rs` L151-303), diffed by name in the push
transaction:
- **added:** a `_cron_next_run` row is created;
- **updated:** the next run is recomputed only if the *schedule* changed, and only when the old
  schedule's runs are more than 30 s apart;
- **deleted:** the job, its next run and all its logs go.

**Execution** (`crates/application/src/cron_jobs/mod.rs`):
- The same exactly-once rule for mutations (log + advance in the same transaction) and at-most-once for
  actions (`inProgress` committed first; a leftover one gives `Transient error while executing action`).
- No identity, and the same parallelism knob.
- **Tables:**
  - `_cron_jobs {name, cronSpec}`;
  - `_cron_next_run {cronJobId, state, prevTs, nextTs}`;
  - `_cron_job_logs {name, ts (the scheduled time), udfPath, udfArgs, status success{result}|err{error}|canceled{numCanceled}, logLines{logLines, isTruncated}, executionTime}`.
- **Log retention:** the newest **5** logs per cron (a constant). Results and log lines are truncated to
  1000 chars.
- None of these tables are visible to apps. The dashboard reads them with `listCronJobs` (with
  `lastRun`, `nextRun`) and `listCronJobRuns`.

## 2. What an app can observe

The API, errors and limits of §1.1–§1.5:
- Scheduling is transactional from mutations and immediate from actions.
- Exactly once for mutations, at most once for actions. The `failed` messages as listed.
- `_scheduled_functions` through `ctx.db.system`, with its document shape.
- Cancel is a no-op on finished jobs.
- Crons: the schedule semantics (the first interval run at once; missed runs skipped; splay) and no
  identity in scheduled or cron runs.
- **Timing is not part of the contract**: jobs start "soon after" `scheduledTime`, in `nextTs` order, up to
  8 at a time.

## 3. How bunvex does it

### 3.1 Storage: system tables, a projected `_scheduled_functions`

The system tables are `_scheduled_functions`, `_scheduled_job_args`, `_cron_jobs`, `_cron_next_run` and
`_cron_job_logs`. They are created like `_session_requests` and written with `asSystem` inside the
scheduling transaction.

bunvex has no virtual tables, so the job document lives **in `_scheduled_functions` itself**: its public
fields plus internal ones (`nextTs`, `attempts`, `argsId`). `ctx.db.system.get` / `query("_scheduled_functions")`
return it **projected** to Convex's public shape, with only `by_id` and `by_creation_time`. The ids
`runAfter` returns are then real ids of that table, so `cancel`, `db.system.get` and `v.id("_scheduled_functions")`
all work as in Convex. `ctx.db.system` is new (it will also serve `_storage`).

### 3.2 `ctx.scheduler`

- **In a mutation,** the scheduler writes the job through the current `Tx`, so it commits or rolls back
  with the mutation. It counts toward the per-transaction limits (1000 jobs, 16 MiB, as in Convex's
  code).
- **In an action,** each call is one engine mutation.
- **Validation** at schedule time is Convex's: the target exists in the registry; time, delay and ±5 years
  as listed. The kind and the args are checked when the job runs.
- **Names.** `fnRef` comes through `getFunctionName` (`anyApi` / `makeFunctionReference` from
  `@bunvex/protocol`), as for `runQuery`.
- **Cancel** follows Convex: no-op on finished jobs; `A mutation cannot cancel itself`; children of a
  canceled running action are inserted `canceled`.

### 3.3 The executor (`packages/server/src/scheduler.ts`)

It runs in the process that owns the committer (one per deployment, STUDY-24).

- **Wake-ups:** a timer for the earliest `nextTs`; `committer.onCommit` for new jobs, rather than a read-set
  subscription (the effect is the same); and job completion.
- **Parallelism 8,** from `SCHEDULED_JOB_EXECUTION_PARALLELISM`.
- **Mutations:** the job state and the user mutation are written in one engine mutation, so exactly once
  follows from OCC. OCC and system errors are retried with Convex's backoffs; a user error records `failed`
  in a new transaction.
- **Actions:** `inProgress` is committed first, then the action runs, then the result is recorded.
- **At startup,** every job left `inProgress` is recorded `failed("Transient error while executing action")`,
  as Convex does on finding one.
- **No identity** (`callerOf(null)`).
- **GC:** completed jobs after 7 days, on the session-cleanup pattern (batches, rate-limited).
- **Log lines** are captured per run, as for other functions. Until log streaming exists (Phase 4) they go
  to the server's log output, and the cron run logs keep their lines.

### 3.4 Crons

- **`cronJobs()`** is in `@bunvex/server`, with Convex's builders, shape and messages.
- **The cron string parser and next-run computation** are bunvex's own TS code, written to saffron's
  grammar: `*`, lists, ranges, steps, month and day names, and dom/dow OR semantics. They are tested
  against cases taken from saffron's behaviour.
- **Splay** as Convex, with `CRON_SPLAY_SECONDS` (0 turns it off).
- **Tables, run logs** (5 per cron, truncation) and the executor rules: as Convex.
- **Registration (S1):** bunvex has no push yet (CLI and codegen are Phase 3 item 7), so crons are passed
  to the server and diffed against `_cron_jobs` **at startup**, Convex's `CronModel::apply` with startup as
  the push.

### 3.5 Dashboard

Admin-only system functions for the dashboard session to build the screens on:
- **Schedules:** list pending and in-progress jobs, optionally by function; cancel one; cancel all.
- **Crons:** list with last and next run; run history.

### 3.6 PRs

1. **Scheduled functions:** the tables, `ctx.db.system`, `ctx.scheduler`, the executor, GC, the limits and
   errors.
2. **Crons:** `cronJobs()`, the parser and next run, splay, the startup diff, the executor, run logs.
3. **System functions for the dashboard.**

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| S1 | Crons are registered by passing them to the server (`createServer({ crons })`) and diffed at startup, not discovered in `convex/crons.ts` at push | bunvex has no push or analyze step until the CLI (Phase 3 item 7); then `crons.ts`'s default export is discovered, keeping the same API | owner |
| S2 | `_scheduled_functions` is a real system table projected to the public shape, not a virtual table over `_scheduled_jobs` | same documents, ids and indexes for apps; no virtual-table layer to build first | owner |
| S3 | Until log streaming (Phase 4), scheduled and cron runs' log lines go to the server's log output, not a function log; cron run logs are as Convex | bunvex has no function-execution log yet | owner |

Recorded in the ledger as DV-139–DV-141 (pending). Convex's code is followed where it disagrees with its docs: 16 MiB rather than 8 MB, and cancel of a
finished job as a no-op. That matches Convex, so it needs no decision.

## 5. Tests

- **Scheduling:**
  - from a mutation that commits vs throws (the job exists vs not);
  - from an action (it exists even if the action then throws);
  - the limits (1001st job; args over 16 MiB) and every message in §1.1, including ±5 years, a nonexistent
    target, NaN, negative, and a non-Date `runAt`.
- **Execution:**
  - a scheduled mutation runs once even under OCC contention (a counter);
  - a mutation that throws becomes `failed{error}` and its writes are gone;
  - an action runs at most once: kill-and-restart mid-action gives `failed("Transient error while executing action")`;
  - the wrong kind and a deleted target fail at run time;
  - no identity in runs;
  - `nextTs` order; parallelism ≤ 8.
- **`_scheduled_functions`:** the projected shape in each state; `db.system.get` / `query`; cancel in each
  state (no-op when finished); self-cancel; children of a canceled action; GC after retention.
- **Crons:**
  - every builder's validation message;
  - next-run tables per schedule kind (UTC, months without day 31, weekday names);
  - the first interval run at once;
  - missed runs skipped (a `canceled` log for intervals);
  - no overlap;
  - the startup diff (added, updated with the 30 s rule, deleted with its logs);
  - 5 logs kept, truncation at 1000.
- **Through the official client:** a public mutation that schedules, and a subscription seeing the
  scheduled mutation's write.
- **Sabotage** of the transactional write, the exactly-once write, the at-most-once commit and the skip
  loop.
- **Performance:** mutation latency with and without scheduling; executor throughput (jobs/s at
  parallelism 8); the idle cost (no polling).

## 6. Open questions

- Components: per-component namespaces wait for components (Phase 4).
- The dashboard's "pause deployment" (which stops both executors in Convex) waits for the deployment state.
