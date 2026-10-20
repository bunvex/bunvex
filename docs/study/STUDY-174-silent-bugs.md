# STUDY-174 — Catching silent bugs: invariants, a soak test, metadata differentials

- **Status:** decided (owner, 2026-10-19: §8 Q1–Q5 as recommended, §10). F4 is fixed (§10.2); the other findings of
  §3.3 are listed, not fixed. The soak nightly (Q1, §9 step 5) is `.github/workflows/soak-nightly.yml`, with R1
  report-only until Q6 is decided (§10.3). Q7 (R8 on low-rate operations) is decided and done (§10.3).
- **Why now:** [#751](https://github.com/bunvex/bunvex/pull/751) found that since 2026-10-03 every cached query result
  expired after 17 s. [STUDY-58](STUDY-58-app-metrics.md)'s `AppMetrics` read the deterministic `Date.now` inside each
  query's execution, which marked every result as having read the clock. Every answer stayed correct, the tests and
  benchmarks ran for seconds, and nothing asserted how the cache behaves over time. The vm-vs-process parity test of
  #750 ([STUDY-171](STUDY-171-function-sandbox-seam.md) §8–9) found it because it compares more than values: the
  read set and `ctx.meta`'s transaction metrics. This study asks how to catch that class on purpose: bugs that give
  correct answers but degrade the system over time or under load.
- **Convex source read:** get-convex/convex-backend at `72ce13c`, the reference since
  [STUDY-173](STUDY-173-convex-reference-2026-10-10.md) (`precompiled-2026-10-10-72ce13c`, also the differential's
  oracle binary). Every line below is cited at that commit (`git -C ../convex-backend show 72ce13c:<path>`).
- **bunvex code read:** `main` at `016dfccb` (after #749), before #751 merged. Every probe, prototype run and soak
  pilot below ran on that pre-#751 build. #751 (with #750) is now on main at `7683a19a`, which fixes F1. This branch
  was then merged with main, and the prototype re-run there: it passes (§5.3).
- **Related:**
  - the differential: [STUDY-122](STUDY-122-differential-testing.md);
  - the Jepsen nightly: [STUDY-57](STUDY-57-linearizability-testing.md), `.github/workflows/jepsen-nightly.yml`;
  - the coverage floors: `scripts/coverage-floors.ts`;
  - the cache: [STUDY-08](STUDY-08-cache-and-subscriptions.md), [STUDY-75](STUDY-75-sync-cache-hit-logs.md);
  - the function log: [STUDY-47](STUDY-47-log-streaming.md); read counting: [STUDY-161](STUDY-161-engine-messages.md) §16 (#704).
  - Test hardening is another session's track (bunvex-9f). Every proposal here that touches the differential, the
    Jepsen nightly or the coverage floors is framed as an extension of them, not a replacement.

**In one paragraph.** bunvex's test layers check answers: values, errors, histories, final data, lines covered,
mutants killed. None of them checks how a resource behaves over time. We found no RSS or heap trend, no count of
timers or handles, and no cache hit rate in any CI or nightly job. This study proposes three cheap layers to close
that gap:
- **(1) Invariant assertions.** §3 lists 32 of them by subsystem. Ten were probed against main before #751 merged.
  Five did not hold; F1 is now fixed by #751, the other four still stand:
  - F1: #751's cache expiry (fixed on main by #751 since these probes ran).
  - F2: an idle scheduler runs about 2 000 queue queries a second when its next job is more than 24.8 days away.
  - F3: the same for a cron, such as a monthly or yearly one.
  - F4: a cache hit's log entry does not describe the run it reused, as Convex's does.
  - F5: `shutdown()` hangs while a scheduled mutation keeps losing OCC races.
- **(2) A soak test.** `bench/soak/` has a 45-minute mixed workload judged on trends by twelve written rules. Its
  pilots on the test VPS (12, 12, 30 and 25 minutes) flagged F1 and F2 on their own, with no knowledge of either. They
  also found a sixth, F6: resident memory grows about 5 MB a minute under steady load while the JS heap stays flat
  (§4.6). F6 is now attributed (§4.7): a plateau, not a leak. It is SQLite's page cache, which bunvex sizes at
  256 MiB, filling as the database file grows; it levels off at that budget. §4.8 measures what SQLite's default,
  Convex's, would cost in read speed: ~20 % on reads whose working set is past 2 MiB but in memory, nothing when
  the disk is the bottleneck. Q6 is open again, with the numbers.
- **(3) Metadata differentials against Convex's binary.** A prototype in `packages/differential` compares the query
  cache's hits and misses as the function log stream shows them on both backends. It failed on the pre-#751 main
  exactly where #751 says, and passes on main now that #751 is merged (§5.3).

## 1. How Convex does it

Convex has no soak or invariant suite in the open repository either. Its protections against this class are
structural, and they say what bunvex must match:

- **Time-dependence is recorded, not assumed.** The isolate records whether a query read the clock
  (`observed_time` on the outcome, `crates/isolate/src/client.rs:1115`). Only those results expire: `MAX_CACHE_AGE`,
  `crates/application/src/cache/mod.rs:121`, checked at `:797` and `:807`. A result that read no time stays valid
  until a commit writes into its read set.
- **A cache hit is logged as the run it reused.** In `log_query` (`crates/application/src/function_log.rs:623`), the
  cached outcome's fields are logged as they were: `execution_timestamp: outcome.unix_timestamp` (`:735`),
  `user_execution_time` (`:742`) and `memory_used_mb: outcome.memory_in_mb` (`:747`). `cached_result: was_cached`
  (`:740`) marks the hit. The usage it meters is a `CallType::CachedQuery` (`:705`): no reads, no compute.
- **Long waits are durations.** The scheduler waits until the next job with `rt.wait(next_job_ts − now)`
  (`crates/application/src/scheduled_jobs/mod.rs:315–321`). If it is behind, it re-runs its loop every 5 s. The cron
  executor does the same (`crates/application/src/cron_jobs/mod.rs:185–199`). A tokio sleep takes any `Duration`, so
  a job five years away costs nothing.
- **Shutdown aborts workers.** The scheduler's executor is a spawned task (`rt.spawn("scheduled_job_executor", …)`,
  `crates/application/src/scheduled_jobs/mod.rs:157`). The shutdown chain is:
  - `Application::shutdown` (`crates/application/src/lib.rs:3938`) first calls `self.workers.shutdown()`;
  - that calls `scheduled_job_runner.shutdown()` (`crates/application/src/worker_handles.rs:62`);
  - which shuts down the executor's handle (`scheduled_jobs/mod.rs:169–171`);
  - a tokio handle's `shutdown` is `abort()` (`crates/common/src/runtime/mod.rs:176–177`).

  Nothing waits for a job to win its OCC race.
- **Everything that grows has a knob.** Examples: `UDF_CACHE_MAX_SIZE`, `WRITE_LOG_*_RETENTION`, the function log's
  `MAX_UDF_EXECUTION`, the log sinks' buffers, and `UDF_METRICS_MAX_BUCKETS` (`crates/common/src/knobs.rs`). bunvex
  already copies them (DV-63, DV-128, STUDY-47, STUDY-58).

## 2. What an app can observe

A silent bug changes none of an app's answers. It shows up only as:
- **Cost and latency.** Queries rerun, CPU burns while idle, the p99 drifts.
- **Resources.** RSS, file descriptors, sessions kept after their clients leave.
- **Metadata.** Anything an app, a dashboard or a log sink reads besides the value:
  - whether a call was a cache hit (`cachedResult` in the function log and the log streams);
  - its usage (`usageStats`: documents and bytes read and written) and its user time and memory;
  - its OCC info (`occInfo`, `willRetry`, `mutation_retry_count`);
  - which writes woke which subscriptions (the dashboard's `subscription_invalidations_top_k`);
  - the app metrics (`/api/app_metrics/*`: cache hit percentage, rates, latencies, scheduler lag).

The metadata is the part we can compare with Convex directly (§5). The rest can only be judged against bunvex's own
bounds (§3, §4).

## 3. Invariants inside tests (part 1)

### 3.1 The list

**Where** is the state or the code. **Test today** is the existing test that asserts the invariant, or "none".
**Probe** is the throwaway check run against main for this study (§3.2): **holds** or **VIOLATED**.

| # | Subsystem | Invariant | Where | Test today | Probe |
|---|---|---|---|---|---|
| I-01 | Query cache | A query that reads no time stays cached until a commit writes into its read set | `core/src/engine.ts` `stillValid` (787–802); `server/src/app-metrics.ts:452` | `meta.test.ts` (#751, now on main) | P01 **VIOLATED** on the pre-#751 build (F1, fixed by #751) |
| I-02 | Query cache | A result that read the clock expires after 17 s, and only such a result | `core/src/query-cache.ts:15`, `engine.ts:792` | `core/test/query-cache.test.ts:215` (engine only, not through `createServer`) | P01, P09 |
| I-03 | Query cache | `bytes` equals the sum of entry sizes and stays ≤ `maxBytes`; no `waiting` entry outlives its calls | `query-cache.ts` `set`/`enforceLimit` | `core/test/query-cache-store.test.ts` (unit) | P08 holds |
| I-04 | Query cache | An index, table or component change empties the cache; a run that straddles it stores nothing (`cacheEpoch`) | `engine.ts:757, 982, 3392, 3561` | none | not probed |
| I-05 | Sync | Once every client has closed, the hub is empty: `sessions`, `watchers`, `latest`, `inflight`, `reads`, the inspector's rings | `server/src/sync.ts` `SyncHub` (405–939), `unwatch` (627) | `sync.test.ts:404` (`reads` only) | P02, P08 hold |
| I-06 | Sync | `/metrics` sessions and subscriptions equal what the clients hold, at any time | `server.ts:1033`, `sync.ts:418` | none | soak R5 |
| I-07 | Sync | A silent client is closed after `CLIENT_TIMEOUT_MS`, which frees its session | `sync.ts:1146` | `ws-heartbeat.test.ts:150` | — |
| I-08 | Sync | A resend after a reconnect runs nothing twice | `engine.ts` `sessionMutation` (893–916) | `sync.test.ts:334, 355` | — |
| I-09 | Sync | Memory per idle connection and per subscription stays under a measured budget | `SyncSession` (958) | none | soak (measured, not asserted) |
| I-10 | Sync | A write wakes exactly the subscriptions whose read set it intersects | `ReadSetIndex`, `sync.ts` `onCommit` | `sync.test.ts:404`; `differential/test/dashboard-ops.test.ts` (top_k counts, local only) | §5 |
| I-11 | Rooms | After leave, close and the grace: `rooms`, `bySink`, `graced`, `removedInGrace` and `taps` are empty, and the tick is stopped | `server/src/rooms/hub.ts:195–206` | `rooms-hub.test.ts:228` (one room) | P03 holds (120 churned connections) |
| I-12 | Scheduler | Every job runs exactly once: a mutation exactly once, an action at most once, none lost under contention | `server/src/scheduler.ts` (525, 604–657) | `scheduler.test.ts:283, 312, 437, 443` | P04 holds (200 jobs, half via actions) |
| I-13 | Scheduler | An idle scheduler sleeps until its next job is due, however far away | `scheduler.ts:468` | none | P06 **VIOLATED** (F2) |
| I-14 | Crons | An idle cron executor sleeps until its next run, however far away | `cron-executor.ts:285` | none | P07 **VIOLATED** (F3) |
| I-15 | Scheduler | `shutdown()` finishes promptly, whatever the running jobs are doing | `scheduler.ts:368–374, 633–636, 671–682` | `shutdown.test.ts` (store access only) | P10 **VIOLATED** (F5) |
| I-16 | Scheduler | Lag (ran − due) stays bounded under load and does not trend up | `scheduler.ts` `logStats` (501) | none | soak R9b |
| I-17 | Index backfill | `numDocsIndexed ≤ totalDocs`; a restart from the start resets the count | `core/src/index-worker.ts:229, 267–272` | none | suspected S1 (code read) |
| I-18 | Index backfill | Once backfilled, the index holds exactly the table's documents | `index-worker.ts` | `core/test/index-backfill.test.ts:109, 167` | — |
| I-19 | Buffers | The function log keeps at most `MAX_UDF_EXECUTION` (1000) parts, and no waiter after its poll | `server/src/function-log.ts:233–248` | `function-log.test.ts:310` | P08 holds |
| I-20 | Buffers | Log streams: the buffer stays ≤ `bufferSize` (4096) and each sink queue ≤ its capacity; drops are counted | `log-sinks.ts:405–426` | none | not probed |
| I-21 | Buffers | App metrics: at most 60 buckets per metric, and the name caches stay ≤ 10 000 | `app-metrics.ts:197–204, 464, 482` | `app-metrics.test.ts:68` | — |
| I-22 | Buffers | The write log stays within its retention (30–300 s) and byte bounds | `core/src/committer.ts:95–102, 348` | committer tests (unit) | P08 (660 entries) |
| I-23 | Buffers | The sync inspector forgets an unwatched key; its feed stays ≤ 1024 | `sync-inspector.ts:57, 77` | `invalidation-inspector.test.ts:136` | P08 holds |
| I-24 | Timers | After `shutdown()`, nothing keeps the event loop alive: the process exits by itself | `server.ts:2620–2643` | none | P05 holds (bare, busy, socket left open) |
| I-25 | Timers | No `setTimeout` is given more than 2^31−1 ms; Bun fires it after about 1 ms | `scheduler.ts:468`, `cron-executor.ts:285` (`executor-invalidations.ts:174` caps) | none | F2/F3 |
| I-26 | Handles | File descriptors return to the baseline after uploads, downloads and closed clients | storage, sqlite, sockets | none | soak R7 |
| I-27 | Handles | `LocalSink.send` closes its file when `sync()` throws (otherwise each retry leaks an fd) | `log-sinks.ts:266–271` | none | suspected S2 (code read) |
| I-28 | Handles | `pumpHashing` cancels the body reader when a write throws | `file-storage/src/store.ts:37–47` | none | suspected S3 (code read) |
| I-29 | OCC | A mutation runs at most 1 + `UDF_EXECUTOR_OCC_MAX_RETRIES` (4) times. Each lost attempt is logged with `willRetry` and `occInfo.retryCount` | `engine.ts:283–294, 4029–4044`; `functions.ts:1211–1219` | `core/test/occ.test.ts:21, 65`; `function-log.test.ts:233` | — |
| I-30 | Counters | Read and write counts (`usageStats`, the read limit) equal Convex's | `core/src/tx.ts:518–651`, `read-count.ts` | `usage-database-io.test.ts`; `differential/test/read-count.test.ts` (local only) | §5 |
| I-31 | Counters / log | A cache hit's log entry matches Convex's: `cachedResult`, zero usage, and the user time, memory and timestamp of the run it reused | `functions.ts:1400–1447` | `cache-hit-log-fields.test.ts`; `differential/test/cache-metadata.test.ts` | P09 **VIOLATED** (F4), fixed (§10.2) |
| I-32 | Process | An idle backend uses (almost) no CPU | every loop | none | soak R11 (catches F2) |

How a test asserts each class:
- **Freed state (I-03, I-05, I-11, I-19, I-23).** Read the sizes after the scenario (`hub.sessions.size`,
  `cache.bytes`, `rooms.size`, `functionLog` parts). Unit tests already reach into internals this way, e.g.
  `sync.test.ts:404` reads `sync.reads.size`. A cheaper, more general form for the server's tests: an `afterEach` in
  the server suites that asserts a closed server's hub is empty. That is one helper next to `v1-client.ts`, used by
  every suite that opens sessions.
- **Over-time behaviour (I-01, I-02, I-13, I-14, I-16).** Inject the clock. The engine has `cacheClock`
  (`meta.test.ts` skews it by 17 s). The scheduler and crons take `wallClock()` from core's runtime (STUDY-132).
  Then assert counts: runs of a query, engine queries per second while idle.
- **Process-level (I-24, I-26, I-32).** Run in a child process. Assert it exits by itself, its CPU over an idle
  window, and its `/proc/<pid>/fd` count. These are what the soak (§4) measures. A short form fits a test:
  `server/test/idle-cpu.test.ts` could spawn a backend with a far-future job and a yearly cron, and assert under
  5 % CPU over 2 s.
- **Static (I-25).** A rule in `scripts/check-deps.ts`, rule 6 next to rule 5's comment-stripping scan, so CI's
  `check:deps` fails on a new one. The rule: in `packages/*/src`, a `setTimeout(`, `Bun.sleep(` or `timers.set(`
  whose delay subtracts a clock (`- wallClock()`, `- Date.now()`, `- performance.now()`, `- now`) must take it from
  one capped helper, e.g. `timerDelay(at)` in core, which clamps to 2^31−1 ms (the loop re-arms when it fires
  early). It would fail today on `scheduler.ts:468` and `cron-executor.ts:285`, so it lands in the F2/F3 fix PR, not
  here. The scan of §3.3 (S8) found no other site that matches.

### 3.2 The probes

The probes were throwaway scripts that imported the worktree by absolute path. They live in the session's
scratchpad, not in this PR. Each one prints `HOLDS` or `VIOLATED`.

| Probe | Invariants | What it ran | Result |
|---|---|---|---|
| P01 | I-01 | `createServer`, a query over a table, called over HTTP twice, then the cache clock moved 18 s, then a write | **VIOLATED**: 2 runs before the write (expected 1) |
| P02 | I-05 | 200 sync connections, half of them reusing one session id. Each subscribes two queries; some write, remove a query, or are torn down | holds: every hub map is 0 |
| P03 | I-11 | 120 connections join two rooms, set presence, send events; half leave, all close; a third reuse a session id. Grace 1 s | holds: all 0 once the grace passed |
| P04 | I-12 | 40 concurrent mutations schedule 200 jobs (0–50 ms) on one hot counter, half through an action | holds: 200 ran once each, counter 200 |
| P05 | I-24 | sync, rooms, an action, a job an hour away; `shutdown()`; no `process.exit` | holds: the process exits within 4 ms |
| P06 | I-13, I-25 | one job 30 days away, then 2 s idle | **VIOLATED**: 4 085 engine queries and 0.52 s of CPU in 2 s (with 1 day: 2 queries) |
| P07 | I-14, I-25 | one cron due in ~300 days, then 2 s idle | **VIOLATED**: 4 584 engine queries and 0.26 s of CPU in 2 s |
| P08 | I-03, I-19, I-22, I-23 | 3 000 rounds of HTTP queries (400 keys, every other one throwing), writes, and 50 sync subscriptions; cache 256 KiB | holds: bytes = Σ sizes ≤ budget; 1 000 log parts; 0 rings |
| P09 | I-31, I-01, I-02 | the differential prototype of §5.3, on Convex's binary and bunvex's backend | **VIOLATED** (F4); F1 seen as well |
| P10 | I-15 | a scheduled mutation that keeps losing OCC races to a writer loop; `shutdown()` | **VIOLATED**: not done after 4 s; it finishes only once the writer stops |

### 3.3 Findings: invariants that do not hold on main

None of these was fixed by the PR of this study (#755). Each is a bug against Convex's behaviour (§1), so none needs a DV
unless the owner decides otherwise (F4 was the exception, see §8). F4 is now fixed (§10.2).

**F1. Every cached query result expires after 17 s** (I-01). This is #751's finding. #751 has since merged
(`7683a19a`), so F1 is **fixed on main**. It is reproduced here, on the pre-#751 build, as the baseline the new layers
must catch:

```ts
const skew = { ms: 0 };
const engine = await new Engine(schema, store, { cacheClock: () => Date.now() + skew.ms }).init();
const s = createServer({ engine, functions, port: 0 });      // AppMetrics records inside the query
await post("query", "m:list"); await post("query", "m:list");  // 1 run
skew.ms = MAX_CACHE_AGE_MS + 1000;
await post("query", "m:list");                                 // main: 2 runs; Convex and #751: still 1
```

**F2. An idle scheduler busy-polls when its next job is more than 24.8 days away** (I-13, I-25). The loop's sleep
(`scheduler.ts:468`) is `setTimeout(poke, nextAt − now)` with no cap. Past 2^31−1 ms Bun fires it after about 1 ms,
with a one-time `TimeoutOverflowWarning`. So the loop reads the queue (three queries) about every millisecond, until
the job is less than 24.8 days away. Apps can trigger this: `runAfter` and `runAt` accept up to five years
(`FIVE_YEARS_MS`), and "remind me in a month" is a normal job. The GC timer next to it is capped (`MAX_TIMER_MS`,
`scheduler.ts:261`). `executor-invalidations.ts:174` caps too.

```ts
const s = createServer({ engine, functions, port: 0 });
await functions.runMutation("m:later", { ms: 30 * 86_400_000 });  // scheduler.runAfter(30 days, …)
// over the next 2 s: 4 085 engine queries, 0.52 s CPU (1 day: 2 queries, 17 ms)
```

**F3. The same in the cron executor** (I-14, I-25). `cron-executor.ts:285` has the same uncapped `setTimeout`. Any
cron executor whose *nearest* cron is more than 24.8 days away does it. That covers an app whose crons are all
yearly, or all monthly in the days after their run (31 days); a weekly cron never triggers it. The soak cannot see
F3: its trim cron runs every 10 s, so a far cron is never the next run. F3 needs the unit test below.

```ts
const crons = cronJobs();
crons.cron("yearly", "0 0 1 1 *", "m:add", {});   // next run > 24.8 days away
createServer({ engine, functions, port: 0, crons });
// idle: 4 584 engine queries in 2 s
```

Both fixes are one line each: cap the delay at 2^31−1 ms and let the loop look again, which it already does when
woken. But they land on a default path, so they belong in a fix PR, with a test per loop (inject the clock, schedule
past the cap, count the queries).

**F4. A cache hit's log entry does not describe the run it reused** (I-31, found by the §5.3 prototype; **fixed**,
§10.2). In the
function log stream (`/api/stream_function_logs`) and the log sinks, Convex logs a hit with the cached outcome's
`userExecutionTime`, `usageStats.memoryUsedMb` (64) and `executionTimestamp`. bunvex logs `userExecutionTime: 0`,
`memoryUsedMb: 0` and the hit's own time (`functions.ts:1428, 1447`). Both agree on `cachedResult: true` and zero
reads. Who sees it: log sinks such as Datadog and Axiom (a cached call looks free of user time and memory on bunvex),
and the dashboard's logs page. The usage meter is right on both: a cached query meters no compute (STUDY-71).
Repro: `bun test --todo packages/differential/test/cache-metadata.test.ts` with `CONVEX_BACKEND_BIN` set. The
third case is a `test.todo` that prints `{sameUserTime, sameMemory, sameTimestamp}`: Convex gives
`true, true, true`, bunvex `false, false, false`.

**F5. `shutdown()` waits for a scheduled mutation that keeps losing OCC** (I-15). The scheduler's `stop()` waits for
its running jobs. A job's OCC retry loop (`scheduler.ts:633–636`, backoff up to 60 s, no limit) never checks
`stopped`. During `shutdown()` the engine and the HTTP server are still open: the scheduler stops at step 5, the
server at step 7. So writers can keep a hot key contended and the shutdown waits on them. Under Docker or systemd
the backend is then SIGKILLed after the grace period instead of closing its store cleanly. Convex aborts the
executor task. The chain at `72ce13c` is §1's:
- `lib.rs:3938`;
- `worker_handles.rs:62`;
- `scheduled_jobs/mod.rs:169–171`;
- `common/src/runtime/mod.rs:177`, `abort()`.

```ts
// engine maxRetries 0, scheduler backoff 5–20 ms, a job that reads, sleeps 20 ms, writes one doc;
// a writer loop patches the same doc every 1 ms
await functions.runMutation("m:sched", {}); await Bun.sleep(300);
await s.shutdown();   // not done after 4 s (134 attempts); done 48 ms after the writer stops
```

The probe is harsher than production: the conflicting writer runs in-process and the job sleeps while holding its
read. In production, the conflicting writes come from requests that the still-open HTTP server keeps accepting. The
same unbounded wait applies to an action's `completeJob` retry (`scheduler.ts:671–682`, up to 2 h), which only exits
on `CommitterStoppedError`.

**The other timers (bunvex-9f's review).** `git grep -n "setTimeout(" packages/server/src packages/core/src`,
widened to `Bun.sleep(`, `setInterval(`, the runtime's and the rooms' `timers.set(`, and `packages/{file-storage,
persistence,sandbox,search}/src`. Each delay's source was checked for an uncapped `x − now`:
- **App-driven, `x − now`, uncapped:** only F2 and F3.
- **`x − now`, but capped:**
  - `scheduler.ts:718` (the GC: `MAX_TIMER_MS`, `:726`);
  - `executor-invalidations.ts:174`;
  - `engine.ts:689` (≤ 250 ms);
  - `log-sink-http.ts:83` (≤ 50 ms);
  - `otlp.ts:412` (≤ 60 s).
- **`x − now`, bounded by a knob:** `committer.ts:927`, bounded by `MAX_REPEATABLE_TIMESTAMP_IDLE_FREQUENCY`
  (1 h).
- **Fixed constants, long polls, or backoffs capped by their max:** everything else.
- **S8 (minor, not a finding).** About ten delays come straight from operator knobs, and the knob parsers do not cap
  them. Setting one past 24.8 days would make its loop spin like F2. The knobs are
  `MAX_REPEATABLE_TIMESTAMP_IDLE_FREQUENCY`, the retention intervals, `ROOM_RECONNECT_GRACE_SECS`,
  `SEARCH_INDEXES_UNAVAILABLE_RETRY_DELAY`, the usage-gauge period, the table-summary interval, and the request and
  action timeouts. No default comes close; the helper above would cover these too.

**Suspected, from reading the code, not probed** (for the fix PRs to confirm or dismiss):
- **S1.** `index-worker.ts:267–272`: a backfill that restarts from the beginning, because its checkpoint snapshot is
  older than `minSnapshotTs`, keeps its `done[]` count. Its progress can then pass 100 % (I-17).
- **S2.** `log-sinks.ts:268–271`: `LocalSink.send` opens, syncs and closes the file without `finally`. A throwing
  `sync()` leaks the handle, and the send is retried forever (I-27).
- **S3.** `file-storage/src/store.ts:37–47`: `pumpHashing` never cancels the request body's reader when a write
  throws (I-28).
- **S4.** `index-worker.ts:175–177`: its failure backoff (up to 30 s) cannot be interrupted, so `stop()` can wait for
  it. `start()` (119–124) can restart the worker after `engine.close()` began.
- **S5.** `server.ts:2600–2617`: the synchronous `stop()` skips `executorInvalidations.stop()`, which `shutdown()`
  calls. Its timer is unref'd, so the effect is work after stop, not a hang.
- **S6.** `external-deps.ts:84`: the push-time `bun install` has no timeout and no kill.
- **S7.** `core/src/persistence/sqlite.ts:149–150`: the process lock is taken before `new Database`, outside the
  `try`. A throwing open keeps the lock until the process exits.

## 4. A soak test (part 2)

### 4.1 What it is

`bench/soak/soak.ts` (scaffolding in this PR; it changes no default code path). It runs:
- **The backend:** this repository's `bunvex-local-backend` (the program the release compiles, run by Bun) on SQLite,
  started the way `examples/_harness` starts it.
- **The app:** `bench/soak/app/`, deployed with the CLI as a self-hosted user would.
- **The workload:** mixed, for `--minutes` (default 45). The default 20 clients cover:
  - **Sync clients.** Each subscribes to its channel's latest messages and to a hot counter. It sends a message every
    ~1 s and bumps the shared counter every ~2 s, so mutations conflict and retry. It holds a room presence updated
    every 0.5 s, and is replaced by a new client after 30–90 s (reconnect churn: rooms' grace, session ids,
    re-subscription).
  - **HTTP:**
    - `messages:list` for a random channel, 10/s, invalidated often;
    - **the cache canary** `config:get`, 10/s. It reads a row written every 5 minutes, so past the warm-up each of
      its misses must follow a write (#751's detector);
    - a full-text search, 2/s.
  - **Scheduler:** 2 jobs/s, due within 0–2 s. Each records `dueAt` and `ranAt`, so lag, and exactly-once, are
    checked from the data.
  - **Storage:** every 5 s, upload 16 KiB, save, get the URL, download, compare, delete.
  - **Crons:** the trim every 10 s keeps `messages` at 2 000 rows, so the data does not grow and memory has no
    reason to.
  - **A job 30 days away** (`--far-future-days`). Once the workload has stopped it is the scheduler's next job, and
    the idle tail must cost nothing (F2).
- **The caches** run with small budgets: 32 MiB of index cache and 16 MiB of query cache (flags). They fill during the
  warm-up, so later growth is not a cache filling up. With the defaults, 512 MiB and 100 MiB, a 45-minute run on this
  workload would still be filling them and R1 would be meaningless.

Every 15 s it samples:
- `/metrics`:
  - RSS and heap;
  - index cache bytes;
  - query cache hits and misses (deltas);
  - sync sessions and subscriptions;
  - room members;
  - event-loop lag;
  - scheduler backlog.
- File descriptors: `/proc/<pid>/fd` on Linux, `lsof` elsewhere.
- What the driver itself holds open.
- Per-operation p50 and p99 over the window.

Once a second it tails the function log stream to count the canary's calls and misses, and any failure the workload
did not ask for. A hot counter's lost OCC attempts are expected and not counted.

At the end it:
1. closes every client;
2. drains the scheduler;
3. waits past the rooms' grace;
4. reads the final gauges;
5. sleeps 30 s, then measures the backend's CPU over a 60 s idle tail.

### 4.2 Pass/fail rules (`bench/soak/rules.ts`, tested by `rules.test.ts`)

Each rule is judged on the samples after the warm-up: by default max(3 min, 20 % of the run). Memory (R1, R2) waits
longer. It is judged from the first sample where the index cache is 90 % full and the write log has reached its
longest retention (300 s). Before that, memory grows by design. A run where the cache never fills reports R1 and R2
as "not judged" rather than passing them silently. The pilots taught this: §4.6. Trends use the
Theil–Sen slope (the median of pairwise slopes), which a GC sawtooth or one slow window does not move. Wherever a
rule says "trend", it requires **both** a slope over its limit **and** a level shift between the first and last
thirds. The slope alone can be one step (a cache filling); the shift alone can be noise.

| Rule | Fails when |
|---|---|
| R1 RSS (from the memory warm-up) | the slope is over 0.5 MB/min **and** the last third's median is 10 MB over the first's |
| R2 heap (from the memory warm-up) | the slope is over 0.3 MB/min **and** the shift is over 8 MB |
| R3 cache canary | its misses past the warm-up exceed the writes into its read set + 1 (a strict count) |
| R4 hit rate | the windowed hit rate is projected to fall more than 10 points **and** the thirds differ by more than 10 points |
| R5 gauges | at any sample, sessions, subscriptions or room members differ from what the driver holds by more than 3 + the clients replaced in the last 10 s |
| R6 freed | after the drain, sessions, subscriptions or room members are not 0 |
| R7a fds | the slope is over 0.2/min **and** the shift is over 4 |
| R7b fds | after the drain, more than the baseline + 8 |
| R8 latency (per operation) | the last third's p99 is over 1.5× the first's (and 20 ms more), **or** its p50 is over 1.3× (and 10 ms more), **or** its p99 is ≥ 1 s |
| R9a scheduler | jobs recorded ≠ jobs scheduled, a job did not run, or a job ran twice |
| R9b scheduler lag | a minute's p99 lag is over 2 s, **or** the p99 is projected to grow more than 1 s over the run |
| R10 event loop | more than 5 % of samples show over 200 ms of lag (one GC pause on one sample does not fail it) |
| R11 idle | the backend uses 3 % or more of a core over the idle tail |
| R12 errors | any unexpected failure (function, request, subscription). A hot-counter mutation that lost every OCC retry is expected (Convex's budget is the same 4 retries): it is counted in the report, not failed |

Exit code 0 means every rule passed, 1 means one failed, 2 means the run itself broke (the backend died or did not
start). `report.json` keeps every sample, so a run can be judged again after a rule changes. `report.md` is a summary
fit for an issue.

`rules.test.ts` (15 tests, in the root `bun test`, about 20 ms):
- A flat run passes.
- Noise does not fail: a sawtooth heap, one 900 ms window, a reconnect burst.
- Each degradation fails its own rule and only that one:
  - a 1 MB/min leak;
  - an early cache-filling step (passes), and a cache filling for 20 minutes (passes, judged once full);
  - #751's canary pattern;
  - a falling hit rate;
  - kept sessions;
  - an fd leak;
  - doubling latency;
  - a lost job, and a job run twice;
  - growing lag;
  - a busy loop;
  - idle CPU;
  - errors.

Sabotage: the rules were broken six ways, and each made `rules.test.ts` fail (§7).

### 4.3 Where it runs, how long, what it costs

**The recommendation: a nightly job beside the Jepsen and differential nightlies.** Built as
`.github/workflows/soak-nightly.yml` (§10.3):
- `ubuntu-latest`, Bun 1.4.2;
- `bun bench/soak/soak.ts --minutes 45`, `timeout-minutes: 60`;
- on failure, upload `report.json` and open or comment on an issue with `report.md`, as `jepsen-nightly.yml` does.

Cost and placement:
- The repository is public, so standard runners cost nothing but queue time. The run takes about 50 minutes: 45 of
  workload, 2 to drain, 1.5 of idle tail, and the start.
- A nightly needs no other services, no Docker and no store.
- The SQLite backend is the right first target: it is what `bunvex dev` and the examples run. Postgres is a later
  matrix entry, as in Jepsen.
- It should not run on PRs. At 1 minute it judges nothing (too few samples past a warm-up), and the rules' unit test
  already guards the judging code. A PR touching `bench/soak/**` can run a 5-minute smoke that only checks exit code
  ≠ 2.

**The VPS:**
- It is useful for runs longer than CI allows, e.g. a monthly 6-hour run. Longer runs see slower leaks: at 0.5 MB/min
  R1 needs about 20 minutes past the warm-up to separate a leak from noise, and 6 hours sees 0.05 MB/min.
- It is the place to bisect a soak failure.
- It is also less noisy than a shared runner, although the pilot found the 2-core VPS adequate (§4.6).

**Why not in Jepsen.** Jepsen's runs are 20 s on a fresh process and database each, by design (each history is
checked against a fresh store). The soak needs one long-lived process. They can share the workflow pattern but not the
runner. A cheap extension of Jepsen *does* fit: after each of its runs, read `/metrics` once and assert R6 (sessions,
subscriptions and room members back to 0 once its clients closed) and an fd count. That is the "freed after the run"
part of the soak, at no extra time.

### 4.4 What it does not cover

These are left for later, in order of value:
- **Postgres and MySQL.** Pool exhaustion and connection leaks over time live in the drivers.
- **Actions with `fetch`, and the process sandbox** (STUDY-168, once built): child-process reaping and IPC buffers.
- **Auth:** token refresh over long sessions, and presence scopes, which need signed-in users.
- **Pushes during the run:** code-version collection. `bench/code-versions.ts` measures this by hand today.
- **Pagination subscriptions:** journals and page splits under churn.
- **Exports and imports.**

### 4.5 Per-connection memory (I-09)

The soak's RSS divided by its clients is not a per-connection figure: the caches and the data dominate it. A
per-connection budget is a separate, short measurement:
- open N idle connections, each with K subscriptions to a shared query;
- compare `heapUsed` after a forced GC with the same before;
- report bytes per connection and bytes per subscription.

It belongs in `bench/`, next to `rooms.ts`, as a number in the parity notes. It is not an assertion until the owner
sets a budget (§8, Q4).

### 4.6 The pilot

Four runs on the test VPS (2 vCPU, 8 GB, Ubuntu, Bun 1.4.3), under `/root/bunvex-soak-study` (`pilot-N/report.json`
and `pilot-N.log` there). Each had 20 clients, and the backend and the driver shared the machine. The asked-for
10–15 minute pilot came first. What it could not settle (memory) led to the longer two, and each run changed the
design a little. All four were judged again with the final rules (`report.json` keeps every sample). All four ran on the
pre-#751 build (`016dfccb` plus this branch), so F1 shows in every one of them. On main today the canary (R3) should
pass; the other results do not depend on #751.

| Run | Setup | R1 RSS | R2 heap | R3 canary | R11 idle | Other |
|---|---|---|---|---|---|---|
| 1 | 12 min, default caches (512 MiB index, 100 MiB query) | fail: 15.9 MB/min | fail | **fail**: 32 misses, 1 write | **fail**: 65 % of a core | R10 failed on one 207 ms sample, then the rule was changed |
| 2 | 12 min, caches 32 MiB / 16 MiB | not enough steady samples | flat | **fail**: 32 / 1 | **fail**: 66 % | 1 hot-counter OCC failure, then classed as expected |
| 3 | 30 min, the same | **fail**: 5.5 MB/min, +72 MB | pass: 0.6 MB/min | **fail**: 88 / 6 | **fail**: 67 % | everything else passed |
| 4 | 25 min, the same, **no far-future job**, memory detail | **fail**: 5.0 MB/min, +41 MB | pass: −0.2 MB/min | **fail**: 74 / 5 | **pass: 1.3 %** | everything else passed |

What the pilots show:
- **F1 is caught from outside.** The canary missed every ~17 s in every run (32 misses in 9 minutes; 88 in 24). It
  stays cached only between writes on Convex and on #751. R3 is a count, not a trend, so even the 12-minute run is
  conclusive.
- **F2 is caught, and attributed.** Runs 1–3 had a job 30 days ahead, and their idle backend burned 65–67 % of a core.
  Run 4 had none and used 1.3 %. That is F2, the scheduler's timer overflow, alone. During the load itself it costs
  ~25 % of a core that no latency rule sees.
- **The design changed twice because of the pilots:**
  - **Memory needs a memory warm-up.** With the default caches, RSS grew for the whole of run 1. The index cache's
    512 MiB alone takes longer than a run to fill, so R1 there says nothing. With 32 MiB, the cache fills in 10–13
    minutes at this load. R1 and R2 now start from the first sample where it is 90 % full and the write log has reached
    300 s, and are "not judged" before.
  - **One sample is not a trend.** R10 failed on a single 207 ms sample out of 37, so it now counts samples. A
    hot-counter mutation that loses all 4 OCC retries is Convex's behaviour too, so it is reported, not failed.
- **Everything about resources and freeing passed:**
  - the sessions, subscriptions and room-member gauges matched the clients at every sample, through about 600
    reconnects in run 3;
  - all were 0 after the drain;
  - file descriptors flat (38–46) and back below the baseline;
  - every one of 1 424–3 603 jobs ran exactly once, with lag p99 ≤ 351 ms and flat;
  - no latency trend in runs 3 and 4 (run 2's search p99 36 → 72 ms did not repeat);
  - the hit rate was flat at ~57 %.

**F6: resident memory grows ~5 MB a minute under steady load, outside the JS heap.**

| | from (t = 781 s) | to (t = 1 502 s) | slope |
|---|---|---|---|
| RSS | 357 MB | 406 MB | |
| anonymous memory (`smaps_rollup`) | 311 MB | 360 MB | **4.95 MB/min** |
| file-backed | 46 MB | 46 MB | 0.00 |
| JS heap (`heapUsed`) | 154 MB | 130 MB | −0.14 MB/min |
| SQLite WAL | 6 MB | 6 MB | |
| SQLite database file | 55 MB | 101 MB | on disk, not resident |

- The measurements are from run 4, past its memory warm-up (index cache full). Run 3 had the same slope, 5.5 MB/min.
- This rules out the JS heap, the index cache (full, at its budget), the write log (past its retention), and mapped
  files (SQLite's pages). What is left is native memory: JSC's out-of-heap backing stores (strings and
  `ArrayBuffer`s, which `heapUsed` does not count), Bun's native WebSocket and HTTP buffers, `bun:sqlite`'s
  statements and rows, or the allocator keeping freed pages.
- It is a real trend over two runs. It is **not yet known to be unbounded**: 20 minutes of steady state cannot tell a
  leak from a slow plateau.
- **Done since:** §4.7 attributes it. The paragraph below was the plan.
- **Next step** (§9, step 3): a 2-hour run on the VPS. It would sample `process.memoryUsage()`'s
  `external` and `arrayBuffers` (a `/metrics` gauge, or a debug route), with a forced GC every 10 minutes (does RSS
  come back?), and bisect the workload by turning off one part at a time: rooms, storage, search, reconnects.
- The database file grew 46 MB in 12 minutes although the trim keeps 2 000 messages. That is the document log
  keeping every version until retention prunes it ([STUDY-33](STUDY-33-retention.md)'s retention runs on its own schedule). It is on disk, not
  in memory; a longer run should check that it levels off.

### 4.7 F6 attributed: SQLite's page cache, a plateau (2026-10-20)

**The verdict: a plateau, not a leak, and bunvex's, not Bun's.** The memory that grows is SQLite's page cache.
bunvex opens its store with `pragma cache_size = -262144` (`packages/core/src/persistence/sqlite.ts:160`), a
256 MiB cache. The cache keeps every page it reads or writes until it reaches that budget. Here the database file
grows 3.8 MB a minute, from the document log: it keeps every version for 14 days, as Convex's does (STUDY-33). The
cache follows the file at about 1.4 MB of memory per MB of file, then stops at its budget. Convex sets no pragma
(`crates/sqlite/src/lib.rs:93-99`: `Connection::open`, then the tables), so it runs with SQLite's default,
2 000 KiB. rusqlite's bundled build does not change that default either. STUDY-133 lists that difference as L13.
DV-411 names `cache_size` among the pragmas bunvex keeps, but its decision (#472) was about WAL; the size itself
was never studied.

**How it was found.** All the runs were on the test VPS, the same machine as §4.6, on main at `9254fa5c`. They
used `soak.ts --probe`, which preloads `bench/soak/probe.ts` into the backend. Every 15 s the probe records:
- `process.memoryUsage()`, including `external` and `arrayBuffers`;
- `bun:jsc`'s `heapStats()`, with every object type's count;
- `Bun.unsafe.memoryFootprint()`;
- `/proc/self/smaps_rollup`.

Every 10 minutes the probe forces a full GC. On demand it writes mimalloc's statistics (`Bun.unsafe.mimallocDump()`),
a copy of `/proc/self/smaps`, and a heap snapshot. `bench/soak/analyze.ts` reads the result: Theil–Sen slopes, the
object types' change, and mimalloc's size classes. The files are under `bench/soak/results/f6-*`.

| Run | Window | anonymous | JS heap | `external` | SQLite file | R1 |
|---|---|---|---|---|---|---|
| main, 2 h (`f6-main-2h`) | 13–60 min | **5.38 MB/min** (310 → 544 MB) | 0.24 | 0.09 | 3.80 MB/min | fail |
| the same run | 60–114 min | **0.22 MB/min** (555 → 578 MB) | 0.14 | 0.02 | 3.79 MB/min (to 437 MB) | — |
| main, 30 min, 256 MiB cache (`f6-sqlite-cache-256mib`) | 13–30 min | **5.14 MB/min** | 0.15 | 0.07 | 3.79 MB/min | fail: 5.3 MB/min, +54 MB |
| the same, cache at SQLite's default (`f6-sqlite-cache-2mib`) | 13–30 min | **0.12 MB/min** | 0.25 | 0.15 | 3.78 MB/min | pass: −0.3 MB/min |

The two 30-minute runs differ only in that one pragma: the second run's backend had a local patch that read it
from the environment. Both ran without the far-future job, so F2 did not interfere.

What else the 2-hour run shows:
- **The growth is all in one of mimalloc's size classes.** Bun's allocator serves SQLite too. Its 5 KiB class holds
  one 4 KiB page plus SQLite's header. It held 103.5 MiB at 20 minutes, 292.2 MiB at 60 and 310.4 MiB at 115; that
  is the 256 MiB budget, in 5 KiB blocks. The 16 KiB class (JSC's heap blocks) went 125 → 154 → 153 MiB. No other
  class moved by more than 3 MB. With the 2 MiB cache, the 5 KiB class held 3.0 MiB at 27 minutes.
- **Nothing else grows:**
  - mapped files, `arrayBuffers` and `external` are flat;
  - after a forced GC, between 60 and 114 minutes, objects, strings and `Uint8Array`s moved by 4 % or less. The
    `ArrayBuffer` count rose by 1 210 (to 3 918), but `arrayBuffers` stayed at ~1 MB;
  - anonymous memory sampled right after a forced GC levels off with the rest.
- **No mapping tells the cause apart.** `smaps` shows almost all anonymous memory in one anonymous region, the
  JS heap and the page cache together. The size classes are what separate them.
- **Plain Bun reproduces it** (`bench/soak/sqlite-page-cache.ts`, `results/f6-plain-bun-sqlite.txt`). A plain
  `bun:sqlite` script grows a WAL database to 196 MB:
  - with `cache_size = -262144`, its resident memory grows 256 MB, 1.3 MB per MB of file, and mimalloc's 5 KiB class
    holds 245 MiB;
  - with SQLite's default it grows 11 MB and stays there.

  This is SQLite doing what it was told to do. It is not a Bun bug.

**Why the workload was not bisected part by part.** Changing one pragma, with the workload unchanged, took the
slope from 5.1 to 0.12 MB/min, under R1's 0.5 MB/min. The 2-hour run's plateau, 0.22 then −0.16 MB/min, says the
same of everything else in the workload. No part is left that could drive a slope R1 would see. So the
per-part switches (`--off subs,rooms,reconnects,sync-mutations,hot,httpq,canary,search,scheduler,storage,crons,
logtail,clients`) are in `soak.ts` for the next trend, but these runs did not need them.

**What it means:**
- **For apps:** the store's process holds up to ~310 MiB more than the JS heap and the index cache, once the file
  is past 256 MiB. That is bounded, and on a store under 256 MiB it is about 1.3× the file.
- **For the soak:** at this write rate the cache needs ~70 minutes to fill. Until then R1 sees a trend, so a
  45-minute nightly fails R1 every night, and the 2-hour run failed it too: 1.8 MB/min, judged from t = 24 min,
  before the cache was full. The memory warm-up must see the page cache, as it already sees the index cache (§4.2).
  Today nothing reports the page cache: `bun:sqlite` does not expose `sqlite3_db_status`, and no setting changes the
  pragma. Q6 asks which way to go.
- **Speed:** in the matched 30-minute pair, the smaller cache was not slower. HTTP query p99 was 50–55 ms
  against 59–84 ms, and the sync mutation p50 27 ms against 29 ms. That is one run each on a 2-vCPU machine, with
  the file (≤ 120 MB) in the OS page cache, so it shows no regression on this workload, not on every one. The index
  cache (512 MiB by default) serves the hot index reads in either case.
  **Superseded by §4.8:** on a store bigger than memory, and on reads the index cache does not serve, the default
  is ~20 % slower.

**Seen in the 2-hour run, not F6:**
- R11 failed at 73 % of a core: F2's far-future job (#757).
- R9b failed on one minute, with a p99 lag of 7.8 s: the heap snapshot at t = 115 min stopped the process for
  seconds. `probe.ts` now writes its dumps before the snapshot, so a snapshot no longer inflates them.
- The database file reached 437 MB in 2 hours under the soak's steady writes. That is the 14-day document retention, on
  disk, the same as Convex's.

### 4.8 Q6 measured: SQLite's default page cache against 256 MiB, on reads (2026-10-20)

The owner's decision (2026-10-20): measure first, then match Convex if the default is not meaningfully slower
(p99 within ~10 % and throughput within ~5 %). **It is meaningfully slower** wherever reads are CPU-bound and their
working set is past 2 MiB: 15–22 % fewer calls a second, and p99 up to 22 % higher. It is not slower when the disk
is the bottleneck, or when the working set is tiny. So this PR changes no product code, and Q6 goes back to the owner.

**How.** `bench/sqlite-cache/` (results in `results/`, the table in `results/summary.txt`):
- **Machine.** The test VPS: 2 vCPU, 8 GB, Ubuntu 24.04, cgroup v2, a cloud disk. No other backend ran during any run
  (each result records it). The repository is main at `65fd85c7`, on a copy patched by `patch-backend.ts` so that the
  store reads `cache_size` from the environment. With no value set, the store sets no pragma (Convex's open), and
  every run checks what the connection got: `-2000` or `-262144`.
- **What runs.** The real local backend (`packages/bunvex/bin/local-backend.ts`, SQLite) serves an app of one
  table: ~1 KB documents in 1 000 groups, with an index on `(group, n)`. The default index cache (512 MiB) and query
  cache are left as they are.
- **The workload.** A closed loop of 16 HTTP clients (`BunvexHttpClient`) with random arguments:
  - 40 %: a point `db.get` by id;
  - 40 %: an index range read of 20 (`withIndex(...).gte(...).take(20)`);
  - 20 %: a paginated walk of up to 4 pages of 25 (`paginate`).

  `uniform` reads every group; `hot` reads 20 of the 1 000 (2 %).
- **The stores**, seeded through the same backend:
  - *big:* 5 M documents, a 10.1 GB file, more than the machine's 8 GB. The backend runs in a systemd scope with
    `MemoryMax=2G`, which counts the OS page cache it fills, so the file is 5× what it may cache. The 256 MiB cache
    comes out of the same 2 GB.
  - *small:* 100 k documents, a 202 MB file, no limit: it fits both the 256 MiB cache and the OS page cache.
- **Each run.** The OS page cache is dropped, the backend starts, then a warm-up runs (90 s on the big store, 300 s
  for its second hot round, 30 s on the small one), then 180 s (big) or 120 s (small) are measured.
- **The order.** Each store and mode runs both caches in ABBA order, twice on the small store, so drift over time
  does not favour one side.

**Results**, the mean of the repetitions (each repetition's value is in `results/summary.txt`):

| store | mode, warm-up | cache | calls/s | p50 ms | p95 ms | p99 ms | RSS MB | CPU ms/call | `read()` KiB/call |
|---|---|---|---|---|---|---|---|---|---|
| big | hot, 300 s (steady state) | 256 MiB | **549** (549, 548) | 25.4 | 58.6 | **86.4** | 1 312 | 1.92 | 118 |
| big | hot, 300 s (steady state) | default | **428** (441, 416) | 32.8 | 73.0 | **105.0** | 947 | 2.44 | 1 130 |
| big | hot, 90 s | 256 MiB | 420 (507, 333) | 28.2 | 92.5 | 247.2 | 1 236 | 2.21 | 126 |
| big | hot, 90 s | default | 338 (378, 298) | 35.8 | 110.7 | 273.2 | 933 | 2.67 | 1 221 |
| big | uniform, 90 s | 256 MiB | 13 (13, 14) | 1 125 | 2 085 | 2 984 | 610 | 15.5 | 397 |
| big | uniform, 90 s | default | 15 (17, 14) | 982 | 1 834 | 2 637 | 311 | 14.5 | 1 250 |
| small | uniform, 30 s | 256 MiB | **1 139** (1 013, 882, 1 305, 1 354) | 11.0 | 30.1 | 76.9 | 1 198 | 0.91 | 1 |
| small | uniform, 30 s | default | **965** (816, 954, 969, 1 121) | 13.9 | 35.1 | 65.5 | 915 | 1.09 | 272 |
| small | hot, 30 s | 256 MiB | 5 680 | 2.49 | 5.15 | 10.24 | 540 | 0.15 | 0 |
| small | hot, 30 s | default | 5 561 | 2.55 | 5.31 | 10.58 | 546 | 0.15 | 0 |

The default against 256 MiB:

| store | mode | calls/s | p50 | p95 | p99 | RSS |
|---|---|---|---|---|---|---|
| big | hot, steady state | **−21.9 %** | +29.2 % | +24.6 % | **+21.5 %** | −365 MB |
| big | hot, 90 s warm-up | −19.6 % | +27.0 % | +19.6 % | +10.5 % | −303 MB |
| big | uniform (disk-bound) | +15.8 % | −12.7 % | −12.0 % | −11.6 % | −299 MB |
| small | uniform | **−15.3 %** | +26.0 % | +16.5 % | −14.9 % | −283 MB |
| small | hot (tiny set) | −2.1 % | +2.6 % | +3.1 % | +3.3 % | +7 MB |

**What the numbers say:**
- **The cost is CPU, not disk.** At the big store's steady state neither side reads the disk. With 2 000 KiB, though,
  each call issues ~1.1 MiB of `read()`s, ~280 pages that SQLite re-reads from the OS page cache, against 118 KiB
  with 256 MiB. Most of them are the B-trees' interior pages, which a 2 MiB cache cannot hold for a 10 GB file.
  That is +27 % CPU a call, and on 2 vCPUs shared with the driver it shows as throughput: −22 % (the two ABBA pairs
  agree within 6 %). The small store says the same: with 256 MiB the whole 202 MB file is in the process, 1 KiB of
  `read()` a call against 272.
- **When the disk is the bottleneck, the big cache does not help.** Uniform reads over 10 GB with 2 GB of memory
  are a few disk reads per document (13–17 calls a second, p50 ~1 s). There the 256 MiB that SQLite holds is
  256 MiB the OS page cache does not get, and the default was, if anything, faster: +16 %, inside the noise of a
  disk-bound run.
- **A tiny working set does not care.** The small store's hot set (2 000 documents, ~4 MB) is served by the index
  and query caches. No `read()` happens on either side, and the gap (−2 %) is inside the run-to-run spread.
- **The warm-up matters on the big store.** After 90 s the hot set was still coming off the disk (68–275 MB read
  in the measured window), which is why that round is noisy (p99 97–398 ms). The 300 s round read nothing.
- **p99 on the small uniform case went the other way** (−15 % with the default), from one 256 MiB run's 124 ms
  outlier. The other three agree with throughput.
- **Memory** is what §4.7 found: the 256 MiB cache adds ~280–365 MB of RSS once its working set is that large.

**Seen on the way:**
- A store's start replays the table summaries' log since their checkpoint (STUDY-72). A checkpoint is rewritten
  500 commits, or 10 minutes with a commit, after the last, as Convex's. The seed ended 312 s after its last one,
  so the next start replayed ~1 M documents: 9+ minutes under the 2 GB limit, and 209 s without it. `bench.ts`
  makes 600 small commits at the end of its seed, so the checkpoint catches up. This is Convex's behaviour too,
  not a bug; a store whose writes stop right after a burst pays it once at its next start.
- `bun:sqlite`'s default differs by platform: `-2000` (2 000 KiB) with the SQLite Bun bundles on Linux, as in
  Convex's rusqlite build, but `2000` (2 000 pages, 8 MiB) with the system SQLite Bun uses on macOS. A test that
  pins "no pragma" must compare against a fresh connection, not a constant.

## 5. Metadata differentials against Convex (part 3)

### 5.1 What both sides expose

The oracle is the pinned binary, run by `packages/differential/harness/backends.ts` as `startConvex`. It and bunvex's
backend expose the same admin routes, and the harness already holds an admin key for each.

| Metadata | Where to read it | Compared today | Proposal |
|---|---|---|---|
| Cache hit or miss per call | `/api/stream_function_logs` `cachedResult` | no | §5.3 prototype; extend to sync subscriptions (a second client reusing a run: STUDY-75) |
| Time-dependence (expiry at 17 s) | the same, across a 19 s wait | no | §5.3 (the 19 s case) |
| User time, memory, timestamp of a hit | the same entry | yes (§10.2) | §5.3 case 3 (F4) |
| Usage per call (`usageStats`: documents and bytes read and written, index rows) | the same entry | no (STUDY-71's tests are bunvex-only) | compare `usageStats` per call over the generated programs (below) |
| Read-limit counting | the "Many reads" warning, the limit error | `read-count.test.ts` (local only) | add to the nightly list |
| OCC: `occInfo`, `willRetry`, `mutation_retry_count` | log stream entries | no | a fixed scenario: two clients race one document, then compare the sequence of entries (kinds, `willRetry`, retry counts); timing makes the count itself racy, so compare the shape |
| Subscription invalidation set | `/api/app_metrics/subscription_invalidations_top_k`; per subscription, the transitions a client receives | `dashboard-ops.test.ts` (names, count deltas; local only) | per write, the set of subscriptions that got a new transition (WebSocket clients on both) |
| Log line fields | log stream entries: every key, its type, which are null | partly (`logLines`, kinds) | a schema diff: the key set and value types of each entry kind, after normalizing ids, times and durations |
| App metrics (rates, cache hit percentage, latency buckets) | `/api/app_metrics/*` | `udf_rate` in the http tests | the cache hit percentage after a fixed sequence |
| Scheduler lag, running jobs | `/metrics`, app metrics `scheduled_jobs` | no | not comparable at once (the timings differ); judged by the soak |

### 5.2 How to compare

This extends STUDY-122, so its harness is reused as it is:
- **Fixed scenarios, one test file each, local first** (the pattern of `unawaited-operations.test.ts` and
  `read-count.test.ts`). Each runs the same calls on both backends and reads the log stream after each step, from a
  cursor kept per backend. It compares one normalized projection per entry: `[identifier, cachedResult]`,
  `[identifier, usageStats]`, `[kind, willRetry, occInfo?.retryCount]`, and so on. Durations and timestamps are not
  compared as values, only as relations to other entries ("the hit's user time equals its miss's").
- **The generated programs, a cheap extension.** `harness/runner.ts` already calls each program step over HTTP. If it
  also tails the log stream, each step's entries can be compared as `[udfType, identifier, cachedResult, usageStats]`
  with the same normalizer (ids by rank). That puts usage and cache metadata into the nightly's ~20 000 programs at
  the cost of one log read per step. A program that repeats a query with no write between would then check the cache
  too. The generator emits such pairs often already.
- **The nightly list.** `scripts/nightly.sh` runs only `fixed`, `generated` and the component tests. Adding the
  metadata files (the cache file costs ~25 s, most of it the 19 s wait) is a one-line change there. It is bunvex-9f's
  file, so this study proposes it rather than doing it.

### 5.3 The prototype: the cache, as the log stream shows it

`packages/differential/test/cache-metadata.test.ts`, with its app in `packages/differential/cache-app/`. It is local
only, and skipped with a note without the binary, like its neighbours. Three cases:
1. A repeated query hits. A write outside its read set keeps it cached; a write into it invalidates it. A query that
   read the clock hits within 17 s. Expected `[miss, hit, hit, miss, clock:miss, clock:hit]`, the same on both.
2. Past 17 s (a real 19 s wait), the query that read no time still hits and the clock one misses.
3. `test.todo` (F4): a hit's user time, memory and timestamp are its miss's. A test since the fix (§10.2).

Results:
- **Pre-#751 main (`016dfccb`):** case 1 passes; **case 2 fails**: bunvex `plain:miss`, Convex `plain:hit`. That is
  #751, found from outside with no knowledge of the cause.
- **#751's branch** (`fix/vm-parity-from-bridge`, in a throwaway worktree): cases 1 and 2 pass.
- **This branch merged with main after #751 (`7683a19a`):** 2 pass, 1 todo, 0 fail.
- **`--todo`:** Convex gives `{sameUserTime, sameMemory, sameTimestamp}` = `true, true, true`; bunvex gives
  `false, false, false` (F4).

Run: `CONVEX_BACKEND_BIN=… bun test packages/differential/test/cache-metadata.test.ts` (about 21 s).

## 6. Mapping: which layer should catch what

| Class | Example | The layer that should catch it | Today |
|---|---|---|---|
| Cache behaviour over time | F1 | the metadata differential (§5.3), the soak's canary (R3), a unit test with an injected clock | #751's `meta.test.ts` (on main) |
| Busy loops and timer overflow | F2, F3 | a unit test with an injected clock; the soak's idle rule (R11, F2 only); a static check (I-25) | none |
| State not freed after clients go | I-05, I-11 | an `afterEach` "hub is empty" helper in the server suites; a Jepsen post-run `/metrics` check; soak R5–R6 | partial (`reads` only) |
| Unbounded buffers | I-19–I-23 | unit tests at the bound (most exist); soak R1–R2 for what nobody listed | mostly covered |
| Leaked handles | I-26–I-28 | soak R7; unit tests with a failing store (`faulty-store.ts` exists) | none |
| Exactly-once and lag | I-12, I-16 | unit tests (exist); Jepsen's set and log checks; soak R9 | covered except lag |
| Shutdown that hangs or leaves work | F5, I-24, S4 | a "shutdown finishes within N ms under load" test; the process-exits test | partial |
| Metadata parity | F4, I-10, I-30 | the differential's metadata files, then the generated programs with the log tail | read-count only (local) |
| Lost tests | any of the above deleted later | coverage floors: e.g. `function-log.ts`, `app-metrics.ts` and `rooms/hub.ts`, each added in the PR whose tests cover it | 23 files |
| Performance drift | p99 creep | soak R8; benches (manual) | manual only |

Coverage floors and mutation testing cannot catch this class: a line counts as covered even if its timer is never
cleared. A mutant that removes a cache store also survives every value test. What they *can* do is keep the new
invariant tests from being deleted, so the floors list should gain the files those tests cover.

## 7. Tests, sabotage, measurements

**In this PR:**
- `bench/soak/rules.test.ts`: 15 tests, run in the root `bun test`.
- `packages/differential/test/cache-metadata.test.ts`: 2 tests and 1 todo, local only.
- The soak itself: `bench/soak/soak.ts` and its app.

**Sabotage of the rules.** Each line is one change to `rules.ts`, made alone. Each made `rules.test.ts` fail, and the
file was restored and compared after each.

| Sabotage | `rules.test.ts` |
|---|---|
| a trend needs a slope **or** a shift (`&&` → `\|\|`) | 1 fails (noise) |
| the canary allows 100 extra misses | 1 fails (#751 pattern) |
| R5's allowance 30 instead of 3 | 1 fails (kept sessions) |
| R9a ignores jobs run twice | 1 fails |
| R11's limit 30 % instead of 3 % | 1 fails |
| memory judged from the warm-up, not from the caches being full | 1 fails (the cache filling) |

**The differential prototype** is its own sabotage: it failed on the pre-#751 main (F1 present) and passes on #751 and
on main after it (F1 fixed).

**The soak** is checked by its pilots (§4.6). Their failures were F1 and F2, the two load-visible bugs known to be on
main. Removing the far-future job made R11 pass (1.3 % against 66 %). They also found F6.

**Measurements:** none on default paths (nothing default changed).

**Checks:**
- `bun run typecheck`, `bun run check:deps` and `bunx biome ci` on the changed files pass.
- The full `bun test --isolate --timeout 30000`, after merging main with #751: 4 283 pass, 0 fail, 587 skipped.
- `rules.test.ts`: 15 pass. `cache-metadata.test.ts` against the oracle: 2 pass, 1 todo, 0 fail.

## 8. Owner questions

Each question gives what Convex does, what bunvex does, whether they are the same, why ("not built yet" vs
"impossible"), the impact on apps, and a recommendation.

**Q1. A nightly soak job in CI, and its budget.**
- Convex: no public soak; it relies on production telemetry.
- bunvex: none.
- Same: n/a, an addition to the test suite, not to the product.
- Why: not built yet.
- App impact: none directly. It catches F1-class bugs in a day instead of two weeks.
- **Recommendation:** add `soak-nightly.yml`: 45 minutes, SQLite, `ubuntu-latest`. On failure it opens or comments on
  an issue, as Jepsen does. It is **never a required merge check**: like the Jepsen and differential nightlies, it
  reports, and a red night blocks no PR. That is about 50 runner-minutes a night, free on a public repository.
  Postgres later as a matrix entry.

**Q2. A monthly long soak on the VPS (6 h).**
- Same answers as Q1.
- **Recommendation:** yes, by hand or by a cron on the VPS once Q1 has run green for a week. It is the only way to
  see leaks under 0.5 MB/min.

**Q3. F4: should a cache hit's log entry carry the reused run's user time, memory and timestamp, as Convex's does?**
- Convex: yes (`log_query`).
- bunvex: 0, 0, and the hit's own time.
- Same: no.
- Why: not built yet. STUDY-75 matched `cachedResult` and the lines, not these fields.
- App impact: log sinks and the dashboard's logs page show a cached call as free of user time and memory, and timed
  at the hit. Metering is unaffected.
- **Recommendation:** match Convex. A small fix in `functions.ts` (keep the run's user time and memory with the
  cached result, `extra` already holds its lines). The test is the prototype's todo case, made a test.

**Q4. A per-connection memory budget (I-09).**
- Convex: none published.
- bunvex: none.
- Same: yes (none on either).
- Why: not built yet.
- App impact: capacity planning for self-hosters.
- **Recommendation:** measure first (§4.5), publish the number in the parity notes, and assert it only if it
  regresses.

**Q5. The metadata differential files in the nightly list.**
- Convex: n/a.
- bunvex: local only.
- Same: n/a.
- Why: not built yet.
- **Recommendation:** bunvex-9f will add `cache-metadata.test.ts`, `read-count.test.ts` and the log-stream files to
  `scripts/nightly.sh` after #755 merges, for about 2 minutes a night more. The runner's per-step log tail (§5.2)
  follows on the same track.

**Q6. F6: SQLite's page cache, 256 MiB or SQLite's default (§4.7, measured in §4.8).**
- Convex: no pragma, so SQLite's default `cache_size` of 2 000 KiB (`crates/sqlite/src/lib.rs:93-99`).
- bunvex: `cache_size = -262144`, 256 MiB, since the first commit. DV-411 lists it among the pragmas it keeps, but
  only WAL was decided there.
- Same: no (STUDY-133 L13).
- Why: a choice, not "impossible". The owner decided on 2026-10-20 to measure first, and to match Convex if the
  default is not meaningfully slower.
- **The measurement (§4.8): it is meaningfully slower.**
  - Reads whose working set is past 2 MiB and in memory: −22 % throughput and +22 % p99 (the big store's hot set,
    steady state); −15 % throughput on a 200 MB store.
  - The cost is CPU: SQLite re-reads its B-trees' interior pages from the OS page cache, ~10× the `read()`
    volume, +27 % CPU a call.
  - When the disk is the bottleneck, or the working set is tiny, there is no gap.
- App impact:
  - Keeping 256 MiB: up to ~310 MiB more resident memory once the file passes 256 MiB (§4.7), and the soak's R1
    fails for the first ~70 minutes at its write rate.
  - Matching Convex: read-heavy apps whose working set does not fit in 2 MiB lose ~15–22 % of throughput on a small
    machine. Answers and memory are otherwise unchanged, and the index and query caches still serve repeated reads.
- **Recommendation:** keep 256 MiB, and record it as a DV (performance) in DV-411's row or a new one. A 20 %
  read-throughput loss is worse for apps than a bounded, documented ~300 MiB. Then fix the soak without a setting:
  seed a store of more than 256 MiB before the measured window and read it once in the warm-up, so the page cache is
  full before R1 judges. If the owner still prefers Convex's default, the change is one line, plus a test that the store's
  connection has a fresh connection's `cache_size` (not a constant: §4.8, "Seen on the way"). A middle size (32–64 MiB, roughly the interior pages of a 10 GB file) was
  not measured; it would need its own run before it is offered.

Not questions, because each matches Convex: the fixes for F1 (done, #751), F2, F3 and F5, and the suspected S1–S7 once
confirmed.

## 9. Recommended order and effort

| Step | What | Effort | Catches |
|---|---|---|---|
| 1 | This PR (the rules, the soak, the prototype); #751 already fixed F1 | — | F1 (regression guard) |
| 2 | Fix F2 and F3 with one capped `timerDelay` helper in core, a test per loop with an injected clock, and the I-25 rule in `check:deps` (rule 6, §3.1) in the same PR, so a new uncapped delay fails CI | 0.5 day | F2, F3, S8, and new ones |
| 3 | ~~Attribute F6~~ done (§4.7): SQLite's 256 MiB page cache, a plateau. ~~Measure Q6~~ done (§4.8): the default is ~20 % slower on in-memory reads; Q6 is the owner's | — | F6 |
| 4 | The server suites' `afterEach` "hub empty, cache consistent, no session left" helper (I-03, I-05, I-11, I-19, I-23) | 0.5–1 day | freed state across ~40 suites |
| 5 | ~~The soak nightly workflow (Q1)~~ done (§10.3), R1 report-only until Q6; then a week of watching for flakes | 0.5 day + a week of watching | trends, R1–R12 |
| 6 | Fix F5: a stopping scheduler stops retrying and waits a bounded time. Test: shutdown under contention within 1 s | 0.5 day | F5, S4 |
| 7 | The metadata files in the differential nightly (done: `cache-metadata`, `read-count`, `unawaited-operations`, `http-action-log-route` in `scripts/nightly.sh`, about 40 s a night); the runner's log tail (Q5, bunvex-9f, next) | 1–2 days | F4-class, usage, OCC shape |
| 8 | F4 fix (Q3) | 0.5 day | F4 |
| 9 | Confirm or dismiss S1–S7, one test each | 1 day | handles, backfill |
| 10 | Jepsen post-run `/metrics` check (R6 + fds per run) | 0.5 day | freed state under faults |
| 11 | Coverage floors: each step's PR adds the files its new tests cover to `scripts/coverage-floors.ts` in the same PR (not as a separate step) | in each PR | keeps the tests |
| 12 | The per-connection memory bench (Q4); the soak on Postgres; a monthly 6 h VPS run (Q2) | 1–2 days | slow leaks, drivers |

## 10. The owner's decisions (2026-10-19) and the F4 fix

### 10.1 Decisions

The owner approved every recommendation of §8 on 2026-10-19:

| Question | Decision | Who does it, when |
|---|---|---|
| Q1 | A nightly soak in CI: `soak-nightly.yml`, 45 minutes, SQLite, never a required merge check; a red night opens or comments on an issue | §9 step 5 |
| Q2 | A monthly 6-hour soak on the VPS, once Q1 has been green for a week | §9 step 12 |
| Q3 | F4 matches Convex: a cache hit's log entry carries the reused run's user time, memory and execution timestamp | done, §10.2 |
| Q4 | Measure the per-connection memory first, publish it in the parity notes, assert it only if it regresses (no budget yet) | §9 step 12 |
| Q5 | The metadata tests go in the differential nightly (`scripts/nightly.sh`), done by bunvex-9f | §9 step 7 |
| Q7 (2026-10-20) | R8 judges the p99 only on windows of at least 100 calls, the p50 alone below that (option (a)) | done, §10.3 |

None of them is a divergence, so none takes a DV number. DV-527, reserved for F4 in case something could not match,
is unused.

### 10.2 F4: a cache hit is logged as the run it reused

**Convex, at `72ce13c`.** One function logs every query the cache answers, ran or not: `_log_query`
(`crates/application/src/function_log.rs:684`, called from `log_query` at `:623`). The cache calls it at step 5 of
`CacheManager::_get` (`crates/application/src/cache/mod.rs:528–538`) with:
- the outcome it served: the run's own, kept in the cache entry;
- `is_cache_hit`, true for `CacheOp::Ready` and for `CacheOp::Wait` (`:462–470`);
- `start.elapsed()`, this call's time;
- this call's `caller` and `context`, which carries the request id and a new execution id (`ExecutionContext::new`,
  `:404`);
- on a hit, empty `tables_touched` (`perform_cache_op`, `:621` and `:654`).

The `FunctionExecution` it logs (`function_log.rs:726–758`) therefore mixes the run's fields with the hit's:

| Field (stream JSON, `crates/local_backend/src/logs.rs:202–245`) | On a hit | Source |
|---|---|---|
| `userExecutionTime` | the run's | `outcome.user_execution_time`, `:742` |
| `usageStats.memoryUsedMb` | the run's (64) | `outcome.memory_in_mb`, `:747` |
| `executionTimestamp` | the run's start | `outcome.unix_timestamp`, `:735` |
| `identityType` | the run's identity | `outcome.identity`, `:751`; `UdfOutcome.identity` is the running transaction's (`crates/udf/src/udf_outcome.rs:46`) |
| `logLines`, `returnBytes` | the run's | `:738`, `:725` |
| `cachedResult` | true | `was_cached`, `:740` |
| `timestamp` | the hit's log time | `self.rt.unix_timestamp()`, `:734` |
| `executionTime` | the hit's own | `execution_time`, `:741` |
| `requestId`, `executionId`, `caller`, `parentExecutionId` | the hit's own | `caller` and `context`, `:743`, `:752` |
| `usageStats` reads and writes | none | the hit's usage tracker |

The log sinks' `function_execution` event takes the same `FunctionExecution` (`udf_execution_record_log_events`,
`function_log.rs:272–330`): its `timestamp` is the hit's, its user time and memory are the run's. Usage is metered
apart, before the log entry is built: a hit is a `CallType::CachedQuery` (`:705`), with no duration, user time or
memory, while a run is an `UncachedQuery` with all three (`:706–711`).

The identity is the one field the study's §1 and Q3 did not name. It shows only when the run read no identity: its
result is stored for every caller (`cache/mod.rs:209–218`), so a hit by another caller shows the run's identity type.

**What apps observe.** `/api/stream_function_logs` (the CLI's `logs`, the dashboard's Logs page, which reads the
same entries) and every log sink show a cached query with the user time and memory of the run that computed it, and
that run's start time and identity type. A hit is no longer shown as free of user time and memory.

**bunvex.** A cached result already kept its run's lines (the query cache's `CacheCompanion`, STUDY-20 D2; the sync
hub's `Execution.logged`, STUDY-75). It now keeps the run's figures with them:
- `RunFigures` (`packages/server/src/logs.ts`): user time, memory, execution timestamp and identity type. The kept
  value is a `CachedRun`: the lines and the figures.
- `Running.ran()` (`function-log.ts:232`) gives the run's figures and fixes them, the first time the result is
  kept for the cache. `cachedQueryLogs.wrap`'s `capture` (`logs.ts:186`) calls it. Its own entry then gives the
  same figures (`figuresAt`, `:238`), so a hit equals its miss exactly, even when the hit is served (a caller that
  waited for the run) before the run's own entry is logged.
- On a hit, `cachedQueryLogs.replay` (`logs.ts:196`) hands the kept figures to the hit's `Running` (`reused`), and
  `Functions.completion` (`functions.ts:1411`) logs them instead of its own. That covers the HTTP API's queries
  through the engine's cache, a caller that waited for another's run, and the sync hub's reuse and joins
  (`sync.ts:707`, `:857`).
- The function log, the log streams (`/api/stream_function_logs`, `stream_udf_execution`), the dashboard and the
  log sinks all read that one `Completion`, so they all change together.
- The meter is given nothing of the run for a hit: no time, user time or memory (`functions.ts:1370–1373`), as
  Convex's `CachedQuery`. A query's compute was already 0 on a hit (its time is 0); the user time and memory are now
  zeroed for the meter explicitly, since the entry carries the run's.

A hit whose run kept no figures (a run outside a logged execution; none of the paths above) logs its own, with no
memory, as before.

**Divergences.** None. DV-527 is unused.

**Tests.**
- `packages/server/test/cache-hit-log-fields.test.ts` (new, on the test runtime's virtual clock, STUDY-132):
  - a hit logs the run's user time (exactly `BUSY_MS`), memory, execution timestamp and identity type (a user's
    run, an anonymous hit), and its own log time, wall time, request and execution ids, with the run's lines and no
    reads;
  - the log streams' `function_execution` of a hit has the same user time and memory, at the hit's time;
  - a caller that waited for another's run (`CacheOp::Wait`) logs the run's figures;
  - metering: a hit counts one call, adds no compute and no database I/O, and the meter is given no time, user time
    or memory for it, while its hit takes 40 ms of its own.
- `packages/server/test/sync-cache-hits.test.ts`: a session reusing another's result logs the run's user time,
  memory and start, in its own request; a new case where an anonymous session reuses an admin's run of a query that
  read no identity, and logs `instance_admin`.
- `packages/differential/test/cache-metadata.test.ts`, case 3, against the pinned binary
  (`precompiled-2026-10-10-72ce13c`), the former `test.todo`. It compares, per backend, a miss and its hit:
  - the flags;
  - whether the user time, memory, execution timestamp and identity type are the miss's;
  - the memory itself;
  - whether the hit is logged no earlier than the miss;
  - whether the request and execution ids differ;
  - the caller;
  - the hit's reads.

  Both backends give the same projection. Convex gives `true` for the four "same" fields and 64 MB, and different
  ids. A first version asserted that the hit is logged strictly later. On bunvex both can fall in the same
  millisecond, so it was flaky (2 runs in 6) and is now "no earlier".

**Sabotage.** Each change made alone, then restored. `shasum` of the sources and the `git diff` were compared after
the run.

| Sabotage | Fails |
|---|---|
| a hit logs its own figures (`ran = r.figuresAt(end)`) | 5 unit tests (HTTP, stream, wait, sync reuse, sync identity); the oracle case (`sameUserTime`, `sameTimestamp`) |
| `capture` keeps no figures | the same 5 unit tests |
| `replay` does not hand them to the hit | the same 5 unit tests; the oracle case (also `memoryUsedMb` 0) |
| the hit's identity type is its own | 2 (HTTP, sync identity) |
| the sync hub replays the lines only | 2 (sync reuse, sync identity) |
| the meter is given a hit's memory | 1 (metering) |
| the meter is given a hit's user time | 1 (metering) |
| the meter is given a hit's wall time | 1 (metering; it survived until the hit was made to take time of its own) |

Not sabotaged separately: a run's own entry reusing its kept figures. On the test clock a run's user time does not
change between the capture and the entry. It matters only when the user time is clamped to a wall time read before
the entry.

**Checks.**
- `bun run typecheck`, `bun run check:deps` and `bunx biome ci` on the changed files pass, with no new warning.
- The log-stream suites pass: 19 server files, 137 tests; 8 differential files against the binary, 20 tests.
  `cache-metadata.test.ts` alone: 3 pass, 0 todo.
- The full `bun test --isolate --timeout 30000`: 4 339 pass, 0 fail, 587 skipped.

**Measurements.** None. A cached miss allocates one more small object (its figures) and a hit one field
assignment. The rule of this round is no benchmarks while other sessions run them.


### 10.3 The soak nightly (§9 step 5, Q1)

**The job.** `.github/workflows/soak-nightly.yml`, as §4.3 proposed:
- every night at 04:07 UTC, after the Jepsen (03:17) and differential (03:41) nightlies, and by hand
  (`workflow_dispatch`, with `minutes` and `report_only` inputs);
- `ubuntu-latest`, Bun 1.4.2, SQLite, no services: `bun bench/soak/soak.ts --minutes 45 --out .data/soak
  --report-only "$REPORT_ONLY"`, `timeout-minutes: 60`;
- every run uploads `.data/soak/` as the `soak-report` artifact: `report.json` (every sample, re-judgeable),
  `report.md`, `backend.stderr` and the driver's log (`soak.log`). `report.md` is also the run's summary page;
- exit 1 (a rule failed) or 2 (the run broke) fails the job. A failed night opens, or comments on, the issue "Soak
  nightly: a rule failed" with `report.md`, as the Jepsen nightly does;
- never a required merge check (Q1);
- a pull request that changes the workflow or `bench/soak/**` runs a 5-minute smoke. It judges nothing (too few
  samples past the warm-up), so only exit 2 fails it; a failed rule there is a notice.

**R1 is report-only until Q6 is decided.** At the soak's write rate SQLite's 256 MiB page cache needs ~70 minutes
to fill (§4.7), longer than the run, so R1 would fail every night for a known, bounded reason. Rather than drop
the rule, the soak has a switch:
- `soak.ts --report-only <ids>` (comma-separated rule ids, `parseReportOnly` in `rules.ts`). The listed rules are
  still judged, printed and kept in `report.json` (`reportOnly: true`) and `report.md` ("fail (report-only)"); only
  the exit code (`exitCode`) leaves them out. An unknown id is exit 2, so a typo cannot silence a rule. Ids are exact:
  `R1` is not R10, R11 or R12. Empty by default: a local run judges every rule.
- The workflow's `SOAK_REPORT_ONLY: R1` sets it. A failed report-only rule also shows as a warning on the run.
  The dispatch input `report_only` overrides it for one run (`none`: every rule fails the job).
- **Once Q6 is decided, empty `SOAK_REPORT_ONLY`**, in the same PR as the decision: dropping the pragma (the
  recommendation) makes R1 pass in 30 minutes (§4.7, `f6-sqlite-cache-2mib`); keeping 256 MiB needs the memory
  warm-up to see the page cache first (Q6).
- Every other rule, R2–R12, fails the job.

`rules.test.ts` (18 tests now) covers the switch: a leaking run with R1 report-only exits 0 and still reports R1
failed; with no report-only rule it exits 1; R3, R10, R11 and R12 failing still exit 1 with R1 report-only; an
unknown or lower-case id throws; the ids are exactly the rules `judge` gives.

**Proof on the test VPS** (2 vCPU, 8 GB, Ubuntu; Bun 1.4.2 as in CI; this branch; under
`/root/bunvex-soak-nightly`). The workflow's `soak` step was extracted from the YAML verbatim and run under
`bash -e`, with `GITHUB_ENV` and `GITHUB_STEP_SUMMARY` as files and the event `schedule`:

| Run | Setup | Exit | Result |
|---|---|---|---|
| A | 8 min, the step as written | 1 | R1, R2 not judged (the index cache had not filled). R8 failed on 3 operations. Everything else passed, R11 at 1.7 % of a core |
| B | 9 min, `--index-cache-mib 2` added so R1 is judged | 1 | R1 "fail (report-only)" at 5.0 → 8.4 MB/min, with its `::warning`, not counted. R2 and R8 failed. R2 because a 2 MiB cache fills in seconds and the heap is still growing at 5 minutes |
| C | 6 min, the step as written, **sabotage**: core's `timerDelay` without its 2^31−1 ms cap (F2 back) | 1 | **R11 failed alone: 73.4 % of a core** (the 30-day job). The file was restored, `cmp` identical |
| D | 8 min, dispatch input `report_only=R1,R8`, no sabotage | **0** | R8 shown as "fail (report-only)" with warnings. R11 1.3 %. So C's exit 1 is R11 alone |
| F | **45 min, the step as written** (the nightly), before Q7 | **1** | R1 report-only, 5.0 MB/min (+115 MB; the page cache, §4.7). **R8 `schedule` failed**: p99 38.1 → 64.2 ms. Every other rule passed: canary 7 misses for 7 writes, 5 411 jobs each run once, lag p99 ≤ 172 ms, fds flat, R11 1.4 % |

Short runs are expected to fail R8. Their thirds are minutes apart while the store and the caches are still
growing, which is why the pull-request smoke fails only on exit 2.

**R8 at 45 minutes (F), which raised Q7.** The one failure in F is the `schedule` mutation's p99 (1.68×, +26 ms; the
limits are 1.5× and +20 ms):
- `schedule` runs at 2 calls a second, so a 15 s window holds a median of 30 calls, and its "p99" is the
  window's slowest call. The other operations have 150–300 per window.
- Its p99 by 5 minutes is 21, 26, 45, 42, 33, 43, 72, 34, 81, 30 ms: it moves up and down, it does not climb.
  Judged from the memory warm-up (t = 751 s) instead, it still fails (36.9 → 71.1 ms); its p50 is flat
  (5.5 → 6.4 ms).
- Earlier runs: `f6-sqlite-cache-256mib` (30 min) failed R8 on the canary's p99 and the hot counter's p50;
  `f6-sqlite-cache-2mib` and `f6-main-2h` passed it. One run each cannot say whether the page cache plays a part.

Without a change, the nightly could go red on R8 on some nights. Q7 asked the owner what to do; R8 was never made report-only.

**Q7. R8 and low-rate operations.**
- Convex: no public soak (Q1), so no rule to compare. bunvex: R8 compares the median of per-window p99s for every
  operation with at least 5 calls in a window.
- Same: n/a, a test-suite rule, not product behaviour. Why: not built yet (the rule predates per-operation call
  rates in the workload).
- App impact: none. Soak impact: a nightly that fails on a 30-call window's slowest call is noise, and a week of
  watching (§9 step 5) would be spent on it.
- Options:
  - (a) judge R8's p99 only on windows of at least 100 calls, and use the p50 alone below that. `schedule` keeps its
    p50 check. The other operations do not change, and `rules.test.ts`'s doubling-latency case (100 calls per
    window) still fails.
  - (b) let the driver compute each operation's percentiles over 60 s windows, so `schedule` has ~120 calls per
    window. More faithful, but every report changes shape.
  - (c) keep R8 as it is and triage red nights by hand.
- **Recommendation:** (a): a rule-only change with a test and a sabotage. Then one more 45-minute VPS run
  re-judges F, and the week of watching starts. R8 is not made report-only in the meantime.

**Q7 decided (owner, 2026-10-20): option (a).** `rules.ts` has `R8_MIN_P99_CALLS = 100`. An operation's p99 is
compared (1.5× and +20 ms, and the 1 s ceiling) only on its windows of at least that many calls, if there are at
least 6 of them. The p50 (1.3× and +10 ms) is judged on every window of 5 calls or more, as before. The detail then
reads "p99 not judged (under 100 calls a window)". In the soak `schedule` and `search` (2 calls a second, ~30 a window) are below
the threshold; the HTTP queries and the canary have ~150, the hot counter ~148, the sync mutation ~300.
- Tests (`rules.test.ts`, 19 now): a p99 that doubles with a flat p50 fails R8 on 100-call windows and passes on
  30-call windows ("p99 not judged"); a p50 that grows on 30-call windows still fails; with alternating 30- and
  100-call windows, the p99 is judged on the full ones alone.
- Sabotage, each change alone, then restored (`shasum` identical): the threshold ignored (p99 on every window): 1
  test fails; the threshold at 30: 1 fails; the p50 not judged: 1 fails; the p99 never judged: 2 fail.
- F's `report.json`, judged again with the new rule: R8 `schedule` passes (p50 5.5 → 6.4 ms, p99 not judged).
  Only R1, which is report-only, fails.

**The nightly green (G, 2026-10-20).** The 45-minute step as written, on the test VPS, with this rule: **exit 0**.
- R1 "fail (report-only)": 5.2 MB/min, +114 MB, the page cache (Q6), shown as the run's warning.
- Every other rule passed:
  - R2: 0.2 MB/min.
  - R3: 8 misses for 8 writes.
  - R8: `schedule` and `search` on their p50 (8.0 → 9.0 and 6.7 → 7.1 ms). The others on both percentiles; the hot
    counter's p50 66.7 → 86.1 ms is 1.29×, close to the 1.3× limit.
  - R9a: 5 387 jobs, each run once. R9b: lag p99 ≤ 305 ms.
  - R10: max 133 ms.
  - R11: 2.4 % of a core.
  - R12: no errors.

One run on a 2-vCPU machine, so the week of watching (§9 step 5) still applies. If the hot counter's p50 is
what fails next, look at that limit first.

**Not here.** The monthly 6-hour VPS soak (Q2) is §9 step 12, once this job has been green for a week; nothing in CI
schedules anything against the VPS.
