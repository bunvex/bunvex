# STUDY-08 — Query cache and subscriptions

- **Status:** decided — D1–D3 fixed (#11, #13); D6 fixed for the HTTP query cache (#103), the sync path next (Phase 0 B13); D4, D5, D7, D11 resolved to match Convex (DV-44, DV-45, DV-49); D8–D10 to match Convex, gaps tracked in docs/parity (DV-57, DV-63, DV-64). Retroactive: the code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`; §1.4 and §3.4 (D9) at `9c9bd14`
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

How a write finds its subscriptions is in §1.4.

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

### 1.4 Matching a commit against the subscriptions (D9)

Read at commit `4577b9031`.

- **One interval map per index.** `SubscriptionMap` (`crates/database/src/subscription.rs:878-922`) holds a
  `BTreeMap<TabletIndexName, (IndexedFields, IntervalMap)>`; a comment there (`:879`) wants to merge them
  into one structure later. `insert` (`:892`) adds each of a subscriber's per-index interval sets to that
  index's map; `remove` (`:907`) removes the subscriber from every index it read and drops a map once it
  is empty.
- **The map** is its own crate, `crates/interval_map/src/lib.rs`: a **treap ordered by the interval's
  start**, where each node also points at the node with the greatest end in its subtree (`:25-56`).
  - `insert(subscriber, intervals)` (`:128`) gives each interval a random weight; a subscriber's nodes are
    linked in a list so `remove(subscriber)` (`:273`) can unlink them all.
  - `query(point, cb)` (`:354-385`) is a stabbing query: it skips a subtree whose greatest end is not
    above the point, and the right subtree of a node that starts after the point. Average cost
    `O((k + 1) log n)` for k matches among n intervals (`:356`). A subscriber with several matching
    intervals is reported once per interval; the caller dedups.
  - Intervals are `[start, end)`: a start is included, an end is excluded or unbounded
    (`crates/common/src/interval/bounds.rs`, `End::greater_than` at `:92`).
- **`advance_log(next_ts)`** (`subscription.rs:492`) walks every index write in `(processed_ts, next_ts]`
  per index (`LogReader::for_each_index`, `crates/database/src/write_log.rs:725`), looks each written key
  up in that index's map (`overlapping_database`, `:662`, the lookup at `:680`), and collects the
  subscribers in a `BTreeMap<SubscriberId, (ts, write source, tablet)>` (`:500`). That map is the
  **dedup**: a subscriber hit by several writes is notified once, with the **earliest** invalidating
  write ts (`process_log_entry`, `:718`, the rule at `:729`). All the commits since the last wake are
  handled in one pass, so a burst of commits is matched together.
- **Notifying** removes the subscriber from the maps and drops its sender (`_remove`, `:762`), which
  marks the subscription invalid. A subscription the client drops is removed the same way, through
  `closed_subscriptions` (`:327`). Nothing stays registered once invalidated or closed.
- **Splaying** (`:576-622`): when more than `SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD` (200) subscribers
  are invalidated by one `advance_log`, each non-system one is notified after a random delay in
  `[0, count × SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER (5 ms) × NUM_SUBSCRIPTION_MANAGERS (1)]`
  (`crates/common/src/knobs.rs:1975-1996`, `drop_with_delay` at `subscription.rs:196`).
- **New subscriptions** are refreshed to the manager's `processed_ts` through the write log before they
  are inserted (`subscribe`, `:416-440`), so none misses a commit between its read and its registration.
- **Who subscribes:** the sync worker, once per query of a session after each execution
  (`crates/sync/src/worker.rs:1204`), waiting in `next_invalidated_query`
  (`crates/sync/src/state.rs:309`).
- **The query cache does not use the map.** A cached result is checked lazily, when it is looked up:
  `validate_cache_result` (`crates/application/src/cache/mod.rs:768`) refreshes the entry's token to the
  requested ts (`:780` → `WriteLog::refresh_token`, `write_log.rs:623` → `is_stale`, `:600`), which
  walks the log's writes per index in `(token ts, ts]` and tests each key against the entry's own
  read-set (`ReadSet::writes_overlap_by_index`, `crates/database/src/reads.rs:167-196`; the read-set is a
  sorted, disjoint `IntervalSet` whose `contains` is a binary search, `interval_set.rs:242`). The cost is
  per lookup, proportional to the writes since the entry was made, never to the number of entries.

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

`packages/core/src/subscriptions.ts` (protocol v0's; deleted in #94, protocol v1's `SyncHub` shares
executions itself):

- There is one `Sub` per key (`subscriptionKey(path, args)` in `packages/protocol`).
- On each durable commit, every non-running `Sub` with an overlapping read-set is re-run. This was a
  linear scan over all subs, entries and intervals; it is an index lookup since D9 was built (§3.4). A
  `Sub` that is running when a commit arrives is marked dirty and re-runs once it finishes.
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

### 3.4 Invalidation through an index (D9, built)

The owner decided D9 on 2026-10-01: match Convex. `packages/core/src/read-set-index.ts`, `ReadSetIndex<K>`:

- **The structure** is Convex's, written from scratch: per index id, a treap of `[lo, hi)` intervals
  ordered by `lo` (ties by registration order), each node keeping the largest `hi` of its subtree. A
  written key is a stabbing query that prunes the same two ways (§1.4), in about `O((k + 1) log n)`.
  Treap priorities come from the index's own xorshift, not `Math.random`, which is seeded inside
  executions (STUDY-03).
- **API:** `set(owner, reads)` registers an owner's read-set and replaces any previous one;
  `delete(owner)`; `matching(writes)` and `matchingEntries(logEntries)` return the owners hit, **once
  each** (a `Set`, the dedup Convex's `to_notify` map does). Empty intervals (`lo >= hi`) are not stored:
  they contain no key.
- **Two users** (core `Subscriptions`, a third, was deleted with protocol v0 in #94), each registering on its own path, so every commit is still matched against exactly
  the read-sets it was matched against before:
  1. **The query cache** (`Engine.cacheReads`): an entry is registered when it is cached and dropped from
     the index on invalidation and on FIFO eviction (`dropCached`).
  2. **The sync hub** (`SyncHub.reads`): the latest execution of each watched key is registered when it is
     adopted and dropped when the key's last watcher leaves. Unchanged: `resultAt` and the session's
     staleness check still ask the committer's write log (`changedBetween`, Convex's `extend_validity`).
- **Not changed:** commit validation (`Committer.validate`, DV-61) and `changedBetween` still scan the
  write log; `committer.ts` is untouched.
- **Equivalence** is tested against the old scan: random read-sets (empty, inverted, open-ended, prefix
  and one-key ranges, keys of every length over a 5-byte alphabet, three indexes) and random writes (half
  of them on registered bounds) give exactly the owners `overlaps()` gives, over 6 seeds × 3 000 steps
  (`packages/core/test/read-set-index.test.ts`). Deregistration is tested on every path (eviction,
  invalidation, removed query, closed session; unsubscribe and unsubscribe during a re-run while core
  `Subscriptions` existed).
- **Where bunvex differs from Convex, internally only:**
  - bunvex's query cache drops entries **eagerly** on commit through the index; Convex's validates each
    entry **lazily** on lookup against the write log. A hit means the same in both: no write since the
    entry overlapped its reads. Making the cache ts-aware and lazy is DV-63's work.
  - the sync hub registers **one read-set per shared execution** (path, args, journal, identity), where
    Convex registers one per session query; the sessions behind a key are notified together.
  - Convex notifies with the earliest invalidating write ts; bunvex's sync sessions re-derive validity from
    the write log (`changedBetween`), so they need no ts from the match.
- **Not built: splaying** (§1.4). Notifications are not delayed when many subscriptions are invalidated
  at once. It is what remains of DV-64.

**Measurements** (Apple M-series, Bun 1.4.2, memory driver; `bench/invalidation.ts` and
`bench/invalidation-e2e.ts`):

| Subscriptions | Match one commit: linear scan | Indexed | Re-register one read-set |
|---|---|---|---|
| 1 000 | 63 µs | 2.0 µs | 4.0 µs |
| 10 000 | 879 µs | 2.8 µs | 5.2 µs |
| 100 000 | 13.4 ms | 5.4 µs | 8.2 µs |

End to end, N subscriptions **and** N cached queries live, each commit patching one random owner's item
(about one re-run and one cache drop per commit):

| N | Writers | Before (commits/s, p50) | After (commits/s, p50) |
|---|---|---|---|
| 0 | 1 | 41 600, 0.021 ms | 43 600, 0.021 ms |
| 1 000 | 1 | 14 100, 0.066 ms | 25 800, 0.034 ms |
| 10 000 | 1 | 485, 1.96 ms | 14 500, 0.043 ms |
| 10 000 | 8 | 1 150, 7.0 ms | 32 700, 0.21 ms |
| 100 000 | 1 | 22, 46 ms | 11 000, 0.053 ms |

Registering costs more than before (it was free): setting up 100 000 subscriptions and 100 000 cached
queries took 3.3 s instead of 1.1 s.

The table above was measured with core `Subscriptions`, before #94 deleted them. After merging `main`,
`bench/invalidation-e2e.ts` keeps the N cached queries only (1 writer, 3 s): N = 1 000: 30 100 commits/s,
p50 0.025 ms; 10 000: 30 500, 0.028 ms; 100 000: 22 400, 0.036 ms.

## 4. Divergences

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | After an error, a subscription whose value returns to its pre-error value is never republished (`subscriptions.ts` `run`: `s.value` is kept on error) | BUG | The client stays on the error until the value changes to something new | **fixed in #11** ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B8) |
| D2 | A subscription whose first run throws never re-runs (`reads` stays `null`; `onCommit` skips it) | BUG | A permanently stuck subscription (e.g. subscribed before the data it needs exists) | **fixed in #11** ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B8) |
| D3 | The query cache returns results by reference (`engine.ts` `query`) | BUG | An action (`ctx.runQuery`) or future in-process caller that mutates a result corrupts the cache for everyone. Convex hands out serialized copies | **fixed in #13** ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B10) |
| D4 | No per-client consistent transitions: each subscription is pushed independently, at its own snapshot | OBSERVABLE | Two queries of one client can show different points in time (torn UI), which Convex never does. Known "N" item | resolved to match Convex (owner, 2026-09-30) in #50 (DV-44) |
| D5 | A mutation resolves before the client's subscriptions reflect it (no ts in `res`, no client-side wait) | OBSERVABLE | Breaks Convex's read-your-writes-after-await guarantee. Known "N" item | resolved to match Convex (owner, 2026-09-30) in #50 (DV-44) |
| D6 | The cache key and subscription key have no identity | BUG (latent) | Harmless today (no auth). The moment `ctx.auth` lands, one user's cached or subscribed result would be served to another unless identity is added, as in Convex's `observed_identity` rule | **fixed for the HTTP query cache in #103**; the sync path is next ([Phase 0](../parity/README.md#phase-0--correctness-bugs-in-what-already-exists) B13) |
| D7 | The cache/subscription key depends on argument field order (`JSON.stringify(args)`) | INTERNAL | Duplicate entries and executions; no wrong results | resolved to match Convex in #21 (DV-45) |
| D8 | No request coalescing; FIFO at 1 000 entries instead of an LRU bounded by bytes; subscriptions bypass the cache | INTERNAL | Performance: thundering herd on a hot key, and memory is unbounded in bytes | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-63) |
| D9 | ~~Invalidation is a linear scan over subscriptions × writes × intervals~~, with no splaying | INTERNAL | Performance at many subscriptions (ENGINE-00 fan-out) | **Decided (owner, 2026-10-01): match Convex** (DV-64). The matching is built (§3.4): an interval index per index, used by the query cache and the sync hub. Splaying is not built yet |
| D10 | Wider read-sets (`take(n)` records the whole range, STUDY-06 D3) cause extra re-runs | INTERNAL | JSON dedupe hides it from clients; costs CPU | Decided (owner, 2026-10-01): match Convex (gap, to be built) (DV-57) |
| D11 | `err` has no `errorData` | OBSERVABLE | `ConvexError` data is lost (STUDY-11) | resolved to match Convex in #32 (DV-49) |

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
