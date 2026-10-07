# STUDY-136 — The index cache: a cache of persistence index reads

- **Status:** implemented. I1–I6 accepted as recommended (owner, 2026-10-06: "sim pode seguir, vamos
  implementar"); DV-432–DV-434 decided.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend. The history of
  `crates/indexing/src/index_cache` was read from `5eebe2be3` (2026-03-30) to `a21cba307` (2026-09-09).
  Background: Convex's talk "Scaling Infrastructure With Confidence in the Age of AI".
- **bunvex code read:** `main` at `5943704f` (after #491, STUDY-133 PR 3, which changed the `Persistence`
  read interface).
- **Related:**
  - [STUDY-08](STUDY-08-cache-and-subscriptions.md): the query cache, D8; the lazy validation against the
    write log reused here.
  - [STUDY-06](STUDY-06-transactions-and-occ.md): the write log, D10/D11.
  - [STUDY-24](STUDY-24-horizontal-scaling.md): followers, which would consume the same write stream.
  - [STUDY-57](STUDY-57-linearizability-testing.md): Jepsen.
  - [STUDY-132](STUDY-132-deterministic-test-runtime.md): the test runtime.
  - [STUDY-133](STUDY-133-persistence-layout-identical.md): the drivers' layouts. They are being changed in
    parallel, but the read interface the cache sits on does not move.

**Why this study exists.** Convex added a cache under its query cache in May 2026 to absorb a 100× read
spike: OpenClaw's skills page went viral. In the talk they report:

- a 75% hit rate;
- 80% less database load;
- query and mutation latency down by about 50%.

bunvex has no such layer. Every index read a function makes goes to `Persistence`. This study reads how
Convex built it, measures what a cache would gain for bunvex, and proposes how to build it.

## 1. How Convex does it

### 1.1 What is cached

`crates/indexing/src/index_cache/mod.rs`:

- **The key** is `CacheKey { deployment_id, index_id, interval, order, max_size }` (`:85-92`): one exact
  `index_page(index, tablet, interval, order, max_results)` call. There is no timestamp in the key; the
  continuation cursor is part of the value.
- **The value** (`CachedInterval`, `:663-678`) holds:
  - the page's entries (index key, document ts, the packed document);
  - the cursor;
  - its size;
  - `begin_ts`, the snapshot the persistence read was made at;
  - `is_ready`;
  - a `populate_id`.
- **Where it sits.** At the very bottom. `IndexCacheReader` wraps the persistence `IndexReader`
  (`crates/indexing/src/database_index_snapshot.rs:92-112, :209-284`).
- **What goes through it.** Every database index read:
  - `get` by id, a `by_id` singleton range with `max_size` 2 (`crates/database/src/transaction.rs:1112-1150`);
  - `withIndex` ranges;
  - paginated and full scans, as repeated `index_page` calls (`crates/indexing/src/index_reader.rs:124-142`).
- **What does not.** Text and vector search, and the function runner's own transactions. The function
  runner has a separate whole-index cache for system tables, `InMemoryIndexCache`
  (`crates/function_runner/src/in_memory_indexes.rs:117-215`).
- **No overlay of recent commits.** A commit is written to persistence before the write log and the
  snapshot ts are published (`crates/database/src/committer.rs:1082-1136`). So a read at a repeatable ts
  always reads persistence, and the write log only serves conflict checks, subscriptions and this cache.

### 1.2 Lookup

`IndexCacheHandle::get` (`mod.rs:387-432`) finds the entry and serves it when:

- it is ready;
- the read's ts is ≥ `begin_ts` (`:681-702`);
- its interval is still tracked for the index.

The reasoning (`:691-693`): any write into the interval removes the entry, so a present entry is valid at
every ts from `begin_ts` on. A read below `begin_ts` misses. A read below the snapshot manager's earliest
ts skips the cache (`crates/database/src/database.rs:1730-1736`).

### 1.3 Eager invalidation at commit

- **When.** `Committer::publish_commit` (`committer.rs:1091-1139`) runs after the persistence write. It
  appends the commit to the write log with a callback that calls `apply_writes` (`:1111-1123`), and only
  then pushes the new snapshot (`:1135`). So entries are invalidated before the commit ts is readable.
- **How.** `apply_writes` (`mod.rs:606-660`):
  - finds the cached intervals that contain each written key, old and new, with an `IntervalMap` per index
    (crate `interval_map`, `:192-209`), and removes them;
  - for a write to `_index` (an index changed or dropped), untracks every interval of that index
    (`:619-623`).

### 1.4 Populate: the race the talk is about

A reader fills an entry with what it read at ts `T`. A commit at `T' > T` that writes into the interval
can run between the persistence read and the insert. If the entry were simply inserted, it would be stale
forever, because the invalidation has already happened. Convex's `populate` (`mod.rs:434-601`) closes the
race in two phases:

1. **Phase 1.**
   - Allocate a `populate_id` (`:462-465`).
   - Insert the entry **not ready**, only if the key is absent (`:489-509`).
   - Register its interval, refcounted (`:511-517`).
   - Then replay the write log after `T` for this index and for `_index`: a write in the interval, or to
     this index, removes the entry (`:519-554`). This uses `iter_writes_after`
     (`crates/database/src/write_log.rs:838-857`).
2. **Phase 2.** Under moka's per-key compute lock, mark the entry ready only if all of these still hold
   (`:559-599`):
   - the entry exists;
   - it has the same `begin_ts` and the same `populate_id`;
   - its interval is still tracked.

This works because the write log is appended **before** `apply_writes` runs (`write_log.rs:867-881`).
Either a racing write is already in the log, and the replay catches it; or it runs after the
registration, and Phase 2 finds the entry gone.

The bugs found while running it in production show how subtle the protocol is. Each is one commit:

| Commit | What it fixed |
|---|---|
| `69f9b33e6` | Refcounted intervals: moka's eviction listener is not atomic. |
| `0dcbe587b` | Insert the interval atomically. |
| `203a55093` | Use `and_compute_with`, because moka's `insert` is not isolated from it. |
| `0db98755d` | `AtomicCache` (`crates/indexing/src/atomic_cache.rs`), because moka's `remove`/`invalidate` skip the compute lock. |
| `365519c88` | `populate_id`, for a key re-created concurrently. |
| `3edec2608` | Drop on an index change. |
| `d201269a2` | Skip the cache when there is no snapshot for the ts. |

### 1.5 Sizes, knobs, metrics, tenancy

- **Knobs** (`crates/common/src/knobs.rs`):
  - `INDEX_CACHE_SIZE`: bytes, default **512 MiB** (`:2039-2042`; it was raised from a lower value in
    `6e9b3a071`);
  - `INDEX_CACHE_VERIFY_PERCENT`: default **100** (`:2078-2081`, see §1.6).
- **Eviction.** A moka cache, patched to a fork (`Cargo.toml:286`). Its weigher is `2·key + value`, since
  the key is also held in the interval map (`mod.rs:242-248`).
- **No on/off switch.** Self-hosted builds it always (`crates/local_backend/src/lib.rs:174`).
- **Metrics** (`crates/indexing/src/metrics.rs:77-119`):
  - invalidations;
  - size evictions;
  - get seconds by hit/miss;
  - populate seconds by result: `populated`, `already_exists`, `invalid`, `foreign_entry`,
    `out_of_retention`, `unknown_index`;
  - `apply_writes` seconds;
  - a bytes gauge.
- **Tenancy.** One cache per process, shared by every deployment on it. Each `Database` gets a handle with
  a fresh `DeploymentId` (`mod.rs:283-313`). The deployment id is in the key, and its entries are removed
  at shutdown.

### 1.6 Verification: "run it in production and compare"

On every hit, with probability `INDEX_CACHE_VERIFY_PERCENT` (and always under `test`), the page is **also
read from persistence and compared** (`database_index_snapshot.rs:226-260`):

- a mismatch is logged with its kind (key, value, ts only, extra on either side) and the process panics;
- the cached page is what is returned.

With the default of 100, **a self-hosted Convex reads persistence for every hit**: the cache costs memory
and CPU and takes no load off the database. The gains in the talk are from Convex's cloud, where the knob
is presumably set lower. That value is not public.

### 1.7 The shuttle tests

`crates/indexing/src/index_cache/shuttle_tests.rs` runs under `--features shuttle-testing`:

- **How.** The feature swaps `DashMap` and `parking_lot::Mutex` for shuttle's (`mod.rs:33-49`) and turns
  on the moka fork's shuttle mode (`crates/indexing/Cargo.toml:19-28`). A `RandomScheduler` runs each
  scenario hundreds of times (`:66-73`).
- **What is published.** The helpers mirror production's order: append to the log, then `apply_writes`.
  The test bodies and the mock write log are stripped from the public repository at every commit.
- **The scenarios, from the commit messages.** Populate against a write, against an eviction, against
  another populate, and against an index change.
- **The invariant.** A read never gets a stale page.

## 2. What an app can observe

Nothing, functionally. A hit is proven equal to reading persistence at the same ts, so query results,
OCC conflicts, subscriptions and errors are all the same. What an app can see:

- **Latency and throughput**, for queries **and mutations**. Mutations read through the cache too, which
  the query cache does not help with.
- **Memory**: up to `INDEX_CACHE_SIZE`.
- **The load on the database**, for a store behind a network.

## 3. How bunvex does it

### 3.1 Today

- **`get` by id** (`packages/core/src/tx.ts:943-963`): the transaction's own writes first, then one
  `persistence.get`.
- **`withIndex(...).take(n)`, `.first()`, `.unique()`**: one `persistence.scan` (`tx.ts:1166-1189`).
- **`.filter`, `collect`, iteration, `.paginate`**: scan pages of 64, doubling up to 1024
  (`tx.ts:1212-1238`).
- **Nothing in between.** No cache, no overlay of recent commits: readers read at `visibleTs`, which only
  moves after the flush (`committer.ts:704`). This is the same layering as Convex's.
- **The query cache** (`query-cache.ts`, `engine.ts:2885-3003`) caches whole results. Its key is the
  function, the args and the caller when the function read `ctx.auth`. An entry is checked **lazily** at
  lookup, against the write log, with `committer.changedBetween(reads, from, to)` (`committer.ts:413-419`).

What a read costs per driver:

| Driver | `scan` | `get` |
|---|---|---|
| memory | in process, O(log n + k) | map lookup |
| SQLite | in process, one statement | one statement |
| Postgres | 1 round trip; 2+ when keys are split (`postgres.ts:559-601`) | 1 round trip |
| MySQL | 2+ round trips (`mysql.ts:590-661`) | 1 round trip |
| MongoDB | 2+ round trips (`mongodb.ts:523-580`) | 1 round trip |

### 3.2 The design: Convex's cache, with lazy validation

One `IndexCache` per engine (`packages/core/src/index-cache.ts`):

- **An entry** is one `scan(index, lo, hi, limit, desc)` or one `get(id)`, with the result and the ts `t`
  it is known valid at.
- **Lookup at ts `s`.** The entry is served when `changedBetween([interval], min(t, s), max(t, s))` is
  false, meaning no commit in between wrote into the interval. Then `t` moves up to `s`. The check is
  symmetric: an unchanged interval gives the same result at either end, so a read at an older snapshot
  can hit too. Convex's cannot.
- **The interval.**
  - For a scan: `[lo, hi)` of the index. It is conservative: a write past the `limit`-th row still
    invalidates.
  - For a `get`: the `by_id` point, which is what the transaction records in its read-set already.
- **A commit does nothing to the cache.** The write log already holds every write (it is appended at
  `committer.ts:626-628`, before `visibleTs` moves), and the lookup consults it.
- **Fill.** Store what was read, stamped with the snapshot it was read at. An entry with a newer stamp is
  not replaced.

**Why lazy rather than Convex's eager invalidation.** It removes the race of §1.4 by construction:

- An entry never has to be invalidated, so a fill that races a commit cannot install something stale. The
  stamp is the read's own snapshot, and every later lookup checks the log from that stamp.
- There is no populate/ready protocol, no `populate_id`, no refcounted interval map and no atomic-cache
  wrapper.
- bunvex is single-threaded JavaScript. Its only interleavings are between `await`s, and the lazy design
  has no state that spans an `await`.
- This is the same choice bunvex made for the query cache (STUDY-08 D8, DV-63), and it reuses the same
  `changedBetween`.

**What it costs.**

- **A lookup** is a binary search per index in the write log plus the writes in the window (`WritesByIndex`,
  `write-log-index.ts:68-157`). Convex's eager design pays at commit instead.
- **When the write log is purged past an entry's stamp** (Convex's 30 s–300 s / 50 MiB retention, STUDY-06
  D10), the entry counts as changed and is re-read. An idle entry older than the log is re-read once, then
  stays hot. Convex's entry survives any idle time, because only writes remove it.

**What else writes to persistence.**

- **The index backfill.** It writes entries outside commits (`index-worker.ts:283`, PERSIST-01 C17), but
  only into an index nothing can read yet: `resolveIndex` serves an index only from its `readyTs`
  (`tx.ts:819-831`).
- **Retention.** It deletes versions only below the oldest readable snapshot, and the transaction already
  refuses reads there (`retention.check`).
- **The rest.** Index changes, table deletion and imports are all commits, so they are in the log.

### 3.3 As built

- **`packages/core/src/index-cache.ts`.** `IndexCache.scan` and `IndexCache.get`, keyed by index id, key
  bytes, limit and order. The entries are kept in an LRU bounded by an estimate of their bytes (UTF-16
  strings at two bytes a character, plus a fixed overhead per row and per entry). A read bigger than a
  sixteenth of the budget is not kept. The stats are hits, misses by reason (`new`, `stale`), evictions,
  verified hits and mismatches.
- **`tx.ts`.** The two persistence read sites, `read` (`get`) and `storeRangeOf` (`scan`), go through
  `tx.indexCache` when the engine has one. Both stay inside `storeCall` (user time paused) and around the
  same retention checks as before.
- **`Engine`.** `indexCacheOf` (`engine.ts`) builds the cache:
  - The option `indexCache: false | { maxBytes, verifyPercent }` wins.
  - Otherwise Convex's knobs apply: `INDEX_CACHE_SIZE` (bytes, default 512 MiB; `0` turns it off) and
    `INDEX_CACHE_VERIFY_PERCENT` (0–100, default 0, DV-433). A malformed value fails the start.
  - The memory driver declares `readsInMemory` (an optional `Persistence` field), and its engine gets no
    cache unless the option or `INDEX_CACHE_SIZE` asks for one (DV-434).
- **Verification**, as Convex's (§1.6). A verified hit that differs from persistence:
  - logs `bunvex: index cache: the cached read … differs from persistence at ts …`;
  - drops the entry;
  - fails the read with `IndexCacheMismatchError`.

  Convex panics the process instead; failing the one read is the closest a shared JS process gets without
  taking every other request down with it.
- **Observability.**
  - Prometheus: `bunvex_index_cache_hits_total`, `_misses_total`, `_invalidations_total` (stale entries
    found), `_size_evictions_total`, `_bytes`. These are Convex's metric set, minus its timing histograms.
  - `GET /api/debug/index_cache` (ViewMetrics), next to AD-25's `query_cache`: the counters, misses by
    reason, size and budget, or `{ enabled: false }`.

### 3.4 Measurement

`bench/index-cache.ts`, in process, is a chat-like app:

- 1000 channels with 50 messages each (`by_channel`), 10 000 users and one settings document.
- **The query** reads its user, the settings and the newest 20 messages of a channel. Its query-cache key
  includes the user, as a query that reads `ctx.auth` does.
- **The mutation** reads its user, the settings and the channel, then inserts a message into it.
- Channels and users are drawn with a Zipf(1) skew; 32 concurrent clients; 10% mutations.
- Phases alternate the index cache off and on, with fresh caches each time. Persistence calls are counted
  under the engine.

Measured on 2026-10-06 on an Apple Silicon Mac, with Postgres 17 in Docker on the same machine. Each cell
is the mean of two 10 s phases, after a warm-up phase; "→" reads off → on. The raw runs are in [INDEX-CACHE-2026-10-06](../bench/INDEX-CACHE-2026-10-06.md).

| Run | ops/s | query p50 (ms) | mutation p50 (ms) | store calls / op | index-cache hit rate |
|---|---|---|---|---|---|
| **Postgres**, 10% writes | 2 260 → **9 115 (4.0×)** | 11.8 → **0.08** | 27.9 → 20.4 | 2.79 → 0.25 | 91% |
| **Postgres**, the query cache never hits (`SCENARIO=unique`) | 1 979 → **8 532 (4.3×)** | 12.8 → 0.09 | 29.4 → 22.0 | 3.0 → 0.26 | 91% |
| **Postgres**, 50% writes | 2 365 → **5 169 (2.2×)** | 6.6 → 1.6 | 18.7 → 9.8 | 2.98 → 0.43 | 86% |
| **Postgres**, worst case: uniform draw, 90% writes, a 50 KB cache | 2 369 → 2 900 (+22%) | 5.7 → 3.8 | 13.3 → 10.8 | 3.0 → 1.89 | 37% |
| **SQLite**, 10% writes | 6 720 → **11 380 (1.7×)** | 2.4 → 1.2 | 23.8 → 13.0 | 2.72 → 0.18 | 93% |
| **memory**, 10% writes | 13 173 → 13 018 (−1%) | 1.1 → 1.1 | 11.9 → 11.9 | 2.72 → 0.17 | 94% |
| **memory**, the worst case | 19 800 → 15 800 (about −15% to −28%) | 0.86 → 1.0 | 1.45 → 1.7 | 3.0 → 1.89 | 37% |

**As built**, the same bench rerun on the implementation (§3.3):

| Run | ops/s | query p50 (ms) | mutation p50 (ms) | store calls / op | index-cache hit rate |
|---|---|---|---|---|---|
| Postgres, 10% writes | 2 360 → **9 773 (4.1×)** | 11.8 → 0.08 | 27.3 → 19.4 | 2.79 → 0.24 | 91% |
| Postgres, `SCENARIO=unique` | 2 194 → **9 030 (4.1×)** | 12.2 → 0.09 | 27.1 → 20.5 | 3.0 → 0.25 | 92% |
| Postgres, 50% writes | 2 343 → **5 213 (2.2×)** | 6.7 → 1.6 | 18.6 → 9.6 | 2.98 → 0.43 | 86% |
| SQLite, 10% writes | 6 990 → **11 833 (1.7×)** | 2.3 → 1.2 | 22.4 → 12.7 | 2.73 → 0.18 | 93% |

What the numbers say:

- **On Postgres the database stops being the bottleneck.**
  - Store calls per operation fall by 91%.
  - With 4× the work, the store gets about a third of the calls it got before (≈ 2.3k/s against ≈ 6.3k/s).
  - Query latency drops from a round trip to a map lookup.
  - Mutations gain too: their `get`s hit. The query cache never helps those.
  - This is the effect Convex reports: 80% less load on the database and about 50% lower latency.
- **SQLite gains 1.7×.** A statement through `bun:sqlite` costs far more than a map lookup.
- **The memory driver gains nothing.** Its reads already are in-memory lookups. Under heavy writes with a
  cache too small to hold anything, the bookkeeping costs up to a fifth or more. These memory runs drift a
  lot, because the tables grow by 20k documents/s, so the range is wide.
- **Even the worst case wins on Postgres** (+22%), because a 37% hit rate on the hot settings document
  still saves round trips.

**Caveats.**

- **In process.** No HTTP, no WebSocket and no function isolation; the bench's functions are plain
  closures. An end-to-end run adds the same fixed cost to both sides, so ratios will be smaller.
- **The store is local.** Its round trip is a fraction of a millisecond. A store across a network (RDS, a
  managed Postgres) makes each saved call worth more.
- **The workload is skewed.** Zipf(1), with a hot set of about 8 MB that fits the cache. Convex reports a
  75% hit rate in production.
- **The query cache is weak here on purpose.** Its keys are per user, so the index cache gets the
  repeated reads. When the query cache hits, the index cache is never reached.

## 4. Decisions

Nothing here changes what an app observes, so none of it is a divergence in behaviour. Some of it differs
from Convex in mechanism or in knob defaults, and those are listed for the owner as the rule asks. **All six
were accepted as recommended (owner, 2026-10-06).**

| # | Question | Options | Recommendation (accepted) |
|---|---|---|---|
| I1 | Build an index cache at all | A: yes; B: no, the query cache is enough | **A**: 2.2–4.3× on Postgres in §3.4, mutations included; invisible to apps. |
| I2 | Invalidation | A: lazy, against the write log (§3.2); B: eager at commit, as Convex | **A**: same results, no populate race, reuses `changedBetween`. Not observable. DV-432. |
| I3 | `INDEX_CACHE_VERIFY_PERCENT` default | A: 100, as Convex (every hit also reads persistence: no load taken off the store, a shadow mode); B: 0, with the knob kept for a shadow run | **B**: with A the cache gains nothing on a remote store (§1.6). DV-433. |
| I4 | `INDEX_CACHE_SIZE` | A: 512 MiB, as Convex; B: lower, e.g. 64 MiB, for a small self-hosted box | **A**, same knob name: it is a ceiling, not an allocation; the hot set of §3.4 was 8 MB. |
| I5 | On for which drivers | A: all, as Convex; B: every driver but memory | **B**: memory measured −1% (and worse under writes); SQLite +70%. Convex has no in-memory store, so there is nothing to diverge from there; recorded anyway as DV-434. |
| I6 | Metrics | `bunvex_index_cache_*` counters and bytes, plus misses by reason in a debug route, as the query cache has (STUDY-114) | as proposed; built as §3.3 |

Tenancy (§1.5) has no counterpart: a bunvex process serves one deployment.

## 5. Tests

**Unit and property tests:** `packages/core/test/index-cache.property.test.ts`, against a fake write log.

- **The race of §1.4**, the counterpart of Convex's shuttle tests. Random sequences of:
  - commits, which write or delete a key;
  - scans (any range, limit and order) and gets, at the latest or an older snapshot;
  - write-log purges;
  - resolutions of pending persistence reads, in any order.

  Each read's persistence call stays pending until the scheduler resolves it, so commits and other fills
  land in between. Every completed read must equal the model's answer at its snapshot, with random byte
  budgets (evictions mid-run) and with verification on or off. 500 cases; BUNVEX_PROPERTY_MULTIPLIER raises
  it at night.
- **Unit cases:**
  - a hit at a later and at an earlier snapshot;
  - a write in the range makes an entry stale; one outside it, or in another index, does not;
  - a purged log makes a miss;
  - a snapshot past the visible ts is neither served nor stored;
  - LRU eviction and the size bound;
  - a verified mismatch fails the read and drops the entry.

**The knobs:** `packages/core/test/index-cache-knobs.test.ts`: defaults, `INDEX_CACHE_SIZE` and `0`, bad
values, the option, and the memory driver.

**The engine over real stores:** `bench/index-cache-verify.test.ts`.

- **The workload.** 8 concurrent clients run random mutations: inserts, patches that move a document across
  index ranges, deletes, and writes to another table. They also run random reads (`get`, ranges in both
  orders with limits, `first`, a page, a whole collect) inside queries, at the latest and at older
  snapshots, and inside mutations.
- **The check.** Every hit is verified, so a single stale entry fails the test. The test also asserts that
  the cache was exercised (hits, and stale entries).
- **The control.** A last case replaces the cache with one that ignores the write log, and checks the
  harness catches it.
- **Where it runs.** Memory and SQLite in `bun test`; Postgres, MySQL and MongoDB in their CI conformance
  jobs.
- **OCC.** A mutation that exhausts its OCC retries under contention is counted, not failed: that is the
  engine's answer, and slow stores make it likelier.

**Everything else, with the cache on.** CI job `tests · index cache on, every hit verified` runs the core,
server, testing, sync-e2e and bench suites with `INDEX_CACHE_SIZE=536870912 INDEX_CACHE_VERIFY_PERCENT=100`.
That puts the cache in every engine, the memory driver's included, and verifies every hit, as Convex's
`cfg!(test)` does. Outside that job, every SQLite engine in the suites runs with the cache on by default.

**Jepsen** (STUDY-57) adds coverage, but it is not what guarantees the cache.

- **The nightly runs** on Postgres, MySQL and MongoDB now have the cache on (the default) and unverified, so
  a stale hit would reach the linearizability checker as a stale read.
- **A local run** on Postgres with the cache on passed: 12 runs with partitions, kills and store faults.
- **What it catches.** A cache that ignores the write log fails it at once (stale catalog reads).
- **What it misses.** The subtle race of §1.4 (the fill stamped with "now") passed 6 runs, verified or
  not: its workload rarely opens the window. The property test and the verified engine test each caught
  that sabotage in 10 runs out of 10.

**Sabotage checks**, each done by hand:

- **Validity always true.** With the write-log check replaced by "unchanged":
  - the core suite fails (381 tests in the prototype);
  - the engine test fails on memory, SQLite and Postgres;
  - Jepsen fails.
- **The fill stamped with "now"** instead of its own snapshot (Convex's race):
  - The property test fails, 10 runs out of 10. Its minimal counterexample is the race itself: a read
    starts, a commit writes into its range, the read fills, and the next read gets the stale page.
  - The engine test fails, 10 out of 10, on memory and SQLite, and on Postgres too.
  - Jepsen does not catch it (above).

**The benchmark.** §3.4 is `bench/index-cache.ts`, kept for the "change that can affect performance" rule.

## 6. Open questions

- **Cross-limit hits.** `take(20)` and `take(21)` of one range are separate entries. So are `≥ 18` and
  `≥ 19`, which the talk also left out. Not worth it until a measurement says otherwise.
- **Paginated scans.** Pages after the first are keyed by their continuation key, which is stable, so they
  cache too. A paginated query that pages through a table that changes often will mostly miss.
- **Followers** (STUDY-24) would each have their own cache, fed by the commit stream they already need for
  subscriptions.
