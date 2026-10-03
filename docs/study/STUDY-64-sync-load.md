# STUDY-64 — The sync worker under load and outages

- **Status:** draft; W1 pending (owner)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - [STUDY-22](STUDY-22-ws-mutation-order.md): one connection's mutation queue and its 1000 cap.
  - [STUDY-23](STUDY-23-sync-protocol-v1.md): the sync protocol v1, transitions, the shared executions (P3, DV-09).
  - [STUDY-26](STUDY-26-sync-client.md): the client's reconnect and backoff.
  - [STUDY-20](STUDY-20-function-errors-and-logs.md) D8 / DV-80: system errors close the socket (PR #273).
  - [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md): the 1 s user and 15 s system time limits.
  - [STUDY-24](STUDY-24-horizontal-scaling.md): Usher and the remote subscription stream (why §1.6 does not apply).
  - Parity rows: [client-sync.md](../parity/client-sync.md) §4, §5, §6 and §16.
  - Implementation, one PR per concern: #284 (mutation timeout and caps), #285 (single flight), #286 (rerun
    concurrency and retries), #287 (W0 fix, W1 pending), #280 (result and argument sizes).

This study covers the parts of Convex's sync worker that only matter when something is slow or failing:
a mutation that never finishes, a client that reads slower than the server writes, a query that hits a
transient store error, a wave of reconnects after an outage, and results or arguments too large to send.

## 1. How Convex does it

### 1.1 The 60 s mutation timeout (`SYNC_WORKER_PROCESS_TIMEOUT`)

`crates/sync/src/worker.rs`:

- `const SYNC_WORKER_PROCESS_TIMEOUT: Duration = Duration::from_secs(60)`. It is a constant, not a knob.
- `handle_message` for `ClientMessage::Mutation` builds a future that wraps the whole execution in
  `rt.with_timeout("mutation", SYNC_WORKER_PROCESS_TIMEOUT, …)` and puts it in the mutation queue.
  - The queue is `ReceiverStream::new(receiver).buffered(1)`: a future is first polled when it reaches the
    head of the queue. So the 60 s count from when the mutation **starts**, not from when it arrived. Time
    spent waiting behind other mutations does not count.
  - What it bounds: the mutation's whole run as the application sees it, i.e. the session-request lookup,
    every OCC retry and its backoff, the wait in the committer's queue, and the commit itself. The user
    code's own limits (1 s user time, 15 s system time; STUDY-41) are separate and shorter.
- `with_timeout` (`crates/common/src/runtime/mod.rs`) is a `select_biased!` between the future and a timer.
  When the timer wins it returns `TimeoutError { description: "mutation", duration }` ("'mutation' timeout
  after 60s") and **drops the execution future**: the mutation is cancelled at its current await point. If
  it was already handed to the committer, the commit still happens; otherwise nothing is written.
- **Actions have no such timeout.** The action future pushed to `action_futures` is not wrapped. (Actions
  are bounded elsewhere by their own execution limit.)
- The error has no `ErrorMetadata`. The mutation stream yields `Err`, `go_inner` returns it through `m?`,
  and the worker ends. `run_sync_socket` (`crates/local_backend/src/subs/mod.rs`) closes the socket with
  `close_frame()`: an untagged error is **1011 with reason `InternalServerError`**
  (`crates/errors/src/lib.rs`). No `FatalError` is sent.
- Queued mutations of that connection are dropped with the worker; they never start.

### 1.2 The per-socket caps (`OPERATION_QUEUE_BUFFER_SIZE` = 1000)

`crates/sync/src/worker.rs`:

- **Mutations**: `mpsc::channel(OPERATION_QUEUE_BUFFER_SIZE)` feeds `buffered(1)`. The running mutation
  has left the channel, so up to 1000 can wait **behind** it. `try_send` into a full channel fails with
  `ErrorMetadata::rate_limited("TooManyConcurrentMutations", "Too many concurrent mutations. Only up to
  1000 pending mutations allowed on a single websocket.")`: close 1013 (`CloseCode::Again`), reason
  `TooManyConcurrentMutations`.
  - The loop is `select_biased!` with the client's messages first, so in a burst the running mutation may
    not have been taken out of the channel yet; with one already running (the usual case), the 1002nd
    pending mutation is the one refused.
- **Actions**: `anyhow::ensure!(self.action_futures.len() <= OPERATION_QUEUE_BUFFER_SIZE, …)` **before**
  pushing. With 1000 in flight the check passes and the 1001st is pushed; the 1002nd is refused with
  `rate_limited("TooManyInflightActionsForSingleClient", "Inflight actions overloaded for a single client,
  max concurrency: 1000")`: close 1013.

### 1.3 Backpressure: single-flight transitions (`SYNC_MAX_SEND_TRANSITION_COUNT` = 2)

`crates/sync/src/worker.rs`, `crates/common/src/knobs.rs`, `crates/local_backend/src/subs/mod.rs`:

- The worker sends server messages through `measurable_unbounded_channel()`: an unbounded channel whose
  `SingleFlightSender` counts the **`Transition`s** in it (`transition_count`), incremented on send and
  decremented when the socket's writer takes one out.
- The writer (`send_messages` in `run_sync_socket`) takes one message at a time and awaits
  `tx.send(Message::Text(…))` on the WebSocket sink, which only completes once the frame has been written
  to the connection. A client that reads slowly (or a slow network) fills the TCP window, the writer
  blocks, and messages pile up in the channel.
- `go_inner` starts a transition only when `update_scheduled && tx.transition_count() <
  SYNC_MAX_SEND_TRANSITION_COUNT && transition_future.is_none()`. So at most **two** transitions wait in
  the channel, plus the one the writer is writing. While the limit is reached, triggers (commits into the
  client's queries, its own mutations and actions, query set changes) only set `update_scheduled`: they
  **coalesce** into the next transition, which runs at the latest timestamp and covers all of them.
- `select_biased!` also waits on `tx.message_consumed()` (a `Notify`-like channel of capacity 1 the
  receiver pings on every message taken out), so the worker wakes and starts the coalesced transition as
  soon as the writer catches up.
- `SYNC_MAX_SEND_TRANSITION_COUNT` is a knob (environment variable of that name, default 2).
- Other messages (`MutationResponse`, `ActionResponse`, `Ping`) are never held back: the channel is
  unbounded, and Convex never drops a frame and never closes a socket because it is slow to read (only
  the 120 s ping/pong `CLIENT_TIMEOUT` ends a dead peer).

### 1.4 Query reruns: bounded concurrency and retries

`crates/sync/src/worker.rs`, `begin_update_queries` / `run_update_queries` / `join_update_query_tasks`:

- **Concurrency.** The queries a transition needs to (re)run are spawned as tasks and joined with
  `buffer_unordered(UPDATE_QUERY_CONCURRENCY)`, `const UPDATE_QUERY_CONCURRENCY: usize = 20`: at most 20
  of one connection's queries run at a time. All run at the same `new_ts`. (Unchanged subscriptions are
  "refreshed" with `extend_validity` inside the same tasks, also within the 20.)
- **Retry of one query.** Each run loops on `api.execute_public_query(…, ExecuteQueryTimestamp::At(new_ts),
  …)`: if the error is `is_retriable_sync_worker_error` it waits `backoff.fail(rng)` and runs again, at the
  same `new_ts`, with a fresh request id. The backoff is `Backoff::new(SYNC_WORKER_QUERY_RETRY_INITIAL_BACKOFF_MS
  = 500 ms, SYNC_WORKER_QUERY_RETRY_MAX_BACKOFF_SECS = 600 s)`; `Backoff::fail` (`crates/convex/sync_types/src/backoff.rs`)
  is full jitter: `min(initial × 2^failures, max) × U[0, 1)`. There is no limit on the number of attempts.
  - `is_retriable_sync_worker_error`: `is_misdirected_request() || is_operational_internal_server_error()
    || is_overloaded() || is_rejected_before_execution()`.
  - What is *operational* (`crates/common/src/errors.rs`): a database timeout (`database_timeout_error`), a
    database operational error (a lost connection: `database_operational_error`), a lost lease, the database
    shutting down. *Overloaded* (`crates/database/src/metrics.rs`): `CommitterFullError`,
    `SubscriptionsWorkerFullError`, an index too large. *Rejected before execution*
    (`crates/isolate/src/metrics.rs`): no isolate worker free, the execute queue full, `ExpiredInQueue`.
  - Anything else that is not the function's own error (a plain internal error) bails, the worker fails,
    and the socket closes with 1011 `InternalServerError` (as PR #273 does for bunvex).
  - A `FeatureTemporarilyUnavailable` error (search index bootstrapping) is not an error for the client:
    the query is skipped and the transition retried after `SEARCH_INDEXES_UNAVAILABLE_RETRY_DELAY`. (Not
    covered here: bunvex's search indexes are in memory and never bootstrap; parity row "missing, n/a".)
- **Retry of the whole update.** `begin_update_queries` wraps everything in a loop that re-reads
  `latest_timestamp` and reruns all the queries when the run fails with `is_out_of_retention()`, with
  `Backoff::new(SYNC_WORKER_UPDATE_QUERIES_RETRY_INITIAL_BACKOFF_MS = 3000 ms, …_MAX_BACKOFF_SECS = 600 s)`.
  The successful results of the failed attempt are discarded (a TODO says so).
- All four backoff bounds are knobs, read from environment variables of the same names.
- While a transition is retrying, the worker keeps serving the socket: mutations, actions and pings go on;
  new triggers coalesce (§1.3: `transition_future` is not `None`).

### 1.5 What the client does

`npm-packages/convex/src/browser/sync/web_socket_manager.ts`, `client.ts`, `request_manager.ts`:

- On a close with a reason it knows (`serverDisconnectErrors`): `InternalServerError` backs off from
  **1 s**, the overloaded family (`TooManyConcurrentRequests`, `CommitterFullError`, …) from 3 s; any other
  non-normal close from 1 s; then exponential with jitter, capped at 16 s (STUDY-26). 1013 and 1011 are
  treated alike: only the reason picks the initial delay.
- On reconnect it resends its query set, its auth, and every **mutation** that has no response yet; the
  server's session records (`_session_requests`) make a resend of a mutation that already committed
  answer the recorded result instead of running again (STUDY-23). In-flight **actions** fail with
  "Connection lost while action was in flight" and are never resent.
- It checks every `Transition`'s `startVersion` against the version it holds
  (`remote_query_set.ts`); a gap throws "Invalid start version: …". So a transition the server
  computed but never delivered breaks the client.

### 1.6 The reconnect rate limiter (`crates/sync/src/subscription_reconnect.rs`)

- `SubscriptionReconnectRateLimiter` is a FIFO of reservations **per partition**, weighted by the number of
  queries each will replay: the first reservation is admitted at once and pushes the next admission
  `query_count / queries_per_second` later; an empty query set is admitted immediately; a dropped
  reservation is cancelled. (Added by #55770, "Pace subscription reconnects after Conductor failures".)
- It is used only by `SyncWorker::delay_recoverable_subscription_failure`, which runs when the worker fails
  with an error marked `RecoverableSubscriptionStreamFailure` (`crates/application/src/api.rs`). That
  marker is set only by the **remote subscription stream** that Usher, Convex's closed-source edge, keeps to
  the backend (`SubscriptionClient`; STUDY-24 §1). The worker then holds the idle socket open (still
  sending pings) until the limiter admits it, and closes it so the browser reconnects normally; pending
  client work or any client message skips the wait.
- In the open-source backend nothing marks an error recoverable, and the router builds the worker with
  `subscription_reconnect_rate_limiter: None` (`crates/local_backend/src/router.rs`,
  `crates/local_backend/src/subs/mod.rs`). **Self-hosted Convex never paces reconnects.**

### 1.7 Result and argument size limits

`crates/common/src/knobs.rs`, `crates/isolate/src/helpers.rs`, `crates/udf/src/helpers.rs`,
`crates/udf/src/validation.rs`:

- `FUNCTION_MAX_RESULT_SIZE` = 16 MiB (`1 << 24`), `SYSTEM_FUNCTION_MAX_RESULT_SIZE` = 24 MiB for
  `_system/` functions, `FUNCTION_MAX_ARGS_SIZE` = 16 MiB. All three are knobs.
- **Result.** `deserialize_udf_result_inner` measures the returned value's `size()` and, over the limit,
  makes the run fail with `JsError::from_message("Function {path} return value is too large (actual: {size},
  limit: {limit})")`. Sizes print with `humansize`'s `BINARY` format ("16 MiB", "16.5 MiB"), the path is the
  canonical `module.js:function`. It is a function error, not a system error: a mutation that returns too
  much writes nothing; a subscribed query gets `QueryFailed`; a nested `runQuery`/`runMutation` fails in
  its caller, which may catch it (`run_nested` checks it at any depth). Actions check it the same way.
- **Arguments.** `ValidatedPathAndArgs` parses the args, then `validate_udf_args_size` (the size of the
  one-element args array) before the args validator: `"Arguments for {path} are too large (actual: {size},
  limit: {limit})"`, also a `JsError::from_message`.
- At 80 % of either limit (`FUNCTION_LIMIT_WARNING_RATIO`) Convex adds a system warning log line
  (`TooLargeFunctionResult`, `TooLargeFunctionArguments`). bunvex has no limit warnings yet (also missing for
  the scheduler's limits); out of scope here.
- The WebSocket itself: Convex's `tungstenite` defaults, 16 MiB per frame and 64 MiB per message.

## 2. What an app can observe

1. **A mutation stuck for 60 s** (a store outage, a committer that cannot flush, OCC retries that never
   end) closes its socket with 1011 `InternalServerError` after 60 s of running. The client reconnects
   after about 1 s and resends it; it then runs at most once in total (the session record). Before the
   timeout the app just waits. Queries on that socket go on updating while the mutation waits.
2. **The caps**: 1000 mutations may wait behind a running one; 1001 actions may run at once on one socket.
3. **A slow client** gets fewer, larger transitions: intermediate states it could not keep up with are
   skipped, never delivered out of order, and the latest state always arrives. It never loses a frame. The
   server does not compute transitions nobody can receive yet.
4. **A transient store failure under a subscribed query** (timeout, lost connection): the client sees
   nothing but a delayed transition; the query is not reported as failed, the socket stays open.
5. **Many queries in one transition** run 20 at a time per connection: invisible except in timing.
6. **Reconnect storms** are not paced by self-hosted Convex.
7. **A function returning more than 16 MiB**, or called with more than 16 MiB of arguments, fails with the
   messages of §1.7.

## 3. How bunvex does it

The sync worker is `SyncSession` / `SyncHub` in `packages/server/src/sync.ts`; the socket is Bun's
`ServerWebSocket` (`packages/server/src/server.ts`, `websocket:` in `Bun.serve`).

### 3.1 Before this study

| Item | bunvex before | Where |
|---|---|---|
| 60 s mutation timeout | none: a mutation waits as long as its flush does | `SyncSession.mutation` |
| Mutation cap | 1000 **including** the running one (the 1001st pending is refused) | `MAX_PENDING_MUTATIONS` |
| Action cap | 1000 in flight (the 1001st is refused) | `MAX_INFLIGHT_ACTIONS` |
| Single flight | one transition computed at a time and later triggers coalesced, but **no limit on unsent transitions** | `SyncSession.update` / `schedule` |
| Send buffer | Bun's default `backpressureLimit` of 16 MiB with `closeOnBackpressureLimit: false`: **frames over it are silently dropped** (`send` returns 0) | `Bun.serve({ websocket })` |
| Query reruns | `Promise.all` over every stale query: unbounded; no retry | `SyncSession.transition` |
| Transient store error under a query | a `QueryFailed` with the store's error (on `main`); a 1011 close with PR #273 | `SyncHub.execute` |
| Reconnect limiter | none | — |
| Result size | no limit (the WebSocket frame cap applies to what the *client* sends) | `Functions.checkReturns` |
| Args size | no limit over HTTP; 8 MiB per WebSocket frame (`maxPayloadLength`) | `Functions.checkArgs`, `server.ts` |

**Bug found (W0):** the dropped frames. Measured on Bun 1.4.2 with a client that stops reading: `send`
returns -1 (buffered) up to 16 MiB of buffered data, then 0 (dropped) for every later frame, while the
socket stays open. A dropped `Transition` makes the client throw "Invalid start version" on the next
one; a dropped `MutationResponse` leaves the app's `await` hanging until the socket closes for another
reason. Convex never drops a frame.

### 3.2 The design

- **Mutation timeout (§1.1).** `SyncSession.mutation` arms a 60 s timer when the mutation starts (at the
  head of the connection's queue), not when it arrives. When it fires, the connection closes with 1011
  `InternalServerError`, and queued mutations never start (they already did not after any close). The run
  itself cannot be interrupted (one process, no isolate: DV-02), so it gets an `AbortSignal` instead:
  `Functions.runSessionMutation` / `runMutationWithTs` check it before each attempt and after the
  handler returns, so a timed-out mutation **does not commit** unless it had already reached the
  committer — the same outcome as Convex dropping the future. A resend then runs it once. Actions get no
  timeout, as in Convex.
- **Caps (§1.2).** Mutations: refused when 1000 are already **waiting** (not counting the running one);
  actions: refused when more than 1000 are in flight. Same codes and reasons.
- **Single flight (§1.3).** bunvex has no channel between the session and the socket writer: Bun's
  `ws.send` hands the frame to uWebSockets, which writes it to the kernel at once or keeps the rest in a
  per-socket buffer (`getBufferedAmount()`). That buffer *is* Convex's channel plus the writer's frame.
  So the session counts the transitions whose frames are still in it: it adds each frame's wire size
  (payload plus header) to a running total and notes the total after each transition; bytes flushed =
  total − buffered. A transition is "taken by the writer" once everything before it is flushed. The
  session starts a transition only while fewer than `SYNC_MAX_SEND_TRANSITION_COUNT` (2, same knob name)
  transitions are waiting behind the one being written; Bun's `drain` callback wakes it. Accounting only
  happens while the buffer is not empty, so the fast path costs two `getBufferedAmount()` calls per frame.
  With this, a slow client's buffer holds at most three transitions plus responses.
- **Never drop a frame (W0, §1.3).** `closeOnBackpressureLimit: true` with `backpressureLimit` raised to
  Bun's maximum (2³² − 1 bytes): a socket whose unsent data would pass 4 GiB is closed (the client
  reconnects and resends), instead of losing frames. Convex has no limit at all (W1).
- **Query reruns (§1.4).** A transition's stale queries run through a pool of `UPDATE_QUERY_CONCURRENCY`
  (20) per connection. A run that fails with a retriable error is retried at the same ts with full-jitter
  backoff from 500 ms to 600 s (`SYNC_WORKER_QUERY_RETRY_*` knobs). Retriable, mapped to bunvex's errors:
  `DatabaseTimeoutError`, `LeaseLostError`, and anything the store's driver classes as transient
  (`Persistence.isTransient`: a lost connection, a server restarting), found on the error or its `cause`
  chain (PR #273 wraps store failures in `PersistenceReadError`). bunvex has no isolate pool, committer
  queue limit or misdirection, so the other Convex classes have no counterpart. A ts that falls out of
  the write log's retention while retrying restarts the whole update at the newest ts, with the 3 s →
  600 s backoff (`SYNC_WORKER_UPDATE_QUERIES_RETRY_*`).
  - Shared executions (DV-09) keep working: a retry is inside the shared run, so every connection waiting
    on it gets the retried result.
- **Reconnect limiter (§1.6).** Not built: self-hosted Convex has it off, and bunvex has no remote
  subscription stream that could fail. To revisit only with a multi-node sync tier (STUDY-24).
- **Sizes (§1.7).** `Functions.checkReturns` (every query, mutation and action, at any nesting depth)
  fails a result over 16 MiB with Convex's message; `checkArgs` fails arguments over 16 MiB before the
  validator. Same knob names (`FUNCTION_MAX_RESULT_SIZE`, `FUNCTION_MAX_ARGS_SIZE`). The WebSocket frame
  cap goes from 8 MiB to Convex's 16 MiB. The size is checked before the returns validator, as Convex's
  (`deserialize_udf_result` in the isolate, then `ValidatedUdfOutcome::new`). Not covered: the 24 MiB limit
  of bunvex's own `_system` functions (they do not go through `checkReturns`), and the 80 % warnings.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| W1 | A socket whose unsent data would pass 2³² − 1 bytes (4 GiB) is closed; Convex buffers without limit | Bun's `backpressureLimit` is a 32-bit count and cannot be off; past it Bun either drops frames (the W0 bug) or closes. Closing loses nothing: the client reconnects and resends. With single flight, reaching it takes gigabytes of responses to a client that does not read | **pending (owner)**: DV-311, recommend accept |

Not divergences:

- The timed-out mutation's handler keeps running to its end in bunvex (JS cannot be interrupted, DV-02);
  it is aborted before it commits, which is what Convex's dropped future does. The outcome (written or
  not, answered or not) is the same.
- Counting unsent transitions in Bun's send buffer instead of a channel (§3.2): same quantity, same limit.
- The reconnect limiter (§1.6): off in self-hosted Convex too.

## 5. Tests

- Mutation timeout: a mutation whose handler waits past a short test timeout closes the socket with 1011
  `InternalServerError`; its writes are not committed; the next queued mutation never runs; a resend on a
  new socket runs once. The timer starts at the head of the queue (a mutation queued behind a slow one is
  not timed out early).
- Caps: 1000 waiting mutations behind a running one are accepted and the next is refused with 1013;
  1001 actions in flight are accepted and the 1002nd is refused.
- Single flight: a raw TCP client that stops reading; with a stream of commits into its query, the server
  computes at most 2 + 1 transitions while it does not read, then delivers the latest state when it
  reads again, with consecutive versions (no "Invalid start version"). The W0 regression: with the old
  settings, frames are dropped.
- Concurrency: with 100 queries that block on a gate, at most 20 run at once on one connection.
- Retry: a store that fails reads with a transient error a few times; the subscribed query's value
  arrives, no `QueryFailed`, the socket stays open; a non-retriable store error still closes with 1011.
- Sizes: a query, mutation and action returning 16 MiB + 1 fail with the message; a mutation's writes are
  not committed; a nested call's failure is catchable; arguments over 16 MiB are refused before the validator.
- Measurements: `packages/server/bench/sync-fanout.ts` (fan-out to fast clients, before/after) and
  `packages/server/bench/sync-slow-client.ts` (one hot query, N fast clients and some that stop reading:
  transitions computed, memory, delivery time to the fast ones).

## 6. Open questions

- W1 (owner).
- `CLIENT_TIMEOUT` (120 s without a pong closes the socket) and Bun's `idleTimeout` of 960 s differ; the
  parity row "WS-level ping every 5 s; client considered dead after 120 s" stays *partial*.
- Convex negotiates `permessage-deflate` on the sync socket (its `tungstenite` fork); bunvex does not
  compress. Not covered here.
