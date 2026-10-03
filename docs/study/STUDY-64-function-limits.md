# STUDY-64 — Concurrency limits per function kind

- **Status:** implemented; closes DV-302 (owner, 2026-10-03: "fechar")
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-31](STUDY-31-http-actions.md) (the action limiter), [STUDY-58](STUDY-58-app-metrics.md)
  (`function_concurrency`, DV-302), [STUDY-59](STUDY-59-log-streams.md) (`concurrency_stats`)

## 1. How Convex does it

`crates/application/src/application_function_runner/mod.rs` (`Limiter`, `function_runner_execute`) and
`crates/common/src/knobs.rs`:

- **Limiters.** There is one limiter per kind: queries (`APPLICATION_MAX_CONCURRENT_QUERIES`, 16), mutations
  (`_MUTATIONS`, 16), V8 actions (`_V8_ACTIONS`, 64; **HTTP actions share it**) and Node actions
  (`_NODE_ACTIONS`, 64). The upload limit (`_UPLOADS`, 4) is outside this study.
- **Who takes a permit.**
  - A permit is taken by each query or mutation run (every attempt of a mutation), each action and each HTTP
    action.
  - A cached query does not run, so it takes none.
  - A query or mutation called inside another function's transaction runs in that isolate, so it takes none.
- **Waiting.**
  - A query or mutation waits up to `APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT` (5 s), even when
    scheduled.
  - An action called by a client waits up to `_ACTION_SEMAPHORE_TIMEOUT` (10 s).
  - Scheduled and cron actions wait without a timeout (`wait_for_permit: true`).
- **Refusal.**
  - After the wait the call fails with `ErrorMetadata::rate_limited("TooManyConcurrentRequests", "Too many
    concurrent requests. Your backend is limited to {n} concurrent {kind}s. …")`. `{kind}` is the lowercase
    kind, so the text reads "querys".
  - The HTTP API answers 429.
  - The sync protocol closes with `CloseCode::Again` and the reason `TooManyConcurrentRequests`; the client
    reconnects with backoff.
- **Gauges.**
  - Each limiter reports `outstanding_functions:{env}:{kind}:{running|queued}` from the start and on every
    change.
  - `queued` is non-zero only while the limiter is full.
  - The action limiter reports as `Action`, so there is no `HttpAction` gauge, and `concurrency_stats`'s
    `http_action` is 0.

## 2. What an app can observe

- Under load: 429 and the error text, or a sync reconnect.
- Scheduled actions that wait instead of failing.
- The dashboard's concurrency chart.

## 3. How bunvex does it

- **`server/src/action-permits.ts`.**
  - `ConcurrencyLimiter` runs a function with a permit. A freed permit goes straight to the first waiter.
    The waiter's timer is set outside the function's deterministic execution, which refuses timers.
  - `run(fn, {wait})` skips the timeout.
  - `ActionPermits` (STUDY-31) is now the action specialization.
  - `functionLimitsFromEnv` builds the four limiters with Convex's knobs.
- **`Functions.limits`.**
  - A query's and a mutation's body take their permit once validated: after the run-state check and the
    argument check, and before the user timer. Waiting is not user time.
  - Actions take the action or Node limiter; HTTP actions take the action limiter.
  - The scheduler and the cron executor pass `waitForPermit`.
- **Sync.** A permit refusal ends the session with 1013 and Convex's reason, for a query, a mutation or an
  action. The HTTP API's 429 already covered every kind.
- **Gauges.** Each limiter reports from the start, Node actions under `node`. The separate `HttpAction`
  gauges of STUDY-58 are gone, as in Convex.
- **Cost.** One wrapper per run.
  - Measured in process: sequential queries and mutations are within the noise.
  - 2000 concurrent in-memory queries keep their throughput with 16 permits.
  - The machine was loaded and the runs varied ±20%; no difference stood out.

## 4. Divergences

None. Not built yet: the upload limit (4).

## 5. Tests

`server/test/function-limits.test.ts`, with the limits set to 1 and the timeouts to 40 ms:

- **Queries.**
  - One permit; the next query is refused with Convex's message ("querys"), as a 429.
  - A cached query and a query inside a mutation still run.
  - The permit frees after the run.
- **Mutations.** Mutations have their own limit, and a waiter gets the freed permit.
- **Scheduled actions** wait past the timeout and then run.
- **Sync.** A query without a permit closes the session with 1013 `TooManyConcurrentRequests`.
- **Elsewhere.** `app-metrics.test.ts` covers the gauges, including Node's; `action-permits.test.ts` covers
  STUDY-31's behaviour.
- **Sabotage checks**, each failing a test: the query limit, the mutation limit, the scheduled wait, the
  sync close, the timeout path.
