# STUDY-57 — Jepsen-style consistency testing

- **Status:** draft (PR 1: harness, checker, invariants; PR 2: faults; PR 3: nightly on the external stores)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend; Convex's tests from the last commits
  that still had them: `bea52bde0` (Rust, 2026-04-09) and `c358201e1` (TypeScript, 2026-04-08) — Convex
  removed its tests from the open repository in `ba16e0638` and `7a518c760`. Read to learn *what* Convex
  checks; nothing is copied (FSL-1.1-Apache-2.0).
- **Related:** STUDY-08 (subscriptions), STUDY-22 (mutation order), STUDY-23 (sync protocol v1), STUDY-24
  (horizontal scaling), STUDY-26 (the client), docs/parity/client-sync.md §4–§5 (the "N" items), the
  test-hardening work the owner asked for on 2026-10-03.

## 1. How Convex does it

### 1.1 The guarantees

What an app is promised, with where Convex implements it:

| # | Guarantee | Convex source |
|---|---|---|
| G1 | **Serializable transactions.** A mutation commits only if nothing it read changed since its snapshot (OCC); else it re-runs, a bounded number of times, then fails with an OCC error. | `crates/database/src/committer.rs` (`validate_commit`, the write log's conflict check) |
| G2 | **Consistent snapshots.** One transition moves every query of a connection to one timestamp: an app never sees two queries at different points in time. | `crates/sync/src/worker.rs` (`begin_update_queries`, one `new_ts`) |
| G3 | **Read-your-writes.** A mutation's promise resolves only once a transition at or past its commit timestamp was applied: the UI already shows the write. | `npm-packages/convex/src/browser/sync/request_manager.ts` (`removeCompleted`) |
| G4 | **Per-connection mutation order.** A connection's mutations run one at a time, in the order sent. | `crates/sync/src/worker.rs` (`ReceiverStream::new(receiver).buffered(1)`) |
| G5 | **Exactly-once mutations across reconnects.** The client resends a mutation it got no answer for; the server answers a resend of a committed one from its record (session id + request id) instead of running it again. | `crates/application/src/application_function_runner/mod.rs`, `crates/model/src/session_requests` |
| G6 | **At-most-once actions.** Actions are resent only if never sent. | `request_manager.ts` |
| G7 | **No time travel across servers.** A client that observed a timestamp the server does not have is refused. | `crates/sync/src/worker.rs` (`max_observed_timestamp`) |
| G8 | **Subscriptions converge.** After the last write, every live subscription reaches the final state. | `crates/sync/src/state.rs`, `crates/database` subscriptions |

### 1.2 What Convex's own tests check

Read in `bea52bde0` / `c358201e1` (tests no longer published):

- `crates/sync/src/tests.rs`: `test_idempotent_mutations` (G5: the same mutation twice runs once, a bank
  deposit), `test_value_deduplication_success` / `_failure` (an identical result produces no
  modification), `test_udf_cache_out_of_order`, `test_max_observed_timestamp` (G7),
  `test_remove_in_progress_query`, `test_query_failure`, the admin and acting-as-user auth cases.
- `crates/database/src/tests/mod.rs`: `test_delete_conflict` and the other OCC cases (G1),
  `test_occ_error_includes_write_ts`; `committer_race_tests.rs`.
- `crates/application/src/tests/{occ_retries,mutation}.rs`: `test_occ_fails`, `test_occ_succeeds`,
  `test_mutation_occ_fail`, `test_multiple_inserts_dont_occ` (G1, the retry budget);
  `query_cache.rs` (invalidation, the auth races); `scheduled_jobs.rs` (`test_scheduled_jobs_race_condition`).
- `npm-packages/convex/src/browser/sync/request_manager.test.ts`: "mutation retries", "mutation retries with
  transition", "actions are retried only if unsent" (G3, G5, G6); `client_node.test.ts`:
  "maxObservedTimestamp is updated on mutation and transition", "Query results coming back out of order".
- Concurrency exploration: `crates/indexing/src/index_cache/shuttle_tests.rs` (still in `4577b9031`)
  replaces the synchronisation primitives under a feature flag and lets shuttle explore thread
  interleavings. The `proptest` dependency in 39 crates' manifests shows property tests too.

These are **scenario tests**: a hand-built interleaving (pause points, two transactions in a set order)
and an assertion about it. None of the published ones records a history of many concurrent clients and
checks it as a whole, and none injects crashes or network faults into a running system.

## 2. What an app can observe

G1–G8 above. One consequence worth stating, because the checker must not flag it: **a read served from a
query the client already subscribes to is not linearizable across clients** — it is the client's last
snapshot, consistent and monotonic (G2), but it may lag another client's acknowledged write until the next
transition arrives. Convex's `ConvexClient.query` behaves the same (it returns the local result when there
is one). The harness's reads therefore carry a fresh `nonce` argument, so each one is a new subscription the
server evaluates at its latest timestamp — those reads are linearizable, and are checked as such.

## 3. How bunvex does it

`packages/jepsen` (`@bunvex/jepsen`, test-only, never published; rule in `scripts/check-deps.ts`). A package
of its own rather than more of `sync-e2e`: it runs the server as a **separate process** (so a later nemesis
can SIGKILL it), has a CLI for long runs, and will carry a nightly workflow.

### 3.1 The system under test

`src/server.ts` is a real bunvex server process: the workload's functions, the persistence chosen by the
same environment as `bunvex dev` / the server (`PERSISTENCE`, `PERSISTENCE_URL`, `DATA`, `DURABLE=1`). Clients
are real `BunvexClient`s over WebSocket.

### 3.2 The workload

Seeded (mulberry32; the seed is printed with every failure), five clients by default, each one operation
at a time (a Jepsen *process*), on a small key space so operations contend:

| Data type | Operations | Checks |
|---|---|---|
| Registers `r0…r3` | read (fresh query), write (unique values), compare-and-set | linearizable (§3.4) — G1, G2 |
| Bank, 5 accounts × 100 | transfer (refused below zero), read-all | every read and the end total 500, none negative — G1, G2 |
| Grow-only set | add a unique token (one insert) | acknowledged ⊆ final ⊆ attempted, no token twice — G5 |
| Ops log | bursts of 2–5 pipelined appends per client; each reads the client's last entry | per client: commit order = send order, none twice, none lost — G4, G5 |
| Own register `own<c>` | write, then read the live subscription | read-your-writes — G3 |
| Balances, one subscription per account | — | after every transition they sum to 500 — G2 |
| Everything, at the end | — | each client's subscriptions reach the final state — G8 |

Any failure other than an OCC error after the retry budget, or an indeterminate one (connection lost), is
itself a finding: these functions cannot fail on correct data.

### 3.3 The history

Each operation's invocation and completion times (one `performance.now()` clock: the clients share the
runner's process), its arguments and its answer. An operation whose answer never came is *info*: it may or
may not have taken effect.

### 3.4 The checker

Written from the papers, not from any implementation:

- **Wing & Gong** (1993): search for a sequential order consistent with real time and the object's
  specification; **Lowe** (2017): memoise (linearized set, state) pairs; **Herlihy & Wing** (1990):
  linearizability is local, so each register is checked alone.
- *Info* operations get an infinite return time: they may take effect at any point after their invocation,
  or never.
- A violation is shrunk (delta debugging, Zeller & Hildebrandt 2002) to a small history that still fails,
  keeping it well-formed (every value read was written in it).

### 3.5 What it catches (sabotage)

Each of these was introduced on purpose and caught with seed 1 on the memory store:

| Sabotage | Caught as |
|---|---|
| The committer skips OCC validation (`committer.ts`) | lost updates on registers (shrunk to 5 ops: a write lost under a concurrent compare-and-set), bank totals of 487, inconsistent snapshots, duplicate rows |
| The server runs a connection's mutations concurrently (`sync.ts`) | "client 3's mutation 3 committed after its mutation 5" |
| The client resolves a mutation on its response, before the covering transition (`request-manager.ts`) | "client 3 wrote 3000002 to own3, its subscription showed null" |

### 3.6 Reports

A failed run prints the seed, the findings, the smallest failing history and the command that reproduces it,
and writes the full history to `.data/jepsen/<store>-<nemesis>-<seed>.json`.

## 4. Divergences

None: this is a test of bunvex's behaviour against Convex's guarantees, not a feature.

| # | Divergence | Why | Decision |
|---|---|---|---|

## 5. Tests

- `packages/jepsen/test/linearizability.test.ts`: the checker against histories whose answer is known
  (stale reads, lost compare-and-sets, unanswered writes) and a 2 000-operation history from a simulated
  execution, which must pass in under 2 s.
- `packages/jepsen/test/run.test.ts`: the **short run in every PR's CI** (the owner's call, 2026-10-03):
  1.5 s per store on memory and SQLite, a new seed each run (`JEPSEN_SEED` pins one). About 4 s in all.
- The long runs: `bun packages/jepsen/src/cli.ts --store … --seconds … --runs …`; the nightly workflow on
  Postgres, MySQL and MongoDB comes with PR 3.

## 6. Open questions

1. Faults (PR 2): client sockets dropped (a TCP proxy between clients and server), the server SIGKILLed and
   restarted on the same data, store calls delayed or failed (a proxy in front of Postgres/MySQL).
2. Running the same workload against a Convex local backend, as an oracle for G1–G8 — later, if useful.
