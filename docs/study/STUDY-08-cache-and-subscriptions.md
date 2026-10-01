# STUDY-08 — Query cache and subscriptions

- **Status:** decided — D1–D3 fixed (#11, #13); D6 fixed for the HTTP query cache (#103), the sync path next (Phase 0 B13); D4, D5, D7, D11 resolved to match Convex (DV-44, DV-45, DV-49); D9 resolved to match Convex (#119, #121; DV-64); D10 resolved to match Convex in #134 (DV-57, STUDY-06 §9); D8 built to match Convex (§1.6, §3.6; DV-63), with one decided internal divergence (§3.6, DV-153). Retroactive: the code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`; §1.4 and §3.4 (D9) at `9c9bd14`; §1.5 and §3.5 (splaying) at
  `3ed8c33`; §1.6 and §3.6 (D8, the query cache) at `8cf412a`
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

The details (sizes, coalescing, validation, what is not cached) are in §1.6.

### 1.2 Subscriptions

`crates/database/src/subscription.rs`, `SubscriptionManager`:

- A subscription is a `Token`: a read-set at a ts.
- The manager follows the write log (`advance_log`). It finds the subscriptions whose read-set
  overlaps each write through an interval index (`overlapping_database`), and notifies them.
- **Splaying:** when a very large number of subscriptions is invalidated at once, the notifications
  are spread over time (`SUBSCRIPTION_INVALIDATION_DELAY_*` knobs; §1.5).
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
- **Splaying** (`:576-622`): see §1.5.
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

### 1.5 Splaying a wide invalidation (DV-64)

Read at commit `4577b9031`.

- **The knobs** (`crates/common/src/knobs.rs`), both read from the environment:
  - `SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD` (`:1983-1986`), default **200**: "the maximum number of
    subscriptions that can be invalidated immediately";
  - `SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER` (`:1988-1996`), default **5 ms**: "the average number of
    milliseconds to wait between notifying subscriptions invalidated by the same commit";
  - `NUM_SUBSCRIPTION_MANAGERS` (`:1972-1976`), default **1**, also multiplies the window ("the same
    widely-invalidating commit most likely affects all of the workers equally", `subscription.rs:580-582`).
- **The rule** (`advance_log`, `crates/database/src/subscription.rs:576-624`):
  - `count` is the number of subscribers collected by this pass (`to_notify.len()`, `:577`): every
    commit since the last pass, deduplicated per subscriber. A subscriber is **one subscription**, which the
    sync worker creates per query of a session (§1.4), so a session with three invalidated queries counts
    three.
  - Splaying applies when `count > threshold` (`:578-579`, strictly greater: 200 is not splayed, 201 is).
  - The window is `count × multiplier × managers` ms (`:583-585`). **It scales with the count and has no
    cap**: 10 000 invalidated subscriptions spread over 50 s. The mean gap between notifications stays
    about 5 ms, so a wide invalidation is drained at about 200 subscriptions per second.
  - Each subscription draws its **own** delay, `rand::random_range(0..=window)` (`:619`): uniform over the
    integers from 0 to the window, both ends included.
  - **System subscriptions are exempt** (`:613-618`): `is_system` is set by
    `Database::subscribe_and_wait_for_invalidation` (`crates/database/src/database.rs:2149-2157`), which
    the backend's own workers use; the sync worker's `Database::subscribe` (`:2145-2147`) passes `false`,
    so every client query is splayed. Nothing else is exempt, and nothing turns it off in tests.
  - A log line at info level records each splay (`:586-594`).
- **What is delayed is only the wake-up.** `_remove` (`:762-772`) takes the subscriber out of the maps at
  once and calls `drop_with_delay` (`:196-210`), which marks the subscription **invalid at once** and
  only delays the `watch` signal that wakes `wait_for_invalidation` (the comment at `:826`: the signal
  "may lag behind `validity` in case of subscription splaying"). The delayed task ends early when the
  receiver is dropped (`valid_tx.closed()`, `:202`), so a closed session leaves nothing running.
- **What that means for a session** (`crates/sync/src/worker.rs`, `state.rs`):
  - The worker wakes when any of its queries' invalidation futures completes
    (`next_invalidated_query`, `worker.rs:458-462`): at the **earliest** delay among its invalidated
    queries.
  - Any other trigger also schedules an update at once: the session's own mutation or action completing
    (`worker.rs:443-457`), a query set change, an auth change. The update takes every subscription and
    aborts every invalidation future (`take_subscriptions`, `state.rs:362-376`), then checks each query
    with `extend_validity` (`crates/application/src/api.rs:642-668`), which sees the invalidation at once
    (`current_ts()` is `None`). So **read-your-writes is not delayed**: after its own mutation a client
    gets a transition covering the write without waiting for its splayed notification. This is not an
    explicit exemption; it falls out of the wake-up being the only thing delayed.
  - A query rerun during an update is subscribed anew; `subscribe` refreshes its token through the write
    log first (`subscription.rs:416-440`), so a commit that landed meanwhile makes it invalid **at once**,
    without a splay.
  - A subscription already invalidated is out of the maps, so a later commit in the same window does not
    count it again or give it a second delay.

### 1.6 The query cache in detail (D8, DV-63)

Read at commit `4577b9031`; `crates/application/src/cache/mod.rs` unless named.

- **Who goes through it.** Every query: `ApplicationFunctionRunner::run_query_at_ts_inner`
  (`crates/application/src/application_function_runner/mod.rs:1986-2015`) calls `CacheManager::get` with a
  ts. The HTTP API's `/api/query` passes the latest ts (`Application::read_only_udf`,
  `crates/application/src/lib.rs:1227-1250`, `now_ts_for_reads`), `/api/query_at_ts` the ts it was given
  (`read_only_udf_at_ts`, `:1251`), the sync worker the transition's ts (`ExecuteQueryTimestamp::At`,
  `crates/sync/src/worker.rs:1150`, `:1169`), and an action's `runQuery` goes the same way (`execute_query`,
  `crates/application/src/application_function_runner/mod.rs:2127-2136`).
- **The key** (`RequestedCacheKey`, `:153`; `StoredCacheKey`, `:251`): tenant, function path, serialized
  arguments, identity, journal, allowed visibility. A lookup tries the precise key (with the identity) and
  then the one with `identity: None` (`_possible_cache_keys`, `:164`; `get_cache_entry`, `:190`). A
  result is stored under the precise key only if the run read the identity (`cache_keys_after_execution`,
  `:208`), and, when the run's journal differs from the requested one, under both journals (`:224-245`).
- **The store** (`Inner`, `:861`): an `LruCache::unbounded()` (`:877`) plus a byte count and a limit,
  `UDF_CACHE_MAX_SIZE` = 104 857 600 (`crates/common/src/knobs.rs:66-69`; Conductor's shared cache has its
  own 1 GiB, `:71-73`, not used by the open-source backend). A lookup uses `LruCache::get`, which marks the
  entry as recently used.
  - **Size of an entry** (`StoredCacheKey::size`, `:264`; `CacheEntry::size`, `:287`;
    `HeapSize for CacheResult`, `:307`): the key's struct size plus the heap of its path, arguments,
    identity and journal, plus the entry's struct size plus, for a ready result, the heap of the outcome
    (value, log lines, journal, …), its ts and its token (the read-set). A waiting entry counts 0 heap.
  - **Eviction** (`enforce_size_limit`, `:1095-1110`): after every insert, pop the least recently used
    entry while the total is over the limit. The new entry is the most recently used, so it goes last: a
    result larger than the whole budget **evicts everything, then itself**.
- **Entries** (`CacheEntry`, `:273`): `Ready(CacheResult)`, with the outcome, `original_ts` (the ts it ran
  at) and a `Token` (read-set + ts) (`:300`); or `Waiting { id, started, receiver, ts }`, a run in progress.
- **The loop** (`_get`, `:382-551`), with a fixed `ts` per request:
  1. **Plan** (`plan_cache_op`, from `:887`):
     - a `Ready` entry with `original_ts <= ts` → serve it; with `original_ts > ts` → run **without** a
       waiting entry (`go(None)`, `:922-935`);
     - a `Waiting` entry at a ts `<= ts` → wait for it; at a later ts → run without a waiting entry
       (`:943-946`); a peer running longer than `TOTAL_QUERY_TIMEOUT` (16 s) is removed and the plan retried
       (`:953-961`);
     - nothing → insert a `Waiting` entry and run (`put_waiting`, `:1025`).
     The key used is the one found, else the **hint** kept from an earlier iteration (`stored_key_hint`,
     `:405-412`): a result stored shared and found invalid is recomputed under the shared key, so callers
     of other identities wait for that run.
  2. **Perform** (`perform_cache_op`, `:604-764`). A run broadcasts its result to the waiters only if it
     succeeded **and** is stored under the waiting key (`:750-758`); otherwise it drops the sender ("Send
     an error to receivers so any waiting peers will retry", `:757`). A waiter whose sender is dropped
     removes the waiting entry and plans again (`:630-637`). So when a run **throws**, its own caller gets
     the error and **every waiter plans again**: one of them runs the query, the others wait for it, and so
     on; each caller ends with its own run's error. The same happens when the first run of a query that
     reads no identity, coordinated under the precise key, stores its result shared: the waiters plan
     again and then hit the shared entry.
  3. **Validate** (`validate_cache_result`, `:768-822`): `ts < original_ts` → plan again (`:774`); refresh
     the token to `ts` through the write log (`:780`, `refresh_token` → `WriteLog::refresh_token`,
     `crates/database/src/write_log.rs:623`, `is_stale`, `:600`): a write into the read-set, or a token
     older than the log's retention, makes the result invalid; it is removed (`remove_ready`) and the loop
     plans again (`:780-791`). A result that **read the clock** (`outcome.observed_time`) older than
     `MAX_CACHE_AGE`, or that far in the future, is removed too (`:793-820`).
  4. **Store** (`:500-510`): a successful outcome is put under its stored keys **only by the run that held
     the waiting entry** (`WaitingEntryGuard::complete`, `:844-850`); a cache hit's refreshed token is not
     written back, although the comment above says a hit "will bump the cache result's token".
     `put_ready` (`:1059-1093`) replaces a waiting entry, or an older result (lower `original_ts`, or the
     same with an older token), and drops a result older than the one stored. JS errors are never stored
     (`:504`), and a stored error is a developer error (`panic!`, `:617`, `:650`).
  - A guard removes the waiting entry if the run's future is dropped (`WaitingEntryGuard`, `:828-859`). The
    whole loop fails after `TOTAL_QUERY_TIMEOUT` (`:419-428`).
- **Time:** `TOTAL_QUERY_TIMEOUT` = `DATABASE_UDF_USER_TIMEOUT` (1 s) + `DATABASE_UDF_SYSTEM_TIMEOUT` (15 s)
  (`:114`, `knobs.rs:984-996`); `MAX_CACHE_AGE` = that + 1 s = **17 s** (`:121`). `observed_time` is set
  by `Date.now()`/`new Date()` (`unix_timestamp`), `performance.now()` and the explicit `observe_time` during
  execution (`crates/isolate/src/environment/udf/phase.rs:510-600`), not during import.
- **A cache hit** is re-authorized (`authorize_cache_hit`, `:555-601`): a caller that may not run the
  function gets the visibility error instead of the result.
- **The subscription path does not use the cache's map**: a cached result is validated per lookup, at a
  cost proportional to the writes since its token (§1.4).

## 2. What an app can observe

1. **Consistency:** all subscribed queries of a client update atomically, at one timestamp.
2. **Read-your-writes:** after a mutation resolves, the client's queries include its effect.
3. **Recovery:** a query that throws, and later succeeds, pushes the new value, even when that value
   equals one it pushed before the error.
4. **Errors** carry `errorData` for a `ConvexError`.
5. **Auth isolation:** a query that reads `ctx.auth` is cached per identity; one that does not is
   shared.
6. **A wide write reaches other clients gradually:** when one commit invalidates more than 200
   subscriptions, clients see it spread over up to `count × 5 ms` (50 s for 10 000). The writing client's
   own transition, and any client's next mutation, are not delayed.
7. **The query cache** is invisible except through time and logs: a hit is the result the query would
   give at that ts, with the log lines of the run that produced it (also for callers that waited for
   another's run); a result that read the clock is at most 17 s old; an error is never served from the
   cache (each caller of a failing query gets its own run's error).

## 3. How bunvex does it today

### 3.1 The query cache (before D8 was built)

As read at `f60e934`; D3, D6 and D7 were fixed since (#13, #103, #21), and §3.6 replaces the rest.

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
     the index on invalidation and on FIFO eviction (`dropCached`). **Removed by D8 (§3.6):** the cache now
     validates an entry when it is looked up, as Convex's, and no longer uses the index.
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
    entry overlapped its reads. Making the cache ts-aware and lazy is DV-63's work. (Done in §3.6: the
    cache is lazy now, as Convex's.)
  - the sync hub registers **one read-set per shared execution** (path, args, journal, identity), where
    Convex registers one per session query; the sessions behind a key are notified together.
  - Convex notifies with the earliest invalidating write ts; bunvex's sync sessions re-derive validity from
    the write log (`changedBetween`), so they need no ts from the match.
- **Splaying** (§1.5) is built in §3.5.

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
p50 0.025 ms; 10 000: 30 500, 0.028 ms; 100 000: 22 400, 0.036 ms. Since §3.6 a commit does not touch the
query cache at all, so that benchmark now measures commits next to N idle cache entries.

### 3.5 Splaying (DV-64, built)

**Decision (owner, 2026-10-01): approved as Convex; may revisit (a cap would be a divergence).** Convex's
splay is kept as is, with its knobs and defaults: 10 000 invalidated subscriptions are spread over about
50 s. A cap on the window would be a divergence and needs the owner.

`packages/server/src/sync.ts`, `SyncHub.onCommit` and `SyncSession`:

- **Counting as Convex counts.** A commit's matched keys give their watching sessions; each (session,
  key) pair counts as many subscriptions as the session has **queries** on that key (`keyCounts`, rebuilt
  with the watched keys), so the count is Convex's one-per-session-query even though the hub matches one
  read-set per shared execution (§3.4).
- **The rule** is §1.5's: `count > threshold` splays; the window is `count × multiplierMs`; each session
  query draws `floor(random() × (window + 1))` (uniform over 0..=window), and the session's timer is set to
  the **smallest** of its draws, which is when Convex's worker would first wake. `NUM_SUBSCRIPTION_MANAGERS`
  is 1 (one hub per process), its default in Convex.
- **Only the wake-up is delayed**, as in Convex: `SyncSession.scheduleAfter` sets a timer that calls the
  usual `schedule()`. Every transition starts by dropping the pending timer (`cancelSplay`, in the same tick
  as it reads its ts), because it reruns every query stale at that ts (`changedBetween`, §3.4), which covers
  the splayed ones; this is Convex's `take_subscriptions` aborting the futures. So a session's own mutation,
  query set change or identity change still triggers its transition at once, and the splayed notification
  does not add a second, empty one.
- **No double counting.** Keys with a pending splayed notification are remembered per session
  (`splayedKeys`) and are not counted or re-drawn by later commits until a transition starts, as Convex's
  invalidated subscribers have left the map.
- **A query rerun during a transition** is not held back: if a commit landed into it while it ran, the next
  transition follows at once even when a splay timer is pending (Convex's fresh subscription is invalid at
  once). Queries the transition did not rerun wait for the timer.
- **Closing** a session (`close`) and stopping the hub (`stop`) clear the timers.
- **Settings:** `createServer({ subscriptionSplay })` takes `threshold`, `multiplierMs`, `random` and
  `timers`; otherwise Convex's knob names are read from the environment, else Convex's defaults (200, 5 ms).
  `multiplierMs: 0` turns splaying off. The default random is the CSPRNG (`crypto.getRandomValues`), not
  `Math.random`, which is seeded inside executions (STUDY-03); tests inject a seeded one and a fake clock.
- **No system exemption is needed:** only sync sessions subscribe through the hub; bunvex's own workers
  (scheduler, crons, cleanup) do not use subscriptions.
- **Protocol v0** (`/ws`, core `Subscriptions`) was never splayed; #94 deleted it (STUDY-23 P2), so every
  subscription now goes through the sync hub and is splayed.
- **Internal differences:** Convex logs each splay at info level; bunvex counts them in
  `SyncHub.stats.splayed` and logs nothing (it has no info-level logging).

**Tests** (`packages/server/test/splay.test.ts`, in-process sessions on a fake clock), each checked by
breaking the code and watching it fail: 200 invalidated subscriptions are not delayed and 201 are; above
the threshold every session gets its transition, within `count × 5 ms`, spread over the window; the count is
of session queries (67 sessions × 3 queries on two keys are splayed); each query draws its own delay and the
window's end is included; a session's own mutation gets its covering transition at once and only once; a
session closed while pending leaves no timer and gets nothing; a pending query is not counted again; a
narrow commit during a pending splay is not delayed; a commit into a query being rerun is not held back.

**Measurements** (`packages/server/bench/sync-splay.ts`, Apple M1 Pro, Bun 1.4.2, memory driver, in-process
sessions, so the per-socket send cost, about 6 µs per frame, is not included). One write invalidates the
query every session watches; a 1 ms timer measures how late the event loop runs it:

| Sessions | Splay | Commit (incl. notify) | All transitions delivered | Timer lateness p99 | Max |
|---|---|---|---|---|---|
| 1 000 | off | 4.2 ms | 5 ms | 4.3 ms (one stall) | 4.3 ms |
| 1 000 | on | 1.1 ms | 5.0 s | 1.3 ms | 14 ms |
| 10 000 | off | 14–16 ms | 26 ms | 25 ms (one stall) | 25 ms |
| 10 000 | on | 6.1 ms | 50.0 s | 1.2–1.3 ms | 10–17 ms |

Off (`multiplierMs: 0`) runs every session's transition in one burst, which blocks the loop for the whole
delivery. On, the work is spread at about 200 transitions per second; what remains of the stall is the
commit's own notification pass (10 000 draws and timers) and garbage collection. The price is Convex's:
the last session sees the write about 50 s later.

### 3.6 The query cache as Convex's (D8, DV-63, built)

**Decision (owner, 2026-10-01): match Convex.** `packages/core/src/query-cache.ts` (the store) and
`Engine.cachedQuery` / `runCached` / `stillValid` in `packages/core/src/engine.ts` (§1.6's loop), written
from scratch.

- **Who goes through it:** the HTTP API's `/api/query` (at the latest ts), `/api/query_at_ts` (at its ts;
  before, it was never cached) and actions' `runQuery` (`packages/server/src/functions.ts`). Sync
  subscriptions keep their own shared executions (`SyncHub`, DV-09); see "What remains".
- **The key** is the function name, the arguments' canonical JSON and the identity, tried precise first,
  then shared (`*`), as before (STUDY-27). Visibility is checked before the lookup (`Functions.fn`), so an
  internal function never reaches the cache from a client, which is what Convex's visibility key and
  `authorize_cache_hit` guarantee. There is no journal in the key: HTTP queries and `runQuery` carry
  none, and nothing that does (sync) uses this cache, so Convex's second key under the run's journal would
  never be looked up.
- **The store** is an LRU bounded by bytes: a `Map` in use order (a lookup re-inserts the key), a byte
  count and `maxBytes`, by default `UDF_CACHE_MAX_SIZE` from the environment, else 100 MiB
  (`Engine` option `cacheMaxBytes`). An entry's size is a fixed overhead (360 bytes, measured) plus its
  key, its JSON, its log lines and its read-set's keys. After every insert the least recently used entries
  go until the total fits, the new one last: a result larger than the budget empties the cache and is not
  kept, as Convex's.
- **Entries** are `ready` (the JSON, the log lines, `originalTs`, `tokenTs`, the read-set, whether the run
  read the clock and when) or `waiting` (an id, the ts the run is at and a promise of its result).
- **The loop** is §1.6's, with a ts fixed per call: a ready result at or before `ts` is checked; a waiting
  run at or before `ts` is waited for, then checked; otherwise the call runs the query itself, under a
  waiting entry if nothing newer is there (else, as Convex's `go(None)`, its result is returned and not
  stored). The `stored_key_hint` rule is kept: an invalid shared result is rerun under the shared key.
  - A run that **throws** removes its waiting entry and settles it with "plan again"; its caller gets the
    error, each waiter plans again, so (as Convex) one runs, the rest wait, and every caller ends with its
    own run's error. Errors are never stored.
  - A run whose result is stored under another key than its waiting entry (the first run of a query that
    reads no identity) settles its waiters with "plan again", and they then hit the shared entry.
  - **Validation** (`stillValid`): `ts < originalTs` → plan again; `committer.changedBetween(reads,
    tokenTs, ts)` (the write log per index, as Convex's `refresh_token`; a token older than the log's
    retention counts as changed) → drop and plan again; a result that read the clock and is more than
    `MAX_CACHE_AGE_MS` = 17 000 ms old (or ahead) → drop and plan again.
  - The run's own caller is answered without validation: its result is at its ts by construction. (Convex
    validates it too, which only matters for a run longer than 17 s; Convex's 16 s query timeout prevents
    that, bunvex has none yet.)
- **Reading the clock** is now recorded: `Date.now()`, `new Date()`, `Date()` and `performance.now()`
  inside an execution set `observed.time` (`packages/core/src/determinism.ts`), Convex's `observed_time`. The age
  is measured on the real wall clock (the `Engine` option `cacheClock` replaces it in tests; moving the
  process's clock instead would also move the engine's monotonic timestamps).
- **No invalidation on commit:** `Engine.cacheReads` and the commit hook are gone; a commit costs the cache
  nothing. The insert rule "only if `visibleTs` did not move during the run" is gone too: a result is
  stored at the ts it ran at, and a later lookup checks the commits since. A query whose runs always
  overlapped some commit used to be never cached; now only commits into its reads matter.
- **An index change** (enable, disable, drop) still empties the cache, and a run begun before is not
  stored (`cacheEpoch`): a cached result may have read an index that is gone, and no write into its
  read-set would ever invalidate it.
- **Statistics:** `cacheHits` (answers from the cache, waiters included), `cacheWaits` (calls that waited
  for another's run), `cacheMisses` (runs); `engine.cache.size`, `.bytes`, `.evictions`.

**Where bunvex differs from Convex, internally only:**

- **A hit writes its refreshed token back** (`tokenTs = ts`), so the next lookup only checks the commits
  after it. Convex's step 4 says a hit "will bump the cache result's token", but its guard only stores a
  fresh run's result, so in Convex every lookup re-checks every commit since the entry was made (up to the
  write log's retention). Not observable: the answer is the same. Measured below: without the write-back,
  the CPU-bound mixed workload served 17 200–23 100 reads/s instead of about 33 000. **Decided (owner,
  2026-10-01): keep it (DV-153).**
- **No timeouts** in the loop (Convex: a peer older than 16 s is abandoned, and a call fails after 16 s):
  a bunvex run is an in-process promise that always settles, and bunvex has no query time limit yet
  (docs/parity/server-api.md, "user execution time ≤ 1 s", missing). They come with that limit.
- **Entry sizes** are estimates calibrated against the heap, not Rust's struct and heap sizes.

**What remains of D8:** sync subscriptions do not go through this cache. Their executions are shared by
`SyncHub` (one per path, args, journal, identity and ts, single-flight, validated against the write log),
which is DV-09; HTTP and sync do not share results with each other. Not observable.

**Tests** (`packages/core/test/query-cache.test.ts`, `packages/server/test/query-cache.test.ts`), each
checked by breaking the code and watching it fail: an insert over the budget evicts the least recently used
entry (lookup not promoting → fails; no eviction → fails); a result larger than the budget empties the
cache and is not kept (keeping the newest entry → fails); 32 concurrent identical queries in process, and 64
concurrent identical HTTP requests, run once and all get the result and its log lines (waiters ignoring the
run under way → fails); different arguments or identities run apart, and concurrent callers of a query
that reads the identity each get their own answer (storing without the identity, or coordinating without
it → fails); a throwing query: every caller gets the error, nothing is cached, and the waiters each run
again, as Convex (settling waiters with the failure instead → fails); a stale shared result is rerun once for
callers of three identities; a write into the read-set is seen, one outside it is served from the cache
(no write-log check → fails); a result is cached even when other commits land while it runs (the old
insert rule → fails); a hit moves the token forward (no write-back → fails); a result that read the clock
expires after 17 s and one that did not never does (no age check, or `Date.now()` not recorded → fails); a
result cached at ts serves a later ts and not an earlier one (serving the newer result → fails); a result
whose token fell out of the write log's retention runs again; `query_at_ts` is answered from the cache
(bypassing it → fails); and the B13 test in `auth.test.ts`.

**Measurements** (`packages/server/bench/query-cache.ts`, Apple M1 Pro, Bun 1.4.2, memory driver, client
and server in one process over HTTP; three runs each, interleaved with `origin/main` at `8cf412a`; the
median, and the range where it matters). `LATENCY_MS=1` delays every document read by 1 ms, as a database
over a network would; without it the memory driver answers a query within one turn of the event loop, so
requests never overlap.

| Scenario | Before (FIFO, eager) | After (as Convex) |
|---|---|---|
| hot: 64 clients, one query of 2 000 docs, a write into it every 20 ms, no latency | 4 887 req/s, p99 28.8 ms, runs = writes | 5 598 req/s, p99 21.7 ms, runs = writes |
| hot: same, 20 docs, 1 ms latency, a write every 20 ms | 2 798 req/s, p50 24.6, p99 36.6 ms, **12 700 runs** | 1 959 req/s (1 789–2 269), p50 27.8, p99 60.3 ms, **187 runs** |
| hot: same, a write every 100 ms | 32 135 req/s, p99 24.7 ms, 3 000 runs | 32 426 req/s, p99 24.8 ms, **47 runs** (one per write) |
| mixed: 64 readers over 1 000 owners (Zipf), 4 writers, no latency | 32 984 reads/s, hit rate 0.965 | 32 902 reads/s, hit rate 0.965 |
| mixed: same, 1 ms latency | 2 779 reads/s, **hit rate 0** | 31 314 reads/s, **hit rate 0.976** |
| memory: 2 000 distinct results of 100 kB | 97.9 MiB heap, 1 000 entries | 102.4 MiB heap, 1 046 entries (100 MiB counted) |
| memory: 1 500 distinct results of 400 kB | **393 MiB** heap, 1 000 entries | **111.7 MiB** heap, 262 entries |
| memory: 400 000 distinct results of 100 B | (1 000 entries, 1 MiB) | 112.8 MiB heap, 202 429 entries (100 MiB counted) |

- **Coalescing** cuts the runs of a hot query to one per invalidation: 12 700 → 187 and 3 000 → 47. Before,
  each of the 64 clients that missed ran its own copy, so the database did 64 times the work.
- **The price** shows when a hot query is invalidated about as often as it takes to run (a write every
  20 ms into a 21 ms query): a caller that waited for a run, and whose own ts is past a write that landed
  during it, must wait for the next run, so the median rises by about 3 ms and p99 from 37 to 60 ms. This is
  Convex's design (§1.6, step 3). With writes every 100 ms the latency is the same as before.
- **Hit rate under writes:** with real read latency, every run before overlapped some commit, so nothing was
  ever cached; now only commits into the query's reads matter.
- **Memory** is bounded by bytes instead of by count: 400 kB results used 393 MiB before, 112 MiB now;
  small results now use the budget (200 000 entries kept instead of 1 000).
- In the mixed run with latency the writers' rate falls (1 100 → 650 writes/s) because the readers now get
  answers and use the shared CPU; in a separate client process this would not happen.

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
| D8 | No request coalescing; FIFO at 1 000 entries instead of an LRU bounded by bytes; subscriptions bypass the cache | INTERNAL | Performance: thundering herd on a hot key, and memory is unbounded in bytes | **Decided (owner, 2026-10-01): match Convex. Built (§3.6, DV-63):** an LRU bounded by bytes (100 MiB), coalescing, lazy validation against the write log, MAX_CACHE_AGE for clock readers, `query_at_ts` cached. Internal differences: a hit writes its token back (**decided: keep it, DV-153**), no timeouts until queries have one; sync keeps its shared executions (DV-09) |
| D9 | ~~Invalidation is a linear scan over subscriptions × writes × intervals~~, with no splaying | INTERNAL | Performance at many subscriptions (ENGINE-00 fan-out) | **Decided (owner, 2026-10-01): match Convex.** Built: the matching (§3.4), an interval index per index used by the query cache and the sync hub; and splaying (§3.5), as Convex's knobs and defaults. Resolved (DV-64). Splaying: owner, 2026-10-01: approved as Convex; may revisit (a cap would be a divergence) |
| D10 | Wider read-sets (`take(n)` records the whole range, STUDY-06 D3) cause extra re-runs | INTERNAL | JSON dedupe hides it from clients; costs CPU | **as Convex, fixed in #134** (owner, 2026-10-01: match Convex; DV-57): the read-set ends at the last key read ([STUDY-06 §9](STUDY-06-transactions-and-occ.md#9-d3-as-built-the-read-set-ends-at-the-last-key-read)); a cached or subscribed `first()` re-runs 0 times per append past its head (was 1) |
| D11 | `err` has no `errorData` | OBSERVABLE | `ConvexError` data is lost (STUDY-11) | resolved to match Convex in #32 (DV-49) |

## 5. Tests

- **Error recovery:** value A → throw → A again must publish A. A first run that throws, followed by
  a write that fixes the data, must publish the value.
- **Aliasing:** mutating a returned cached value does not change the next hit.
- **Consistency (once implemented):** one client subscribes to `count()` and `list()` over the same
  table while a writer inserts. Every Transition shows `count === list.length`.
- **Read-your-writes (once implemented):** after `await mutation()`, the client's subscribed query
  already includes the write, with no extra wait.
- **Splaying** (§3.5): threshold, window, per-query draws, read-your-writes, close during a pending splay.
- **Narrow read-sets** (D10): appends past a subscribed `first()` re-run nothing; deleting its head re-runs
  it (`packages/server/test/sync.test.ts`); the same for a cached query (`read-set-prefix.test.ts`).
- **Cross-check:** the same scenario on Convex with the official client, comparing the sequence of
  observed states.

## 6. Open questions

1. ~~Should the query cache become ts-aware?~~ Yes, as Convex's (§3.6): an entry serves any ts at or
   after the one it ran at, until a commit writes into its reads.
2. Should subscriptions share the cache, as Convex's do, to collapse identical executions across
   clients and HTTP? Not now: `SyncHub` already shares one execution per key and ts (DV-09); sharing
   results between HTTP and sync is not observable. Confirmed by the owner, 2026-10-01.
3. **Decided (owner, 2026-10-01; DV-153):** a cache hit writes its refreshed token back (§3.6), which Convex's comment intends
   and its code does not do. Accepted as recommended: keep it (not observable, about 1.6× the reads/s in the
   CPU-bound mixed benchmark).
