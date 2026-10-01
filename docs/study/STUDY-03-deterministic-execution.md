# STUDY-03 — Deterministic queries and mutations

- **Status:** implemented (#4). Written retroactively, after the code.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend

## 1. How Convex does it

- **The phase** (`crates/isolate/src/environment/udf/phase.rs`, `mod.rs`): each execution gets a seed and
  a start time.
  - `Math.random` comes from a ChaCha12 generator seeded with it.
  - `Date.now()` is frozen at the start time.
  - `performance.now()` is fixed in queries and incrementing in mutations. `UdfEnvironment::performance_now`
    (`crates/isolate/src/environment/udf/mod.rs`) picks `performance_now_fixed` for queries and
    `performance_now_incrementing` for mutations (`phase.rs`), backed by `ExecutingPerformanceApi`
    (`crates/isolate/src/environment/helpers/performance.rs`):
    - the fixed value is `execution_origin_offset`, the execution's start time minus `timeOrigin`;
    - the incrementing value adds the monotonic time elapsed since the execution began;
    - `op_performance_now` (`crates/isolate/src/ops/time.rs`, `secs_as_dom_high_res_ms`) rounds the
      result **down to 0.1 ms** against timing side channels;
    - during the import phase `now()` is 0;
    - `performance.timeOrigin` is the module's import-phase timestamp.
- **Where the time and seed come from:** `crates/function_runner/src/server.rs` gives each execution a
  fresh seed. The time is `udf_unix_timestamp(next_creation_time)`, the floor of the transaction's first
  `_creationTime`.
- **Refused operations:** cryptographic randomness is refused (`not_allowed_in_udf`), and so is every
  async op (`start_async_op`): `fetch`, `setTimeout`/`setInterval`, storage streams.
- **Creation times:** `CreationTime::increment` (`crates/common/src/document.rs`) moves to the next
  double after each insert. A transaction's inserts are therefore strictly increasing and never before
  `Date.now()`.
- **Retries:** a mutation retry (`application_function_runner/mod.rs`, `_retry_mutation`) is a new
  execution, with a new transaction, seed and time. Retry safety across client resends comes from
  `check_mutation_status` (an idempotency key), not from determinism.

## 2. What an app can observe

- Inside a query or mutation:
  - time is frozen;
  - `Math.random` is not cryptographic;
  - `fetch`, timers and `crypto.getRandomValues` throw an error that points to actions.
- Inserts are ordered by `_creationTime`.
- Actions see the real clock and APIs.

## 3. How bunvex does it

`packages/core/src/determinism.ts`:

- The globals are replaced once. Each replacement looks up the current execution in an
  `AsyncLocalStorage`.
- Persistence calls from `Tx` run outside the execution (`AsyncLocalStorage.exit`), which is the boundary
  Convex gets from its isolate.
- `Tx` hands out `_creationTime` with a next-double cursor.
- `performance.now()` inside an execution is its start time relative to `performance.timeOrigin`: the
  same instant as the frozen `Date.now()`, on `performance`'s origin.
  - A query keeps that value.
  - A mutation adds the real time elapsed since its start.
  - Both are rounded down to 0.1 ms, as Convex.
  - Outside an execution (actions, the engine) it is the real clock.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | `Math.random` is sfc32, not ChaCha12 | Neither is cryptographic. A seeded PRNG is enough, and sfc32 is fast in JS. | accepted (#4) |
| D2 | Not a sandbox: code that captured `Date.now` before the install, or that reaches a non-global API such as `Bun.sleep`, escapes | One process, no isolate | accepted (#4) |
| D3 | `performance.now()` is fixed in queries and incrementing in mutations, rounded down to 0.1 ms, as Convex (implemented, `fix/performance-now`). What remains different: `performance.timeOrigin` is the process's, not a module import time, and there is no import phase where `now()` is 0 | bunvex has no separate import phase (modules are imported once, at server start) | accepted: not possible exactly without isolates (owner, 2026-09-30; DV-52) |
| D4 | No idempotency key for client resends | Belongs to protocol v1 | open |

## 5. Tests

`packages/core/test/determinism.test.ts`, plus K1–K7 conformance on all 5 drivers.
