# STUDY-132 — A deterministic runtime for tests, and why the tests flaked

- **Status:** implemented in parts (T1 of STUDY-131, accepted by the owner on 2026-10-05: module by module,
  starting with the flaky tests). PR 1 (loopback test servers), PR 2 (the runtime, the execution limits and
  the concurrency limiters) and PR 3 (three test races) are written; §6 lists what is left.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-131](STUDY-131-debugging-and-observability.md) §5 (T1), [STUDY-41](STUDY-41-execution-limits.md)
  (the user time budget), [STUDY-68](STUDY-68-function-limits.md) (the concurrency limiters),
  [STUDY-29](STUDY-29-index-backfill.md) (the index backfill)

This is test infrastructure. Nothing an app observes changes: production keeps the process's clock and timers,
and every divergence table below is empty.

## 1. How Convex does it

### 1.1 One `Runtime` for every clock read and every wait

Convex's backend never reads the clock or sleeps directly. Everything goes through a `Runtime`
(`crates/common/src/runtime/mod.rs:280-345`):

- `wait(duration)`: a future that resolves after `duration` (the only way to sleep);
- `system_time()` / `unix_timestamp()`: the wall clock, "potentially-virtualized";
- `monotonic_now()`: the monotonic clock, as a `tokio::time::Instant`;
- `spawn`, `spawn_thread`: tasks on the runtime's executor;
- `rng()`, `new_uuid_v4()`: its randomness; `pause_client()`: the test pause points.

Production uses `ProdRuntime` (`crates/runtime/src/prod.rs:215-250`): `wait` is tokio's sleep,
`system_time` is `SystemTime::now()`, `monotonic_now` is `tokio::time::Instant::now()`.

The modules that time something take the runtime and use it. For example:

- the user-time budget (`crates/isolate/src/timeout.rs:106-146`, `:187`, `:248`, `:365`): `rt.monotonic_now()`
  for the start and the pauses, `rt.wait(deadline - now)` for the deadline;
- the concurrency limiters (`crates/application/src/application_function_runner/mod.rs:525-545`): a permit
  wait races `rt.wait(self.semaphore_timeout)`;
- the sync worker's heartbeat (`crates/sync/src/worker.rs:242`, `:414`, `:490`): `rt.wait(HEARTBEAT_INTERVAL)`;
- the committer (`crates/database/src/committer.rs:1559`) and retention (`crates/database/src/retention.rs`,
  `rt.wait(delay)` between passes).

### 1.2 The test runtime

Tests run on `TestRuntime` (`runtime::testing`, behind the `testing` feature of `crates/runtime/Cargo.toml`;
the module itself is not in the public repository). A test takes it as an argument with
`#[convex_macro::test_runtime]`. Its clock is tokio's paused clock: time moves only with
`rt.advance_time(d)`, or when every task is idle and the next timer is due.

The sync worker's tests show the style (`crates/sync/src/worker_tests.rs:288-320`): the test advances half a
heartbeat, sends a client message, advances the rest, and asserts the ping was sent **exactly** at
`start + HEARTBEAT_INTERVAL` (`assert_eq!(sent_at, ping_deadline)`). No sleep, no tolerance, and the same
result on any machine.

## 2. What an app can observe

Nothing. This is how bunvex's own tests run. Production uses the real runtime, which reads the same clocks
and sets the same timers as before (§3.2 measures it).

## 3. How bunvex does it

### 3.1 The runtime (`@bunvex/core`, `runtime.ts`, `test-runtime.ts`)

```ts
interface Runtime {
  now(): number;           // wall clock, ms since the epoch (Date.now)
  monotonicNow(): number;  // monotonic, ms (performance.now)
  setTimeout(fn, ms): RuntimeTimer;    clearTimeout(t): void;
  setInterval(fn, ms): RuntimeTimer;   clearInterval(t): void;
  sleep(ms, signal?): Promise<void>;
}
```

- `realRuntime` is the process's clock and timers, captured when `runtime.ts` loads, before
  `installDeterminism()` replaces the globals for queries and mutations. Engine code that reads the time
  through it is never frozen nor refused inside an execution. `determinism.ts` imports it first to keep
  that order.
- `TestRuntime` (`@bunvex/core/test-runtime`) has virtual time. It starts at a fixed wall instant
  (2026-01-01T00:00:00Z, or `{ now }`) and monotonic 0, and moves only when the test says:
  - `advance(ms)`: every timer due by then fires in order, the clock reading its own instant. Between two
    timers the process runs until a real turn passes in which no new timer was set, so what a timer starts
    settles before the next one.
  - `runUntilIdle()`: fire timers until only unref'd ones are left (heartbeats and sweepers are unref'd):
    what a process would do before it could exit. A referenced interval makes it throw.
  - `runUntilSettled(p)`: tokio's auto-advance, for one promise. Whenever a turn passes and `p` is still
    pending, the time jumps to the next timer.
  - `blockFor(ms)`: the thread is busy (a function's own work). The clock moves and no timer fires
    meanwhile. Those that came due fire late, as a real one does after the event loop was blocked.
  - A callback runs in the async context it was set in (`AsyncLocalStorage.snapshot()`), as a real timer's.
- The engine takes it as an option (`new Engine(schema, persistence, { runtime })`, `engine.runtime`), and
  the server's modules use `engine.runtime`.

What it does not virtualize: real I/O. A socket's answer, a child process and a `fetch` take the time they
take. A test awaits them as usual, then moves the time. `runUntilSettled` is for work that waits on virtual
time only.

### 3.2 What is on the runtime so far (PR 2)

| Module | What reads the time | Before | Now |
|---|---|---|---|
| `core/determinism.ts` | the user-time budget (`UserTimer`: start, pauses, end) | `performance.now()` | the timer's clock: `engine.runtime.monotonicNow` |
| `server/functions.ts` | the budgets of user functions and of system functions (STUDY-76's warnings) | the real clock | `engine.runtime` |
| `server/action-permits.ts` | the permit wait's timeout (`TooManyConcurrentRequests`) | `setTimeout` | the limiter's runtime (`functionLimitsFromEnv(env, action, runtime)`, `new ActionPermits(max, waitMs, runtime)`); `Functions` passes `engine.runtime` |

**The cost.** The budget is checked at every store call (§1.1: twice, plus a pause), so its clock is on the
hottest path a function has. Calling the clock through the timer's field, with no other change, cost
30–50 ns per store call (`storeCall` around a no-op, 1M calls, 290 → 330–360 ns). The timer therefore keeps
`clock: null` for the process's clock and calls it directly, and calls a test runtime's through the field.
Measured again, interleaved, on a loaded machine (load 11–13 on 8 cores), 4 rounds × 9 samples:
base 279–285 ns, branch 281–290 ns per call: the same within noise (≤ 2 %).

### 3.3 Why the tests flaked: the causes found

Each flaky test was run alone, 8–50 times, under load: a parallel `bun test --isolate` of other packages
(values, search, persistence, protocol, client, react-query, auth, file-storage), load average 11–18 on
8 cores. The causes, from the failures seen here and in other sessions' logs:

| Test | Cause | Timing? | Fix | PR |
|---|---|---|---|---|
| `argument-errors` "a result that misses `returns`" | **A stranger answered.** The test server listened on every address on port 0 and the test called `127.0.0.1:<port>`; macOS gave it a port another process held on 127.0.0.1, which got the request (`null` body, a 400 with no body, a 404) | no | test servers bind 127.0.0.1 (§3.4) | 1 |
| `http-actions` "both ways in" | the same: every request is to `127.0.0.1:<port>`; and, in the same file, "past the action limit" assumed a request held the permit 20 ms after it was sent | no / yes | 127.0.0.1; the second waits for the permit holder and the 50 ms wait runs on the test runtime | 1, 2 |
| `http-format`, `audit-log`, `storage-bandwidth`, `write-throughput` | the same stranger (they all talk to a port-0 server at 127.0.0.1) | no | 127.0.0.1 | 1 |
| `cli/deploy` "a second deploy changes one module" | the same: `bunvex deploy` against a port-0 server exited 1 in 30 ms, before any work | no | 127.0.0.1 | 1 |
| `sync-e2e/client-auth` (expectAuth, initialAuthTokenReuse) | the same, at one remove: the issuer's JWKS is fetched from a port-0 server at 127.0.0.1; a stranger's answer made every token "not verified" (the fetches seen: `[false, true, true, true]`, the refused-token pattern) | no | 127.0.0.1 | 1 |
| `sync-e2e/oracle-auth` "signing in re-runs queries…" | **the wall clock's second.** The fetcher signed `{ sub: "ada" }` with `iat` = now in seconds; when the cached and the fresh token were signed in different seconds they differed, so the official client confirmed twice (`onChange` `[true, true]`), else once (`[true]`); and the JWKS stranger above | yes, but not ours | the fetcher signs one token (fixed `iat`); 127.0.0.1 | 3, 1 |
| `execution-limit` "a nested call has its own budget" | **real time.** The test spent its budget by spinning on the real clock (`busy(40)` against a 50 ms limit): on a loaded machine the call's own overhead, or a preemption, took the 10 ms margin | yes | the budget counts on the engine's runtime; the test's functions "work" with `rt.blockFor(ms)`, so the budget is exact (now also asserted at 50 ms, not over, and 51 ms, over) | 2 |
| `function-limits` "a query without a permit" | **an assumed order.** `Bun.sleep(10)` stood for "the first query holds the permit"; when it did not yet, the sync query took the permit, nothing closed the session, and the test timed out (30 s) | yes | wait until the limiter says the permit is held, and time the 40 ms wait out on the test runtime | 2 |
| `code-version` "a request in flight finishes on the code it started with" | **an assumed order.** `Bun.sleep(50)` stood for "the action is running on v1"; when the request had not reached the action yet, it ran on v2 | yes | the action's outbound request is the signal: the new version is installed once the held server has received it | 3 |
| `index-backfill` crash-resume | **an assumed speed.** The child printed "checkpoint" and kept backfilling at 2 000 entries a second until the parent's SIGKILL arrived; a parent slower than ~2 s (load) let the child finish, delete its checkpoint and leave nothing to resume from. A 3 s stall before the kill makes it fail every time | yes | the child stops writing once its first checkpoint is durable, then prints "checkpoint": the kill can come any time after | 3 |

None of them was fixed by a longer timeout.

### 3.4 Test servers on 127.0.0.1 (PR 1)

A test server is started with `port: 0` and no hostname, so Bun listens on every address, and the test talks
to it at `http://127.0.0.1:<port>`. On macOS:

- the kernel chooses a port-0 port for a wildcard socket with `SO_REUSEADDR` (Bun sets it) checking exact
  address matches only, so it can choose a port another process holds on 127.0.0.1;
- a connection to 127.0.0.1 then goes to that more specific listener.

Measured: a probe started 7 500 servers (port 0, no hostname) and called each at 127.0.0.1. Four answers came
from strangers: an editor helper on `127.0.0.1:61194` (twice) and other test runs' Bun servers on
`127.0.0.1:63716` and `:64004` (`lsof` named them). With the fix, 7 500 more: none.

The fix is a test preload, `scripts/test-loopback.ts` (in `bunfig.toml`, and in sync-e2e's React run): a
`Bun.serve` call without a hostname (and not on a unix socket) listens on 127.0.0.1. The kernel refuses it a
port held on 127.0.0.1. Production servers are not affected; the preload is loaded by the test runner only.
`scripts/test-loopback.test.ts` checks the preload: a server gets 127.0.0.1, and it cannot take a port a
stranger holds on 127.0.0.1 (a wildcard listener can).

## 4. Divergences

None: test infrastructure only.

| # | Divergence | Why | Decision |
|---|---|---|---|

## 4b. Additions (beyond Convex)

None. `@bunvex/core/test-runtime` is bunvex's own test tooling, as Convex's `runtime::testing`.

| # | Addition | Why | Decision |
|---|---|---|---|

## 5. Tests

- `core/test/test-runtime.test.ts`: timers fire in order at their instants; a timer set by a timer in the
  same advance; intervals, cleared from their own callback too; `runUntilIdle` with unref'd heartbeats, and
  its error on a referenced interval; `runUntilSettled` across work that takes real turns, a rejection, and
  its error when nothing is left to fire; `blockFor` fires late, not early; `sleep` aborted; the callback's
  async context; the real runtime's clocks, `sleep` and `clearTimeout`.
- `server/test/execution-limit.test.ts`: on virtual time; the budget at exactly 50 ms (not over) and 51 ms
  (over).
- `server/test/function-limits.test.ts`, `action-permits.test.ts`, `http-actions.test.ts` (the action
  limit): the wait is still pending at 39 ms (49 ms) of virtual time and refused at 40 ms (50 ms); 60 ms of
  real time do not time a waiter out.
- `scripts/test-loopback.test.ts`: the preload.

**Under load, 50 runs in a row** (a parallel `bun test --isolate` of other packages as load): the results
are in each PR's body.

**Sabotage** (each restored after):

| Break | What failed |
|---|---|
| the preload binds `0.0.0.0` | both `test-loopback` tests |
| `Functions` builds its timers on the default (real) clock | 3 of 5 `execution-limit` tests |
| a pause is not counted (`t.paused += 0`) | "time awaiting the store does not count…", "a nested call has its own budget…" |
| the budget fails at the limit (`>=`) | "a nested call has its own budget…" |
| the limiter times out on the global `setTimeout` | `action-permits` "a wait past the timeout…", `function-limits` "a waiter gets the freed permit before its timeout" |
| `advance` fires timers due before the target only (`<`) | 2 `test-runtime` tests, 3 `function-limits` tests |

The races of PR 3, forced on purpose:

| Race | Result |
|---|---|
| the crash test's parent stalls 3 s before its SIGKILL, with the old child | crash-resume fails; with the new child, it passes |
| `code-version` installs v2 before the request reaches the action (`Bun.sleep(0)` for the signal) | fails ("done v2") |
| `oracle-auth`'s fetcher signs a different token at each fetch, as across a second boundary | fails 2 runs of 3 |

## 6. What is left (later PRs)

Still on the process's clock, by module, roughly in the order their tests would gain:

- **The sync hub** (`server/src/sync.ts`): the heartbeat, the client-clock skew, the splay of reruns.
  Convex's own heartbeat test (§1.2) is the model.
- **The scheduler and crons** (`server/src/scheduler.ts`, `cron-executor.ts`): their tests poll with sleeps
  for the job to run.
- **The index worker** (`core/src/index-worker.ts`): its rate limiter and checkpoint interval
  (`performance.now()`, `setTimeout`); the backfill tests pace it with real `chunkRate`s.
- **Retention, table summary checkpoints, session cleanup, usage gauges, log sinks, imports and exports**:
  periodic workers on `setInterval` / `setTimeout`.
- **The action timeout and the HTTP response-head timeout** (`action-timeout.ts`, `http-actions.ts`).
- **The committer's flush retry backoff** (`committer.ts`).
- **The query cache's clock** (`cacheClock`, already injectable) and the token verifier's (`now`, already
  injectable) can take `engine.runtime` instead of their own option.
- Many tests still use `Bun.sleep(n)` to mean "the other side has got there"; the ones fixed here show
  the pattern (wait for the state, then move virtual time).
