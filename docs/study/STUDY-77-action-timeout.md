# STUDY-77 — The action timeout

- **Status:** implemented; §7 (the end of an action, owner 2026-10-21) implemented
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
  (`action/mod.rs:1283-1315`, run at `:740`). bunvex has had the warning since STUDY-76; STUDY-143 matched
  what it lists to Convex's, a timeout included (§4, A3).

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
| A3 | No `N unawaited operations` warning, after a timeout or at the end of any action | A missing feature of its own (dangling promises), not part of the timeout; recorded as a gap in server-api | resolved: built by STUDY-76, matched to Convex by [STUDY-143](STUDY-143-unawaited-operations.md) |
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

## 7. The end of an action (owner, 2026-10-21)

Found by the function sandbox's parity work (STUDY-171 §12.6, §12.11): under `vm` a V8 action's leftover JavaScript
went on after its answer. The owner decided to match Convex.

### 7.1 How Convex does it (re-read at `72ce13c`)

- The action's loop runs the isolate until its result is in (`crates/isolate/src/environment/action/mod.rs:1059-1225`:
  task answers, stream chunks, the timeout), so a timer (a `Sleep` task, `task.rs`) that fires while it runs resolves
  as any task does.
- Then it ends: "drain all remaining async syscalls that are not sleeps" is closing the task channel and shutting the
  task executor down (`mod.rs:1226-1233`, `pending_task_sender.close()`, `running_tasks.shutdown()`;
  `SpawnHandle::shutdown` stops the spawned task "soon", `crates/common/src/runtime/mod.rs:103-106`). No JavaScript of
  the action runs after it: a timer still pending never fires, an interval stops, an operation's continuation never
  runs. A task already running may or may not finish (the unawaited-operations warning's "might not run").

### 7.2 What an app observes

- A timer that fires before the action answers works, `setInterval` too.
- After the answer, nothing the action left writes, schedules, stores or fetches.

### 7.3 How bunvex does it

- **An action's life** (`action-timeout.ts`, `ActionLife`), shared by its run and its `ctx`, ends when its body
  settles or its time is up (`withActionTimeout`'s `endsWithAnswer`, V8 actions only).
- **Its timers**: each `setTimeout` and `setInterval` a pushed module's context makes during an action is handed to
  that action (`contextGlobals`, `trackActionTimer`) and cleared when it ends; one made after the end (in an
  operation's continuation) is cleared at once. Timers the server makes for itself are not the action's.
- **Its `ctx`** refuses once it ended, whoever calls it (a `ctx` kept in module state and called by a later action
  too): "the action has ended: its operations can no longer run" (`ACTION_ENDED_MESSAGE`), the function sandbox's
  child's words, or the timeout's message if it timed out. A `fetch` made in its async context after the end is
  refused with the same words.
- **What was in flight goes on**: an operation started before the answer (an unawaited `runMutation`, a `fetch`)
  runs to its end, as before (Convex may shut it down: unchanged, and the same under both executors).
- **Not changed**: `"use node"` actions (Convex's Node executor, not an isolate). HTTP actions were left out here (their
  body may stream, calling `ctx`, after the handler returns: their end is the body's); §8 ends them with it.
- Under `process` the child's call refuses every operation after its `done` (STUDY-171 §12.6); its timers are cleared
  through `trackedActionTimers`, the same tracking, once the sandbox's actions are on `main` (STUDY-171 §12.11).

### 7.4 Tests and sabotage

`packages/server/test/action-end.test.ts` (11): a timer and an interval that fire while it runs; a pending timer that
never fires; an interval stopped at the answer and at the timeout; a kept `ctx` refusing seven kinds of call; an
operation's continuation refused (the operation itself ran); a timer set after the end cleared; an operation in flight
finishing; a `fetch` after the end refused; an HTTP action's body still calling `ctx` after its handler returned;
`trackedActionTimers`. `packages/differential/test/action-end.test.ts` (4, against Convex's binary
`precompiled-2026-10-10-72ce13c`, the app in `action-end-app/`): a timer that fires while the action runs, one left
pending, an interval, a continuation; on `main` three of the four fail (bunvex wrote after the answer).

| Break | Failing tests (server / oracle) |
|---|---|
| Timers not cleared at the end | 3 / 0 (the `ctx` refusal still keeps the writes out) |
| A context's timers not handed to the action | 4 / 0 |
| A timer set after the end not cleared | 1 / 0 |
| The action never marked ended | 4 / 1 |
| A kept `ctx` not refused | 1 / 0 |
| An ended action's `fetch` not refused | 1 / 0 |
| The refusal over the timeout's message | 2 (STUDY-77's own timeout tests) / 0 |

### 7.5 Measurement

The action hot path under `vm`, `main` against this change, on the test VPS (2 vCPUs, idle: no other process of any
session), ABAB, 2000 sequential actions per line through `Functions.runAction` after 200 (the actions bench of the
function sandbox, `packages/sandbox/bench/actions.ts`, run with `--vm`; a copy and the runner in
`bench/results/action-end/`). p50 / mean / p99 µs:

| Action | `main`, round 1 | this, round 1 | `main`, round 2 | this, round 2 |
|---|---|---|---|---|
| empty action | 62 / 114 / 1621 | 55 / 75 / 203 | 65 / 120 / 1571 | 60 / 87 / 470 |
| action, 1 `runQuery` | 153 / 227 / 2249 | 120 / 175 / 1768 | 137 / 217 / 2063 | 139 / 176 / 1242 |
| `fetch` GET, empty body | 1144 / 1512 / 4766 | 765 / 991 / 3058 | 1297 / 1669 / 5587 | 733 / 960 / 3198 |
| `storage.store`, 1 KiB | 226 / 285 / 1519 | 231 / 271 / 1218 | 234 / 307 / 1943 | 231 / 286 / 1276 |
| `storage.get`, 1 KiB | 135 / 150 / 358 | 141 / 169 / 1024 | 120 / 140 / 429 | 124 / 139 / 298 |

No cost shows: the per-action state (a life, a set of timers) and the per-call check are below the noise; the `fetch`
line's difference is the target's and the scheduler's (it moves by ±50 % between runs, STUDY-171 §12.9).

## 8. The end of an HTTP action (owner, 2026-10-21)

Found by the function sandbox's HTTP parity work (STUDY-171 §14, PR #812, its owner question Q-PR6-1): under `process`
an HTTP action's call ends with its body, as Convex's isolate; under `vm` it never ended, so the timers it left fired
after its response and a `ctx` it kept went on writing. The owner decided to match Convex under `vm` too.

### 8.1 How Convex does it (re-read at `72ce13c`)

- An HTTP action is one isolate run (`crates/isolate/src/environment/action/mod.rs` `run_http_action_inner`), whose
  loop (`run_inner`, `:1010-1236`) runs until the result's stream is done: for an HTTP action that stream is the
  response, its head then each chunk the body's stream hands its `stream/extend` op (`stream_http_result`,
  `:595-623`). So the body's code (its pulls, its timers, its `ctx` calls) runs after the handler returned, until the
  body ends, fails, or the client goes (`cancellation`, `:1217-1220`).
- Then the run ends as an action's does (`:1226-1233`, §7.1): the task channel closed and the running tasks shut down;
  no JavaScript of the HTTP action runs after its body.

### 8.2 What an app observes

- The body's code works while it streams: a pull may await a timer and call `ctx`.
- Once the body has been handed over (or the handler failed, or the client left), nothing the HTTP action left
  writes, schedules, stores or fetches: a pending timer never fires, an interval stops, an operation's continuation
  never runs, a `ctx` kept in module state refuses.

### 8.3 How bunvex does it

- `runHttpAction` (`functions.ts`) gives the HTTP action an `ActionLife`, shared with its `ctx` (`actionCtx`'s
  `endsWith`), and runs its handler with `withActionTimeout`'s new `endsLater`: its code's timers are tracked as a V8
  action's (`trackActionTimer`), but the run ends only when `runHttpAction` says so. A stream the handler made runs its
  pulls in the run's async context (Bun binds a stream's callbacks to the context it was made in), so the timers its
  body sets are the action's too.
- It ends: at once when the handler fails (a throw, not a `Response`, a body failing in the handler's turn); when the
  response has no body; when a body of known length has been read whole; and for a streamed body when the server's
  meter settles (`meteredBody`'s `sent`: the body's end, its failure, its cancellation by a client that left or a
  HEAD request).
- Then, as §7.3: its pending timers cleared (one set later, at once), its `ctx` and `fetch` refusing with
  `ACTION_ENDED_MESSAGE`, the function sandbox's child's words (STUDY-171 §14.2, so `vm` and `process` say the same),
  or the timeout's message if its handler timed out; what was in flight goes on.
- The action timeout still covers the handler, not the body's streaming (DV-146).

### 8.4 Tests and sabotage

`packages/server/test/action-end.test.ts` (+6, 17 in all): a body that streams after its handler returned, awaiting
timers and calling `ctx`; a timer its handler left that never fires, and the `ctx` it kept refusing seven kinds of
call; an interval stopped with its body; a handler that throws leaving a timer; a timer its streamed body left as it
ended; a client that leaves mid-body stopping its body's interval; a `fetch` after the end refused.
`packages/differential/test/http-action-end.test.ts` (4, against Convex's binary `precompiled-2026-10-10-72ce13c`, the
app in `http-end-app/`): a timer pending at the answer, an interval, a continuation, a streamed body whose pulls wait
on timers and write, and that leaves a timer as it closes. On `main` all four fail (bunvex wrote after the body ended).

| Break | Failing tests (server / oracle) |
|---|---|
| Timers not cleared at the end (`endsLater` given no end) | 5 / 0 (the `ctx` refusal still keeps the writes out) |
| A kept `ctx` not refused (no life for the HTTP action's `ctx`) | 1 / 0 |
| A streamed body never ends the action | 3 / 1 |
| A streamed body ends the action at its head, not its end | 3 / 1 |
| A body of known length never ends the action | 2 / 3 |
| A failed handler never ends the action | 1 / 0 |

### 8.5 Measurement

The `vm` HTTP-action hot path, `main` against this change, on the test VPS (2 vCPUs, Bun 1.4.3, idle: `ps` checked
first, no other process of any session), ABAB, 2000 sequential requests per line after 200, the server in a process of
its own (`bench/results/http-action-end/`: `server.ts`, `bench.ts`, the runner `vps.sh` and the raw output).
p50 / mean / p99 µs:

| Line | `main`, round 1 | this, round 1 | `main`, round 2 | this, round 2 |
|---|---|---|---|---|
| empty HTTP action (`new Response(null)`) | 287 / 358 / 1501 | 271 / 320 / 1400 | 282 / 331 / 1545 | 289 / 348 / 1405 |
| HTTP action answering "ok" | 289 / 390 / 1737 | 285 / 363 / 1763 | 290 / 419 / 2036 | 275 / 334 / 1753 |
| HTTP action, 1 `runQuery` | 311 / 362 / 1619 | 331 / 426 / 2066 | 350 / 451 / 1908 | 323 / 386 / 2028 |
| 1 KiB of bytes (streamed) | 298 / 388 / 1753 | 285 / 362 / 1633 | 294 / 388 / 1716 | 281 / 350 / 1616 |
| a stream of 3 × 1 KiB | 300 / 367 / 1568 | 293 / 362 / 1520 | 300 / 388 / 1738 | 296 / 376 / 1767 |
| a stream of 3 × 1 KiB, a timer per pull | 5033 / 5170 / 6959 | 5656 / 6081 / 10693 | 5122 / 5253 / 6947 | 5109 / 5246 / 6987 |
| a stream of 1 MiB | 823 / 979 / 2877 | 799 / 943 / 2794 | 850 / 953 / 2829 | 957 / 1128 / 3257 |

No cost shows: every line of this change is within `main`'s spread between its two rounds but for single rounds (the
timer line's first, the 1 MiB line's second), each matched by the other round. The per-request state (a life, a set of
timers, one `then` on the meter's `sent`) is below the noise.
