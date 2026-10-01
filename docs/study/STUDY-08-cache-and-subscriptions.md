# STUDY-08 — Query cache and subscriptions

- **Status:** draft (retroactive). The code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`
- **Related:**
  - [STUDY-06](STUDY-06-transactions-and-occ.md): the write log.
  - [STUDY-11](STUDY-11-function-results-and-errors.md): error payloads.
  - `packages/protocol` v0.

## 1. How Convex does it

### 1.1 The query cache

`crates/application/src/cache/mod.rs`:

- **The key** (`RequestedCacheKey` / `StoredCacheKey`) is:
  - the function path;
  - the serialized arguments (a `ConvexObject`, so the field order is canonical);
  - the **identity**, but only if the query read `ctx.auth` (`outcome.observed_identity`); otherwise
    the entry is stored with `identity: None` and shared across users;
  - the **query journal**, for pagination;
  - the allowed visibility;
  - a tenant id.
- **An entry** (`CacheResult`) holds the outcome, `original_ts` and a `Token`: the read-set plus its
  timestamp (`crates/database/src/token.rs`).
- **A lookup at `ts`:**
  - is valid only if `original_ts <= ts`;
  - then refreshes the token to `ts` through the write log (`database.refresh_token`). If a write
    overlapped the read-set in between, the entry is invalid and the query re-executes.
  - So the cache is **timestamp-aware**: a hit is proven equal to executing the query at `ts`.
- **Concurrent identical requests are coalesced.** A `Waiting` entry makes later callers wait for the
  first execution.
- **JS errors are not cached** (the comment "We do not cache JSErrors").
- **Size:** an LRU bounded by bytes (`UDF_CACHE_MAX_SIZE`, 100 MiB).

### 1.2 Subscriptions

`crates/database/src/subscription.rs`, `SubscriptionManager`:

- A subscription is a `Token`: a read-set at a ts.
- The manager follows the write log (`advance_log`). It finds the subscriptions whose read-set
  overlaps each write through an interval index (`overlapping_database`), and notifies them.
- **Splaying:** when a very large number of subscriptions is invalidated at once, the notifications
  are spread over time (`SUBSCRIPTION_INVALIDATION_DELAY_*` knobs).
- A subscription whose token falls out of write-log retention is invalidated, and the query
  re-runs.

### 1.3 The sync protocol

`crates/sync/src/worker.rs` and `state.rs`; message types in `crates/convex/sync_types/src/types/mod.rs`.

- **The query set is versioned per client.** The server sends
  `Transition { start_version, end_version, modifications }`. Every modified query in one
  Transition is computed **at the same timestamp**, so all of a client's queries advance together
  and it never sees two queries at different points in time.
- **`QueryFailed`** carries `error_message`, the optional `error_data` (the `ConvexError` payload),
  log lines and the journal.
- **`MutationResponse`** carries the commit `ts`. The client (`request_manager.ts`,
  `removeCompleted(ts)` in `npm-packages/convex/src/browser/sync/`) resolves the mutation promise
  only once its query set has reached that `ts`. So when `await mutation()` returns, every
  subscribed query already reflects the write: read-your-writes across mutations and subscriptions.
- **Identity** is part of the state (`IdentityVersion`). An auth change re-runs the queries.

## 2. What an app can observe

1. **Consistency:** all subscribed queries of a client update atomically, at one timestamp.
2. **Read-your-writes:** after a mutation resolves, the client's queries include its effect.
3. **Recovery:** a query that throws, and later succeeds, pushes the new value, even when that value
   equals one it pushed before the error.
4. **Errors** carry `errorData` for a `ConvexError`.
5. **Auth isolation:** a query that reads `ctx.auth` is cached per identity; one that does not is
   shared.

## 3. How bunvex does it today

### 3.1 The query cache

`packages/core/src/engine.ts`, `Engine.query(body, cacheKey)`, used by the HTTP query route and by
actions' `runQuery` (`packages/server/src/functions.ts`):

- The key is `` `${name}\0${JSON.stringify(args)}` ``. It depends on the argument field order, and
  has no identity (there is no auth yet).
- A hit returns the cached value **by reference**. Subscriptions do not use this cache
  (`queryTracked`).
- An entry is inserted only if `visibleTs` did not move during execution.
- Invalidation happens on durable commit (`onCommit`): every entry whose read-set overlaps a write is
  deleted. An overlap is always a miss, as in Convex; there is no ts refresh because entries are
  always "at the latest ts".
- Eviction is FIFO at 1 000 entries. Errors are not cached. There is no request coalescing.
- **Probe:** mutating the object returned by a cached query changed what the next cache hit
  returned.

### 3.2 Subscriptions

`packages/core/src/subscriptions.ts`:

- There is one `Sub` per key (`subscriptionKey(path, args)` in `packages/protocol`).
- On each durable commit, every non-running `Sub` with an overlapping read-set is re-run. This is a
  linear scan over all subs, entries and intervals. A `Sub` that is running when a commit arrives is
  marked dirty and re-runs once it finishes.
- A new value is published only if its JSON differs from `s.value`.
- On error, `{ error }` is published, but:
  - `s.value` is left unchanged, so a later success returning the **same** value as before the error
    is never published. **Probe:** value 1 → error → value 1 again; the client's last message stays
    `{"error":"boom"}`.
  - `s.reads` is not updated. If the **first** run throws, `reads` stays `null`, and `onCommit`
    skips the `Sub` forever. **Probe:** a subscription created while its query throws never
    recovered after the data changed.

### 3.3 The protocol

`packages/protocol/src/index.ts` and `packages/server/src/server.ts`:

- Messages are `upd{k,v}`, `err{k,e}` and `res{id,v|e}`.
- There is no version, no timestamp and no query-set transition. Each subscription publishes on its
  own.
- A mutation's `res` is sent as soon as the commit resolves. Subscription re-runs start in `onCommit`
  but finish later, so the client can see the mutation resolve **before** its queries reflect it.
- `ServerMessage` has no field for error data.

The protocol file itself lists "all of a client's subscriptions advancing together" and "a mutation
resolving only once its effect is visible" as open "N" items.

## 4. Divergences

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | After an error, a subscription whose value returns to its pre-error value is never republished (`subscriptions.ts` `run`: `s.value` is kept on error) | BUG | The client stays on the error until the value changes to something new | owner |
| D2 | A subscription whose first run throws never re-runs (`reads` stays `null`; `onCommit` skips it) | BUG | A permanently stuck subscription (e.g. subscribed before the data it needs exists) | owner |
| D3 | The query cache returns results by reference (`engine.ts` `query`) | BUG | An action (`ctx.runQuery`) or future in-process caller that mutates a result corrupts the cache for everyone. Convex hands out serialized copies | owner |
| D4 | No per-client consistent transitions: each subscription is pushed independently, at its own snapshot | OBSERVABLE | Two queries of one client can show different points in time (torn UI), which Convex never does. Known "N" item | owner |
| D5 | A mutation resolves before the client's subscriptions reflect it (no ts in `res`, no client-side wait) | OBSERVABLE | Breaks Convex's read-your-writes-after-await guarantee. Known "N" item | owner |
| D6 | The cache key and subscription key have no identity | BUG (latent) | Harmless today (no auth). The moment `ctx.auth` lands, one user's cached or subscribed result would be served to another unless identity is added, as in Convex's `observed_identity` rule | owner |
| D7 | The cache/subscription key depends on argument field order (`JSON.stringify(args)`) | INTERNAL | Duplicate entries and executions; no wrong results | owner |
| D8 | No request coalescing; FIFO at 1 000 entries instead of an LRU bounded by bytes; subscriptions bypass the cache | INTERNAL | Performance: thundering herd on a hot key, and memory is unbounded in bytes | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-63) |
| D9 | Invalidation is a linear scan over subscriptions × writes × intervals, with no splaying | INTERNAL | Performance at many subscriptions (ENGINE-00 fan-out) | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-64) |
| D10 | Wider read-sets (`take(n)` records the whole range, STUDY-06 D3) cause extra re-runs | INTERNAL | JSON dedupe hides it from clients; costs CPU | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-57) |
| D11 | `err` has no `errorData` | OBSERVABLE | `ConvexError` data is lost (STUDY-11) | owner |

## 5. Tests

- **Error recovery:** value A → throw → A again must publish A. A first run that throws, followed by
  a write that fixes the data, must publish the value.
- **Aliasing:** mutating a returned cached value does not change the next hit.
- **Consistency (once implemented):** one client subscribes to `count()` and `list()` over the same
  table while a writer inserts. Every Transition shows `count === list.length`.
- **Read-your-writes (once implemented):** after `await mutation()`, the client's subscribed query
  already includes the write, with no extra wait.
- **Cross-check:** the same scenario on Convex with the official client, comparing the sequence of
  observed states.

## 6. Open questions

1. Should the query cache become ts-aware (entries valid in `[original_ts, invalidation_ts)`), which
   is what a per-client consistent Transition at a chosen ts will need?
2. Should subscriptions share the cache, as Convex's do, to collapse identical executions across
   clients and HTTP?
