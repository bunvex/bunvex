# STUDY-77 — The action timeout

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04; the tests removed from
  it, at bea52bde0 (Rust) and c358201e1 (TypeScript)
- **Related:** [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md) (the 1 s limit of queries and
  mutations, N5), [STUDY-68](STUDY-68-function-limits.md) (the action permits),
  [STUDY-31](STUDY-31-http-actions.md) (HTTP actions, the 300 s head timeout),
  [STUDY-30](STUDY-30-scheduler-and-crons.md) (scheduled actions)

## 1. How Convex does it

**The knobs** (`crates/common/src/knobs.rs`):

- `V8_ACTION_USER_TIMEOUT` (`V8_ACTION_USER_TIMEOUT_SECS`, 1800 s, :208) is the official action timeout.
- `NODE_ACTION_USER_TIMEOUT` (`NODE_ACTION_USER_TIMEOUT_SECS`, 600 s, :217) is the one for `"use node"`
  actions.
- `V8_ACTION_SYSTEM_TIMEOUT` (300 s, :1057) bounds the time an action spends paused.
- The docs' limits page says 30 minutes for the Convex runtime and 10 minutes for Node
  (`npm-packages/docs/docs/production/state/limits.mdx:144-146`). `actions.mdx:216` still says "Actions time
  out after 10 minutes", which is stale for V8 actions.

**V8 actions** (`crates/isolate/src/timeout.rs`, `environment/action/mod.rs`, `termination.rs`):

- `start_request` creates a `Timeout` with the user and system limits (`timeout.rs:376-396`). It starts once
  the action holds its concurrency permit, so time waiting in the queue does not count.
- What counts as user time:
  - User time is wall-clock time minus the time paused.
  - An action pauses only while it initializes (`PauseReason::UdfInitialize`: config, module metadata,
    preloading; `action/phase.rs:177`). That time counts against the 300 s system budget.
  - Its syscalls are **not** paused (`action/mod.rs:1165-1169`: "actions can call queries, mutations, and
    other actions as syscalls, so these should still count towards the user-code timeout"). So awaited
    `runQuery`, `runMutation`, `runAction`, `fetch`, storage calls and timers all count.
  - The old fetch tests check this: an awaited fetch that never answers ends in "Function execution timed
    out" (`crates/isolate/src/tests/fetch.rs:325-331` at bea52bde0).
- Past the limit the isolate is terminated (`IsolateTerminationReason::UserTimeout`).
  - The result is the user error `JsError::from_message("Function execution timed out (maximum duration:
    1800s)")` (`termination.rs:259-261`, `:349-351`; the duration in Rust's `Debug` form).
  - Its display ends with a newline (`crates/common/src/errors.rs:815-829`).
  - It overrides whatever the action would have returned (`action/mod.rs:723-734`).
- Termination drops everything in flight (`action/mod.rs:247-253`, `:1218-1224`):
  - pending fetches;
  - a `runMutation` (run inline, so it may or may not have committed);
  - a child action (cancelled).
  - Mutations the action committed before stay committed: each is its own transaction.
- After a timeout Convex logs `N unawaited operation(s): [...]` for the tasks still pending
  (`action/mod.rs:1283-1315`, run at `:740`). bunvex has no such warning for any action yet (§4, A3).

**Node actions** (`npm-packages/node-executor/src/executor.ts:423-472`):

- The invocation is raced against `timeoutSecs`. The timer starts after the module's import.
- Past it the action fails with ``Action `<export name>` execution timed out (maximum duration 600s)``.
  - It is an error without frames, so the message alone (`crates/node_executor/src/executor.rs:171-186`).
  - It is a user error.
- The process is not killed: `syscalls.dispose()` aborts its callbacks in flight (`syscalls.ts:302-307`).
- A process-level backstop at 600 + 5 s answers "Function execution unexpectedly timed out. Check your
  function for infinite loops or other long-running operations." (`crates/node_executor/src/local.rs:285-296`,
  `executor.rs:132-137`). It matters only when the Node process itself is stuck.

**Who sees it:**

- **Caller.** `/api/action` answers 200 with `{status: "error", errorMessage: "[Request ID: …] Server
  Error\nFunction execution timed out …", logLines}` (`crates/local_backend/src/public_api.rs:721-764`,
  `crates/application/src/redaction.rs:163-170`). It is a `UserError` (`application_function_runner/mod.rs:1351-1358`),
  so the details are redacted only when the deployment redacts.
- **Function log.** The log records a failure with that error. The lines printed before the timeout are kept
  and were already streamed as progress (`crates/common/src/log_lines.rs:706-720`).
- **Scheduled action.** Its job ends `failed` with the error's display, trailing newline included
  (`crates/application/src/scheduled_jobs/mod.rs:992-995`). It is never retried: actions run at most once.
- **HTTP actions** share the action environment, so they get the same 1800 s. With no response head sent, the
  answer is a 500 `{code: "[Request ID: …] Server Error: Function execution timed out …", trace}`
  (`action/mod.rs:383-415`). The 300 s HTTP server timeout (408) comes first for a client that waits.

## 2. What an app can observe

1. An action (V8) fails after 1800 s from when it started running, counting everything it awaited, with
   `Function execution timed out (maximum duration: 1800s)`. A Node action fails after 600 s with
   ``Action `name` execution timed out (maximum duration 600s)``.
2. It is a user error: `Server Error` plus the message for the caller (unless redacted), a failure in the
   function log with the earlier lines, a `failed` scheduled job with `<message>\n`, and a 500 for an HTTP
   action that sent no head.
3. Nothing the action started runs further: no later database call, scheduling, storage call or fetch. An
   in-flight fetch ends, and a child action is cancelled. What it already committed stays.
4. Its permit is free again.

## 3. How bunvex does it

`packages/server/src/action-timeout.ts`, used by `Functions.runAction` and `runHttpAction`:

- **Knobs.** `Functions.actionTimeoutMs` and `nodeActionTimeoutMs` come from Convex's knobs
  (`V8_ACTION_USER_TIMEOUT_SECS`, 1800; `NODE_ACTION_USER_TIMEOUT_SECS`, 600).
- **The timer.** `withActionTimeout` starts inside the permit (`ConcurrencyLimiter.run`), as Convex's.
  - It is wall-clock time, so everything awaited counts.
  - On time, the action settles as its handler does.
  - Past the limit it rejects with `ActionTimeoutError`, which is reported as its message alone, as
    `JsError::from_message`. The permit is then released.
- **Who sees it.** Callers, the function log, the scheduler and the HTTP action server already treat a
  rejected action as a user error, so they show what Convex shows.
- **Cutting the handler off.** One Bun process cannot stop running JS (STUDY-41 N5), so the handler is cut off
  instead.
  - Each action runs with an `AbortSignal` in an `AsyncLocalStorage`. A child action's signal follows its
    parent's.
  - At the timeout the signal is aborted with the error. Then:
    - `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`, `ctx.vectorSearch` and every `ctx.scheduler` and
      `ctx.storage` method refuse to start, throwing the timeout;
    - `fetch` refuses too, and a fetch in flight is aborted, because the global `fetch` combines the action's
      signal with the request's own (`setFetchSignal` in `@bunvex/core`);
    - a child action's calls are refused the same way.
  - A mutation that already reached the committer finishes, which is one of Convex's two outcomes.
  - Lines the handler logs after the timeout are not streamed to the function log (`r.onLine` is cleared at
    completion), as a terminated isolate logs nothing.

**Measured** (an in-memory deployment, 5 runs of 50 000 / 20 000 / 5 000 sequential actions, median, Apple
silicon):

| Action | `main` | This branch |
|---|---|---|
| returns at once | 1.39 µs | 1.99 µs |
| one `ctx.runQuery` | 2.35 µs | 3.16 µs |
| one local `fetch` | 62.3 µs | 64–67 µs |

So the timeout adds about 0.6 µs per action (a timer, an `AbortController`, an `AsyncLocalStorage` run). A
fetch pays about 2–4 µs more, for the combined signal.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| A1 | The cut-off handler's JS keeps running until it ends: it can no longer reach the database, the scheduler, storage or the network, but it can still use the CPU and its own memory. A synchronous loop is not interrupted. | One Bun process cannot terminate running JS. This is the same gap as STUDY-41 N5 (accepted, owner 2026-10-02) and DV-02. | follows N5 (accepted) |
| A2 | No separate 300 s system budget for actions | It only bounds an isolate's initialization and module loading, which bunvex does not have (code is loaded once per version, STUDY-35) | not observable |
| A3 | No `N unawaited operations` warning, after a timeout or at the end of any action | A missing feature of its own (dangling promises), not part of the timeout; recorded as a gap in server-api | gap |
| A4 | An HTTP action's streamed body is not cut at the timeout once its head is sent | bunvex's limit covers the handler, which returns at the head. Convex appends the error to the stream. A body still streaming 1800 s after the request is rare. | gap |

## 5. Tests

`packages/server/test/action-timeout.test.ts`:

- defaults and knobs;
- in-time actions untouched;
- the V8 message, with awaited queries counted;
- the Node message with the export name;
- the cut-off handler:
  - its in-flight fetch is aborted;
  - `runMutation`, `scheduler`, `storage` and a new `fetch` are refused;
  - nothing is written;
- a child action cut off with its parent;
- the permit freed;
- the function log's failure with the earlier lines, and no lines after the timeout;
- `/api/action`'s 200 with `Server Error\n<message>` and the log lines;
- a scheduled action `failed` with `<message>\n`;
- an HTTP action's 500.

Sabotage, each check broken in turn:

- not aborting the signal fails the two cut-off tests;
- not rejecting at the timeout fails 9 of the 11 tests;
- not clearing `onLine` fails the late-lines test.

## 6. Open questions

None.
