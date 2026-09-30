# STUDY-23 — Sync protocol v1: transitions, read-your-writes, sessions, reconnect, auth

- **Status:** accepted — every decision in §6 taken as recommended (owner, 2026-09-30). Implementation
  follows in steps: messages and versions → transitions and read-your-writes → sessions and idempotency →
  reconnect → `@bunvex/client` / `@bunvex/react`.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - [STUDY-08](STUDY-08-cache-and-subscriptions.md): cache and subscriptions (D5 read-your-writes, D6
    identity in keys).
  - [STUDY-11](STUDY-11-function-results-and-errors.md) and [STUDY-20](STUDY-20-function-errors-and-logs.md):
    results, errors, log lines.
  - [STUDY-21](STUDY-21-occ-error-and-retries.md): OCC errors end the connection.
  - [STUDY-22](STUDY-22-ws-mutation-order.md): per-connection mutation order.
  - [docs/parity/client-sync.md](../parity/client-sync.md): the row-by-row inventory of messages and
    client behaviour. This study does not repeat it; it explains the **semantics** and proposes bunvex's
    design.

Paths: `crates/…` are Rust in convex-backend. `browser/…` is `npm-packages/convex/src/browser/…`.

## 1. How Convex does it

### 1.1 Messages

The types are in `crates/convex/sync_types/src/types/mod.rs` (Rust), with the JSON encoding in
`types/json.rs`, and in `browser/sync/protocol.ts` (TypeScript).

The endpoint is `GET /api/{client_version}/sync`, upgraded to a WebSocket
(`crates/local_backend/src/router.rs`, `browser/sync/client.ts`). Frames are JSON text, one message per
frame, tagged by `type`. Timestamps are u64 encoded as base64 little-endian (`u64ToLong`/`longToU64`).

**Client → server:**

| Message | Fields |
|---|---|
| `Connect` | `sessionId` (UUID), `connectionCount`, `lastCloseReason`, `maxObservedTimestamp?`, `clientTs` |
| `ModifyQuerySet` | `baseVersion`, `newVersion`, `modifications: (Add{queryId, udfPath, args:[json], journal?, componentPath?} \| Remove{queryId})[]` |
| `Mutation` / `Action` | `requestId` (u32, per session), `udfPath`, `args: [json]`, `componentPath?` |
| `Authenticate` | `tokenType: "User" \| "Admin" \| "None"`, `value?`, `baseVersion`, `impersonating?` (admin only) |
| `Event` | `eventType`, `event` (client telemetry) |

**Server → client:**

| Message | Fields |
|---|---|
| `Transition` | `startVersion`, `endVersion` (each `{querySet, identity, ts}`), `modifications: (QueryUpdated{queryId, value, logLines, journal} \| QueryFailed{queryId, errorMessage, errorData?, logLines, journal} \| QueryRemoved{queryId})[]`, `clientClockSkew?`, `serverTs?` |
| `TransitionChunk` | a Transition over 5 MB split into parts (`crates/local_backend/src/subs/mod.rs`, `maybe_split_transition`; only for clients new enough) |
| `MutationResponse` | `requestId`, `success`, `result` (value or error message), `errorData?`, **`ts`** (commit ts, on success), `logLines` |
| `ActionResponse` | `requestId`, `success`, `result`, `errorData?`, `logLines` (no ts) |
| `AuthError` | `error`, `baseVersion`, `authUpdateAttempted` |
| `FatalError` | `error`, sent before the server closes the socket on a deterministic user error |
| `Ping` | sent every 15 s when idle (`HEARTBEAT_INTERVAL`, `crates/sync/src/worker.rs`). WebSocket-level pings go every 5 s (`subs/mod.rs`) |

### 1.2 One state version per connection: all queries advance together

`crates/sync/src/state.rs` (`SyncState`) and `crates/sync/src/worker.rs` (`begin_update_queries`,
`finish_update_queries`):

- The server keeps a **`StateVersion {query_set, identity, ts}`** per connection. It only moves forward:
  `advance_version` refuses to go backwards.
- The client's query set is versioned. `ModifyQuerySet` must carry `baseVersion` equal to the last
  version the server received, or the socket fails with `BaseVersionMismatch`. Modifications are
  buffered (`pending_query_updates`) until the next transition is computed.
- **A transition is computed at one timestamp for every query of the connection.**
  `begin_update_queries` takes `new_ts = latest_timestamp()`, then for each query:
  - **Refresh.** A query whose subscription is still valid is extended to `new_ts`
    (`subscription.extend_validity(new_ts)`), without re-running it.
  - **Rerun.** A query that is new, invalidated, or whose identity changed is run
    `ExecuteQueryTimestamp::At(new_ts)`, with up to `UPDATE_QUERY_CONCURRENCY = 20` at once.
  - A query whose result hash (value + log lines, `hash_result`) is unchanged produces **no
    modification**.
- The transition goes out as `Transition {start: current, end: {query_set: latest received, identity,
  ts: new_ts}, modifications}`. The client throws unless `startVersion` equals its current version
  (`browser/sync/remote_query_set.ts`), so transitions are gapless.
- A transition is scheduled (`schedule_update`):
  - when a query is invalidated (`next_invalidated_query`);
  - after the query set or identity changes;
  - **after every mutation or action completes**.

  At most `SYNC_MAX_SEND_TRANSITION_COUNT = 2` transitions wait in the send buffer, and only one is
  computed at a time.
- The client applies the whole transition, then notifies every changed subscription in one batch
  (`browser/sync/client.ts`, `notifyOnQueryResultChanges`). So **a React tree never sees two queries
  from different snapshots**.

### 1.3 Read-your-writes

- `MutationResponse` carries the commit **`ts`** (`crates/sync/src/worker.rs`).
- The client does **not** resolve a successful mutation when its response arrives
  (`browser/sync/request_manager.ts`, `onResponse`). It marks the mutation `Completed{ts}` and resolves
  it in `removeCompleted(ts)`, once a Transition with `endVersion.ts >= ts` has been applied. So when
  `await mutation()` returns, every query on screen already reflects the write.
- Failed mutations and actions resolve immediately: they have nothing to wait for.
- Since the server schedules a transition after each mutation, a covering transition always follows,
  even when no query changed. It may be empty, and then only moves `ts`.
- The worker's select loop polls mutation results before transitions (`select_biased!`, "we can't
  transition to a timestamp past a pending mutation").
- The client tracks `maxObservedTimestamp`, the highest ts seen in a transition or a mutation response.
  It sends it in `Connect`. A server whose latest ts is below it refuses the connection
  ("Client has observed a timestamp … ahead of the backend latest known timestamp"). This guards
  linearizability across backends.

### 1.4 Sessions, request ids, idempotency

- The client picks a random **session id** (UUID v4, `browser/sync/session.ts`) when it is
  constructed. It is kept across reconnects, not across page loads. Request ids count up from 0 per
  client (`_nextRequestId`).
- A mutation with a session is identified by `SessionRequestIdentifier {session_id, request_id}`.
  Each attempt of the mutation (`application_function_runner/mod.rs`) proceeds as follows:
  - It first calls **`check_mutation_status`**, which looks the identifier up in the system table
    **`_session_requests`** (`crates/model/src/session_requests`).
  - If found, it returns the recorded result and commit ts **without running the mutation again**.
  - On success, `write_mutation_status` inserts the record `{session_id, request_id, outcome: {result,
    log_lines}, identity}` **in the same transaction** as the mutation's writes. So a mutation is recorded
    if and only if it committed. Failures are not recorded: they had no effects and may be re-run.
  - `_session_requests` is purged after `MAX_SESSION_CLEANUP_DURATION_HOURS` = 336 h, two weeks
    (`crates/common/src/knobs.rs`, `crates/application/src/system_table_cleanup`).
- The server request id for logs is `sha256(session_id | request_id)` truncated to 16 hex characters
  (`RequestId::new_for_ws_session`).
- **Actions are not idempotent.** On reconnect the client fails in-flight actions with "Connection
  lost while action was in flight" (`request_manager.ts`, `restart`) instead of re-sending them.

### 1.5 Reconnect and resend

When a new socket opens, the client (`browser/sync/client.ts`, `onOpen`):

1. sends `Connect` with the same `sessionId`, `connectionCount`, `lastCloseReason` and
   `maxObservedTimestamp`;
2. starts a fresh `RemoteQuerySet` (version 0);
3. re-sends the whole query set as one `ModifyQuerySet {baseVersion: 0, newVersion: 1}`, with every
   query's `journal` (`local_state.ts`, `restart`);
4. sends `Authenticate {baseVersion: 0}` if it has auth;
5. re-sends **every unresolved mutation**, including those already answered but not yet covered by a
   transition, since idempotency makes that safe.

The server starts every connection from `StateVersion::initial()`.

Backoff (`browser/sync/web_socket_manager.ts`, `nextBackoff`):

- The initial delay is 100 ms for client-side causes and 1 s for unknown ones. Server close reasons
  have their own values (`serverDisconnectErrors`, e.g. `InternalServerError` 1 s).
- The delay doubles per retry up to 16 s, with ±50% jitter. Backoff resets once the client has synced
  past the reconnect: every re-sent query and mutation confirmed (`hasSyncedPastLastReconnect`).
- The client reconnects if nothing arrives for 60 s (`serverInactivityThreshold`).
- Close codes (`crates/errors/src/lib.rs`, `close_frame`):
  - 1000 for not-found or forbidden;
  - **1013 "Again"** for OCC, rate limits and overload, with the short error code as the reason;
  - 1011 for internal errors;
  - none for client errors, which get a `FatalError` first.

### 1.6 Authentication messages

- `Authenticate {baseVersion, tokenType, value}` must match the server's received identity version.
  Otherwise it fails. The server validates the token (`fetch_identity`), bumps the identity version
  (`SyncState::modify_identity`) and schedules a transition.
- When the identity version changes, **every subscription is dropped and every query re-runs** with
  the new identity (`take_subscriptions` when `identity_changed`). The transition's `endVersion.identity`
  tells the client when its queries reflect the new token.
- A rejected token gives an `AuthError {baseVersion, authUpdateAttempted: true}`. An expiring identity
  is revalidated before each operation (`revalidate_identity`). An expired one gives an `AuthError` with
  `authUpdateAttempted: false`.
- The client side (`browser/sync/authentication_manager.ts`):
  - it can pause the socket until the first token is confirmed (`expectAuth`);
  - it refreshes before expiry (`refreshTokenLeewaySeconds`, default 10 s);
  - it retries a failed confirmation twice;
  - it treats a transition whose identity version reaches its own as confirmation.

## 2. What an app can observe

1. **Consistent snapshots.** All of a client's query results come from one database timestamp. Two
   queries never show different moments.
2. **Read-your-writes.** After `await mutation()`, every subscribed query already reflects it.
3. **Exactly-once mutations across reconnects** (for two weeks), and mutations run in order per
   connection (STUDY-22). Actions are at-most-once: they fail on disconnect.
4. **Seamless reconnect.** Subscriptions come back with their pagination journals, and pending
   mutations are re-sent. The UI keeps its last results until the new transition.
5. **Auth changes are atomic.** Queries re-run under the new identity and switch together.

## 3. What bunvex has today (v0)

`packages/protocol/src/index.ts`, `packages/server/src/server.ts`, `packages/core/src/subscriptions.ts`:

- `/ws` with `sub`/`unsub` keyed by `path + NUL + JSON(args)`, and `mut {id}`.
- Replies are `upd`/`err`/`res`, with error data and log lines since STUDY-20.
- **Subscriptions are shared across all connections per key.** Each runs at its own snapshot and is
  fanned out through Bun's pub/sub topics.
- There are no versions, no timestamps on the wire, no session, no idempotency, no auth and no client
  library.
- Mutations are ordered per connection (STUDY-22).

## 4. Proposed design for bunvex

### 4.1 Wire format: speak Convex's v1

Adopt Convex's message set and JSON shapes as listed in §1.1: the same `type` names, field names and
base64 u64 timestamps, at `GET /api/{client_version}/sync`.

- Nothing in these messages contains the word "convex", so rule 5 holds.
- The official `convex` npm client could then be used as a **conformance oracle** in bunvex's tests.
  Its `ConvexReactClient` against a bunvex server exercises the real protocol, including
  reconnects.
- `@bunvex/client` stays a from-scratch implementation of the same protocol.
- `@bunvex/protocol` gets the v1 types and codecs, and drops v0: there is no production data or
  client to keep compatible.

### 4.2 Per-connection sync state, shared query executions

The server keeps a `SyncSession` per connection (new, in `@bunvex/server`):

- `version: {querySet, identity, ts}`;
- `queries: Map<queryId, {key, journal, lastResultHash, readValidAt}>`;
- `pendingModifications`;
- `identity`;
- `sessionId`;
- `transitionScheduled`.

**A transition** is computed like Convex's `begin_update_queries`:

1. Take `T = committer.visibleTs`.
2. For each of the connection's queries, find a result valid at `T`:
   - **Reuse** the shared `Sub` result for the key when its reads saw no commit in `(snapshot, T]`. The
     committer's write log already answers that (`overlaps`), and the existing `Sub.reads` hold the
     read-set. This is Convex's `extend_validity`.
   - **Otherwise run** the query at snapshot `T`. This needs `Engine.queryTracked(body, snapshot)` to
     accept an explicit snapshot (MVCC already allows it). The result is shared: all connections that
     need `key@T` await one execution (single-flight map keyed by `key + T`).
3. Compare each result's hash with the connection's last one. Send
   `Transition{start: version, end: {querySet: received, identity, ts: T}, changed…}` and advance
   `version`.

This keeps bunvex's cheap part — one execution per distinct query and snapshot, not per connection —
and adds per-connection assembly. **Bun's per-key pub/sub no longer fits**: a transition is
per-connection. Values stay JSON text and are spliced into the frame, so per-connection cost is string
concatenation of the changed queries only.

A transition is scheduled:

- when a commit overlaps any of the connection's queries (the `Subscriptions.onCommit` hook, per
  session instead of per key);
- when the query set or identity changes;
- after each of the connection's mutations completes.

As in Convex, at most one transition is computed per connection at a time, and later triggers coalesce
into the next one. A commit burst therefore yields one transition per connection per "round", not one
per commit.

### 4.3 Mutations: commit ts, ordering, idempotency

- `MutationResponse.ts` is the commit ts returned by `committer.commit`. `engine.mutation` needs to
  return it alongside the value.
- The per-connection queue from STUDY-22 remains. The response is sent, then a transition is
  scheduled.
- **Idempotency:**
  - a system table `_session_requests {sessionId, requestId, value(json), logLines, ts}`, with an index on
    `(sessionId, requestId)`;
  - the mutation runner checks it at the start of each attempt and inserts the record in the same
    transaction as the mutation's writes, as Convex does;
  - a periodic cleanup deletes records older than two weeks; this is the "retention" item of Phase 3.
  - The catalog work (STUDY-04) already supports system tables.
- `maxObservedTimestamp` check: refuse `Connect` when it exceeds `visibleTs`.

**As built (step 4).** `packages/core/src/session-requests.ts` and `Engine.sessionMutation`:

- The record has Convex's fields:
  - `{sessionId, requestId (int64), outcome: {type: "mutation", result (JSON text), logLines}, identity}`;
  - `identity` is `"unknown"` until auth;
  - index `by_session_id_and_request_id`.
- The lookup runs at the start of every attempt and is in the read-set. Two concurrent runs of one
  request therefore conflict, and the loser replays the winner's outcome.
- Only a successful run is recorded, in its own transaction. A failed one wrote nothing and simply runs
  again when resent.
- A connection without `Connect` has no session and gets no idempotency, as in Convex.
- App code cannot read the table: `System table _session_requests is not accessible here.`
- Retention (`packages/server/src/session-cleanup.ts`), as Convex's `SystemTableCleanupWorker`:
  - a random wait of up to 30 min per run;
  - deletes records by `_creationTime` older than the window;
  - 64 per transaction, at most 256/s;
  - the window is `MAX_SESSION_CLEANUP_DURATION_HOURS` (default 2 weeks, 0 = forever), or
    `sessionRequestRetentionMs` in `createServer`.
- **The replay's ts (P13).** Convex answers a resend with the original commit's ts, read from the
  record's version. bunvex's `Persistence` does not expose a version's ts, so a replay answers the ts of
  the snapshot that saw the record, which is at or after the commit.
  - The client uses this ts only to wait for a transition at ≥ it and as `maxObservedTimestamp`. Both
    stay correct, and the wait may just end one transition later.
  - Apps cannot observe it.
- **Cost.** Every session mutation also writes one record document with 3 indexes, as in Convex.
  `packages/server/bench/sync-mutations.ts` has 64 connections doing a read and an insert:

  | Store | No session | With a session |
  |---|---|---|
  | memory | 27k/s | 16.7k/s |
  | local Postgres | 8.6k/s | 4.3k/s |

  HTTP mutations are unaffected.

bunvex ts is a counter resumed from persistence (STUDY-06 D9), so it is monotonic across restarts; the
check still holds.

### 4.4 Actions over the WebSocket

`Action` / `ActionResponse` run concurrently, outside the mutation queue, with at most 1000 in flight
(`TooManyInflightActionsForSingleClient`). The client fails them on reconnect.

### 4.5 Reconnect

This needs no server state across connections beyond `_session_requests`: every connection starts at
`StateVersion::initial()`, as in Convex.

- Close codes: 1013 with the error code as the reason for OCC or overload (STUDY-21 D2 and STUDY-22 D1
  become this), 1011 for internal errors, and `FatalError` then close for client errors (bad
  `baseVersion`, malformed messages). Today bunvex silently drops malformed frames.
- The server sends a `Ping` after 15 s idle. Bun's WS pings stay on; `idleTimeout` is revisited to
  match Convex's 120 s dead-peer threshold.

### 4.6 Authentication

The protocol slots come now, the verification later (Phase 3, auth):

- `Authenticate` with `baseVersion` checking;
- the identity version in `StateVersion`;
- `AuthError`;
- all queries re-run on identity change.

Until `@bunvex/auth` exists, `tokenType: "None"` is the only accepted value, and others get an
`AuthError`. **Identity must enter the shared execution key** before auth lands. This is STUDY-08 D6,
latent today: `key@T` becomes `key@T@identity` for queries that read `ctx.auth`, or for all queries at
first.

### 4.7 Order of work (suggested PRs)

1. `@bunvex/protocol` v1 types and codecs (base64 u64), plus the new endpoint running alongside `/ws`
   during the transition. `/ws` is then deleted.
2. `SyncSession`: query-set versions, transitions at one ts (engine snapshot parameter, shared
   `key@T` executions), result hashing, `Ping`, `FatalError`.
3. Mutation `ts`, the transition after each mutation, and `maxObservedTimestamp`.
4. `_session_requests` idempotency and its cleanup.
5. WS actions.
6. Auth messages (verification with `@bunvex/auth`).
7. `@bunvex/client` (base client, request manager, local state, backoff), tested against both a
   bunvex server and, for protocol conformance, the official client against bunvex.

## 5. Tests (for the implementation PRs)

- Two subscriptions over data one mutation changes both of: the client never observes them at
  different ts. Assert on the frames: a single Transition carries both.
- `await mutation()` then read the subscription synchronously: it already shows the write, across
  varied commit/rerun interleavings (property test).
- Kill the socket between the commit and the response. After reconnect and resend, the mutation ran
  once and the promise resolves with the recorded value.
- `baseVersion` mismatch leads to `FatalError` and close. `maxObservedTimestamp` ahead leads to a
  refusal.
- Identity change: every query re-runs, and `endVersion.identity` advances.
- Performance: fan-out of one hot query to N connections, comparing per-key pub/sub (v0) with
  per-connection transitions (v1). Reported in the PR.

## 6. Decisions (accepted as recommended, owner, 2026-09-30)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| P1 | Wire compatibility | (a) Convex's v1 JSON exactly, at `/api/{version}/sync`; (b) Convex's semantics in bunvex's own compact frames | **(a)**: lets the official client serve as a test oracle, costs nothing in naming (no "convex" strings), and frames are not the bottleneck |
| P2 | Drop v0 (`/ws`, `sub`/`upd`/`res`) once v1 lands | keep both for a while / delete | **delete** (no production users; owner's "old APIs may be removed") |
| P3 | Shared executions vs per-connection executions | (a) per-connection query runs, as in Convex; (b) shared `key@T` executions with per-connection transition assembly | **(b)**: same observable behaviour, keeps bunvex's fan-out advantage |
| P4 | Transition timestamp | always `visibleTs` at computation start (Convex) / the max ts at which all results are already valid, avoiding reruns | **Convex's** (latest), simpler reasoning, same as Convex |
| P5 | Idempotency storage | `_session_requests` system table in the engine, transactional (Convex) / an in-memory map | **system table**: exactly-once must survive a server restart |
| P6 | Retention of `_session_requests` | Convex's 2 weeks / other | **2 weeks** |
| P7 | Timestamps on the wire | commit counter (today) / Convex-like nanosecond wall-clock ts (STUDY-06 D9) | the counter works for the protocol; decide D9 separately, before `db.vars.commitTs` or import/export |
| P8 | `TransitionChunk` for > 5 MB transitions | implement now / later | **later** (after the client), with the client-version gate |
| P9 | Auth before `@bunvex/auth` | accept only `None` / accept any token unverified | **only `None`** (never trust an unverified token) |
| P10 | Identity in execution keys | per-query (only those that read `ctx.auth`, needs tracking) / all queries | **all queries** first (correct and simple), refine later |
| P11 | Client telemetry `Event` messages | accept and ignore / log | **accept and ignore** |
| P12 | Actions over WS | with v1 / later | **with v1**: the official client sends actions over the socket |
| P13 | A replayed session mutation's `ts` (step 4, **open**) | (a) the snapshot that saw the record (≥ the commit); (b) the original commit ts, as Convex, which needs `Persistence` to return a version's ts (a PERSIST-01 change) | **(a)** for now: same client behavior, no contract change while PERSIST-01 C7 is in flight; (b) if something ever needs the exact value |

## 7. Open questions

1. Does the dashboard (another session's work) need an admin-auth path over the socket
   (`tokenType: "Admin"`, `componentPath`) from the first v1 PR?
2. Should `@bunvex/client` also offer the HTTP client's mutation queue (`ConvexHttpClient`'s
   `skipQueue`)? That is a separate study.
