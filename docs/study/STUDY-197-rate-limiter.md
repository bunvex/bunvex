# STUDY-197 — `@bunvex/rate-limiter`
<!-- index: `@bunvex/rate-limiter`, the third own component (STUDY-158 §3.4 step 4.3) and a prerequisite of built-in auth (STUDY-191): token bucket and fixed window, shards with two random choices, reservations, the asynchronous mode on `@bunvex/batch-worker` (a stale-snapshot check, a queue of pending updates), the client `RateLimiter`, the React hook `useRateLimit`; written from get-convex/rate-limiter 0.4.2 | decided (owner, 2026-10-27): L-1–L-2 as recommended; not built -->

- **Status:** decided (owner, 2026-10-27): L-1–L-2 as recommended (§7). Nothing built.
- **Convex source read:** get-convex/rate-limiter at `dee5af1` (0.4.2), pinned in
  [upstream.md](../parity/upstream.md#other-repositories). Paths are relative to that repository's root.
- **bunvex source:** `main`, with `@bunvex/batch-worker` (STUDY-196, #917). Paths are relative to the repository's
  root.
- **Scope:**
  - STUDY-158 §3.4 step 4.3;
  - a prerequisite of built-in auth: Convex Auth v2's sign-in flows limit attempts through `@convex-dev/rate-limiter`
    (STUDY-191 §3.6).
- **Related:**
  - [STUDY-158](STUDY-158-own-components.md): Q-1–Q-8, DV-538 (`BunvexError`), DV-539;
  - [STUDY-183](STUDY-183-sharded-counter.md): the package model;
  - [STUDY-196](STUDY-196-batch-worker.md): its child;
  - [STUDY-53](STUDY-53-commit-timestamp.md): `db.vars.commitTs`.

## 1. How Convex does it

### 1.1 The component

- **Definition.** `defineComponent("rateLimiter")`, with `batchWorker` as its child
  (`src/component/convex.config.ts`).
- **Schema** (`src/component/schema.ts`):
  - `rateLimits {name, key?, shard, value, ts}`, index `name [name, key, shard]`. A missing `key` is the limit's one
    shared value, and shard 0 the only shard of an unsharded limit. `value` goes negative when capacity is reserved;
  - `pendingUpdates {update, updatedAt: v.commitTs()}`, index `updatedAt`. These are the asynchronous mode's queue.
- **The config** (`src/shared.ts`). It is a union of two kinds, both with `rate`, `period`, `capacity?`,
  `maxReserved?`, `shards?` and `applyUpdates?: "transactionally" | "asynchronously"`:
  - `token bucket`, whose `start` is null;
  - `fixed window`, whose `start?` is a number.

### 1.2 The math (`calculateRateLimit`, `src/shared.ts`)

- `max = capacity ?? rate`. A limit with no row starts full.
- **Token bucket:**
  - a new limit's `ts` is `now`;
  - `value = min(value + (now - ts) × rate / period, max) - count` and `ts = now`;
  - when the value is negative, `retryAfter = -value / (rate / period)`.
- **Fixed window:**
  - a new limit's `ts` is `start ?? now - floor(random × period)`, a random phase;
  - `n = floor((now - ts) / period)`;
  - `value = min(value + rate × n, max) - count` and `ts += n × period`;
  - when the value is negative, `retryAfter = ts + period × ceil(-value / rate) - now`.
- The function is exported to the client, which runs it in the browser (§1.6).

### 1.3 Checking and consuming (`src/component/internal.ts`)

- **Defaults.** `configWithDefaults` rounds `shards` (1 by default) and sets `capacity ?? rate`.
- **Validation.** `validateRequest` throws `Shards must be a positive number`. When `count` can never fit, it throws
  `Rate limit <name> count <count> exceeds <max>[ per <shards> shards.|.]`:
  - `max = capacity / (shards < 3 ? 1 : shards / 2)`;
  - when reserving with `maxReserved`, `max + maxReserved / factor` is printed with `toFixed(2)`.
- **Shards.** Each shard holds `rate / shards`, and `capacity` and `maxReserved` divided the same way.
  - Two distinct shards are picked at random (`getTwoRandomShards`), and the first is read.
  - With no row there, or with fewer than 3 shards, that shard decides.
  - Otherwise the second is read too. One that is ok wins; with both ok, the one with the larger value wins.
  - With neither ok, the two are pooled and balanced to the same value. The result is ok only if both are then ok,
    and `retryAfter` is the larger of the two.
- **Reservations.** A negative value is allowed with `reserve`, up to `maxReserved`, and then `ok` comes with a
  `retryAfter`.
- **Throwing.** With `throws`, a `retryAfter` throws `ConvexError({kind: "RateLimited", name, retryAfter})`.

### 1.4 The public functions (`src/component/lib.ts`)

| Function | Kind | What it does |
|---|---|---|
| `rateLimit(rateLimitArgs)` | mutation | checks and writes the updated shards. It refuses an asynchronous config: ``Rate limit config for <name> has `applyUpdates: "asynchronously"`. Limit consumption must be enqueued.`` |
| `checkRateLimit(rateLimitArgs)` | query | the same check, with no write |
| `getValue({name, key?, config, sampleShards?})` | query | samples up to `sampleShards` (1 by default) random shards, a missing one counting as `{value: capacity, ts: 0}`. It brings each to the latest `ts` and returns the fullest `{value, ts, shard, config}`. A fixed window with no `start` gets the window start of that shard |
| `enqueueUpdates({updates})` | mutation | inserts each update with `updatedAt: commitTs`, then pings the worker. It refuses a transactional `consume`: ``… has `applyUpdates: "transactionally"` and can't be enqueued.`` |
| `resetRateLimit({name, key?})` | mutation | deletes every shard of the name and key |
| `clearAll({before?})` | mutation | deletes 100 rows at a time by `_creationTime ≤ before ?? now`, newest first, and reschedules itself for the rest |
| `getServerTime()` | mutation | `Date.now()`, for the hook's clock skew |

### 1.5 The asynchronous mode (`src/component/worker.ts`, 0.4.0)

- The batch-worker is named `rateLimiter`.
- **The work query** reads `pendingUpdates` from the cursor (`gte`). It stops at 1024 updates, or once a quarter of
  the transaction's read budget is used (`ctx.meta.getTransactionMetrics().bytesRead`). It returns the last
  `updatedAt` as the cursor.
- **The worker mutation** folds the updates per `[name, key]` on shard 0:
  - a `reset` clears the state;
  - a `consume` applies `calculateRateLimit` at `max(update.ts, state.ts, stored ts)`, so time never goes backwards.

  It then writes each state (deleting, patching or inserting) and deletes the processed updates.
- **The client** uses it when `applyUpdates: "asynchronously"`:
  - `limit` checks through a stale-snapshot query and, if ok, enqueues a `consume` with `ts: Date.now()`;
  - `check` and `getValue` read through the stale snapshot when called from a mutation;
  - `reset` enqueues a `reset`.

  The result is eventually consistent.

### 1.6 The client (`src/client/index.ts`) and the React hook (`src/react/index.ts`)

- **`RateLimiter`** is `new RateLimiter(component, limits?)`, with these methods:
  - `check`, `limit`, `reset`, `getValue`;
  - `hookAPI(name, {key?, sampleShards?})`, which returns `{getRateLimit, getServerTime}`. These are a public query
    and a mutation for the app to export. A key from the browser is used only through a `key` function, and
    otherwise throws `To allow client-provided key, provide a `key` function in the hook options.`
- A name with no config throws `Rate limit <name> not defined. You must provide a config inline or define it in the
  constructor.` An asynchronous config with `shards` throws `Rate limit <name> applies updates asynchronously and
  can't be sharded.`
- **Stale reads.** `runStaleQuery` asks `ctx.meta.getFunctionMetadata().type` and adds `useStaleSnapshot` in a
  mutation.
- **Exports:**
  - the constants `SECOND`, `MINUTE`, `HOUR`, `DAY`, `WEEK`;
  - `isRateLimitError(e)`, which tests `instanceof ConvexError` and `data.kind === "RateLimited"`;
  - `calculateRateLimit` and the types.
- **`./react`.** `useRateLimit(getRateLimitQuery, {name?, key?, count?, sampleShards?, getServerTimeMutation?,
  config?})`:
  - it measures the clock skew once through `getServerTimeMutation`;
  - it subscribes to `getRateLimit` and computes `{status: {ok, retryAt?}, check(ts?, count?)}` locally;
  - it re-renders when `retryAt` passes.

  It uses `useQuery` and `useConvex` from `convex/react`.
- **`./test`.** `register(t, name = "rateLimiter")`.

### 1.7 Its tests

There are 75 cases: `lib.test.ts`, `internal.test.ts`, `getValue.test.ts`, `worker.test.ts`, `shared.test.ts`,
`client/index.test.ts` and `react/index.test.ts`. The last one runs under jsdom with `convex/react` mocked.

## 2. What an app can observe

STUDY-158 §2 (Q-3) applies:
- the name `rateLimiter`, with its child `batchWorker`;
- the schema;
- the function paths, validators and results;
- the math to the last float;
- the messages of §1.3–§1.6;
- the error's `data`.

Randomness belongs to the backend: the shards picked, a fixed window's phase and `getValue`'s sample. It is compared
through invariants, or pinned with a `start` and `shards: 1`.

The asynchronous mode's batching depends on the read-budget accounting, which bunvex matches (`getTransactionMetrics`).
Only the grouping of updates into batches could differ, never the folded values.

## 3. How bunvex does it

### 3.1 The package

STUDY-183's model, as STUDY-196:
- `components/rate-limiter/`, version 0.1.0, with a README naming rate-limiter 0.4.2;
- `src/component/{bunvex.config.ts, schema.ts, lib.ts, internal.ts, worker.ts, time.ts}` and `_generated/`;
- `src/shared.ts`, `src/client/index.ts`, `src/react/index.ts` and `src/test.ts`;
- `@bunvex/batch-worker` as a regular dependency, mounted as the child: `component.use(batchWorker)`.

The export map adds `./react` to STUDY-183's.

### 3.2 The platform is ready

Everything §1 uses is already in bunvex:
- nested components (STUDY-156);
- `db.vars.commitTs` and `v.commitTs()` (STUDY-53);
- `useStaleSnapshot`;
- `ctx.meta.getFunctionMetadata()` with `type` (`packages/server/src/functions.ts:2156`);
- `getTransactionMetrics()`;
- a query iterated with `for await`;
- the `by_creation_time` index;
- the scheduler, with `Math.random` and `Date` deterministic in queries and mutations.

**One rule to extend.** `scripts/check-deps.ts` lets a component import only `server`, `values`, `helpers`,
`testing` and other components. `./react` imports `bunvex/react`, which is the `react` package: it is added to what
a component may import, as a peer dependency. React itself is a peer dependency too. This is no divergence.

### 3.3 Written from scratch

It follows §1, with Convex's names, paths, validators, defaults, math and messages. DV-538 renames two things:
- the error is `BunvexError({kind: "RateLimited", name, retryAfter})`, with the same `data`;
- `isRateLimitError` tests `instanceof BunvexError`.

The hook uses `useQuery` and `useBunvex` from `bunvex/react`, which are the same calls under bunvex's name.

### 3.4 Tests

- **The upstream tests, ported:**
  - the component's, client's and worker's tests on `@bunvex/testing`, with the virtual clock instead of vitest's;
  - `shared.test.ts` as plain unit tests;
  - the hook's test under happy-dom with `@testing-library/react`, which `packages/ui` already uses, and
    `bunvex/react` mocked.
- **More:**
  - every message of §1.3–§1.6;
  - the error's class and `data` across the component boundary;
  - `clearAll` past 100 rows;
  - the async mode's fold with out-of-order timestamps and a reset in the middle.
- **A differential test.** The same calls run with `@convex-dev/rate-limiter` 0.4.2 on Convex's binary. With
  `shards: 1` and a fixed `start`, results are exact. They compare:
  - the results and `retryAfter`s at the same instants, through each backend's clock;
  - the rows;
  - the errors;
  - the asynchronous mode's settled values.
- **Sabotage checks:** the token bucket's refill, the fixed window's window count, the two-shard pooling, the
  `maxReserved` cut, and the async fold's time clamp.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | none beyond DV-538 (`BunvexError`, `isRateLimitError`) | | |

## 4b. Additions

None.

## 5. Tests

As §3.4.

## 6. Not verified yet

- How each backend's clock is read in the differential test. `retryAfter` depends on `Date.now()` at the call, and
  two backends are never called at the same instant. The plan is to compare a value computed from each answer's own
  `ts` (the row's), not the raw `retryAfter`.
- Whether Convex's `getValue` sees the same `Math.random` sequence as bunvex for a given seed. It does not need to:
  the sample is compared through invariants.

## 7. Questions for the owner

All decided by the owner on 2026-10-27, as recommended.

| # | Question | Recommendation |
|---|---|---|
| L-1 | The example: port rate-limiter's own example (`example/`: a playground of limits and the hook), and add the rate-limited LLM worker to `examples/batch-worker` (STUDY-196 B-2) | **Yes, both**, in a PR after the package. They are the end-to-end checks of the hook and of the two components together |
| L-2 | `check-deps`: let components import `react` (`bunvex/react`), with React as a peer dependency, for the `./react` entry (§3.2) | **Yes.** It is the subpath Convex's package has, and nothing else changes |
