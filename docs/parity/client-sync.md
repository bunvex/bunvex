## Parity inventory: clients, sync protocol and reactivity

Compared against Convex `convex-backend` @ `4577b9031` and bunvex's current tree
(`packages/protocol/src/index.ts`, `packages/server/src/server.ts`, `packages/server/src/functions.ts`,
`packages/core/src/subscriptions.ts`, `packages/core/src/engine.ts`, `packages/core/src/committer.ts`;
`packages/client` and `packages/react` are empty stubs, `packages/auth` is an empty stub).

Paths are shortened: `browser/…`, `react/…`, `nextjs/…`, `react-clerk/…`, `react-auth0/…` are under
`npm-packages/convex/src/`; `crates/…` are under the repo root.

Status: **done** = behaviour an app can rely on exists · **partial** = something exists but misses part of the
semantics · **missing** = nothing yet.

bunvex speaks Convex's sync protocol v1 at `/api/{version}/sync` (`packages/server/src/sync.ts`, STUDY-23),
with `@bunvex/client` and `@bunvex/react` on top (STUDY-26); the official `convex` client also works against
it (`packages/sync-e2e`). The first, unversioned protocol (v0, `/ws`) was deleted (STUDY-23 P2). The HTTP API
is `POST /api/{query,mutation,action,query_ts,query_at_ts}`.

---

### 1. Wire protocol: transport and framing

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| WebSocket endpoint versioned by client version (`/api/{version}/sync`) | `browser/sync/client.ts`, `crates/local_backend/src/router.rs` | done (STUDY-23) | `/api/{version}/sync`; the version is not checked yet (no feature gates). |
| Deriving `ws(s)://` from the deployment `http(s)://` URL | `browser/sync/client.ts` | done (STUDY-26) | `/api/<client version>/sync`. |
| Client identifies itself (`Convex-Client: npm-<ver>` header / version in path) so the server can gate features (e.g. chunking) | `browser/http_client.ts`, `crates/local_backend/src/subs/mod.rs` (`new_sync_worker_config`) | missing | No client-version negotiation. |
| JSON text frames, one message per frame, discriminated by `type` | `browser/sync/protocol.ts` | done (STUDY-23) | v1 frames are Convex's (`@bunvex/protocol` `v1`). |
| u64 timestamps encoded as base64 little-endian strings (`EncodedTS`) | `browser/sync/protocol.ts` (`u64ToLong`/`longToU64`) | done (STUDY-23) | `encodeU64`/`decodeU64`. The ts is bunvex's commit counter (P7). |
| Function args sent as a one-element array of Convex-encoded JSON (`args: [convexToJson(args)]`) | `browser/sync/protocol.ts`, `browser/sync/client.ts` | done (STUDY-23) | `$integer`/`$float`/`$bytes` decoded by the server; args canonicalized for the execution key. |
| Canonical function path (`module:fn`, `.js` stripped, default export → `:default`) | `browser/sync/udf_path_utils.ts` | done (STUDY-23) | `canonicalizeUdfPath` on Add, Mutation and Action. |
| `componentPath` on Add/Mutation/Action (admin-only for non-root components) | `browser/sync/protocol.ts`, `crates/sync/src/worker.rs` | missing | No components. |
| Large transitions split into `TransitionChunk` (5 MB parts; `partNumber`/`totalParts`/`transitionId`) and put back together in order on the client | `crates/local_backend/src/subs/mod.rs` (`maybe_split_transition`), `browser/sync/web_socket_manager.ts` | done (STUDY-26, STUDY-23 P8) | The client reassembles chunks in order. The server splits a transition over 5 MB (5 000 000 bytes, on UTF-8 boundaries, numbered from 0, the JSON's byte length as the id) for npm clients from 1.28.0 — the client header, else the version in the sync URL — as Convex (DV-10 resolved). bunvex's own client announces the Convex client version it follows (1.46.0), so it gets them too (DV-225). |
| Server application-level `Ping` message (keeps idle sockets alive; client ignores it) | `crates/sync/src/worker.rs` (`HEARTBEAT_INTERVAL` 15 s) | done (STUDY-23) | After 15 s without a frame; one hub-wide timer checks every second. |
| WS-level ping every 5 s; client considered dead after 120 s of no pong | `crates/local_backend/src/subs/mod.rs` | partial | Bun sends pings by default; timeouts differ, and none is tuned. |
| Client inactivity watchdog: reconnect if nothing arrives from the server for 60 s | `browser/sync/web_socket_manager.ts` (`serverInactivityThreshold`) | done (STUDY-26) |  |
| Per-message size metrics / large-transition warnings (>20 MB or >20 s transit) | `browser/sync/web_socket_manager.ts` (`reportLargeTransition`) | missing | — |
| Close frames with codes (Normal / Again / Error) and a ≤123-byte reason used by the client to classify backoff | `crates/errors/src/lib.rs` (`close_frame`), `browser/sync/web_socket_manager.ts` | partial (STUDY-23) | 1011 `InternalServerError` (also for a store failure under a mutation, action or subscribed query: STUDY-20 §4.1, DV-80), 1013 with the error code (OCC, `TooManyConcurrentMutations`, `TooManyInflightActionsForSingleClient`); client errors get a `FatalError` and a plain close. |

### 2. Client → server message types

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `Connect` {sessionId, connectionCount, lastCloseReason, maxObservedTimestamp?, clientTs} as the first message on every socket | `browser/sync/protocol.ts`, `browser/sync/client.ts` (`onOpen`) | done (STUDY-23) | The session id is kept (idempotency comes with `_session_requests`, step 4). |
| `ModifyQuerySet` {baseVersion, newVersion, modifications: Add \| Remove} | `browser/sync/protocol.ts`, `browser/sync/local_state.ts` | done (STUDY-23) |  |
| `Add` {queryId, udfPath, args, journal?, componentPath?}: client-assigned numeric query id | `browser/sync/protocol.ts` | done (STUDY-23) | The journal is `{"endCursor":…}` as JSON text, opaque to the client. |
| `Remove` {queryId} | `browser/sync/protocol.ts` | done (STUDY-23) |  |
| `Mutation` {requestId, udfPath, args, componentPath?} | `browser/sync/protocol.ts` | done (STUDY-23) | Runs in the connection's queue, answers with the commit ts, and is idempotent by (sessionId, requestId). |
| `Action` {requestId, udfPath, args, componentPath?} over the WebSocket | `browser/sync/protocol.ts`, `crates/sync/src/worker.rs` | done (STUDY-23) | Concurrent, at most 1000 in flight. |
| `Authenticate` {tokenType: "User", value, baseVersion} | `browser/sync/protocol.ts`, `browser/sync/local_state.ts` | done (STUDY-27) | Verified by `@bunvex/auth`; the official client's `setAuth` works against bunvex (oracle test). |
| `Authenticate` {tokenType: "Admin", value, baseVersion, impersonating?} (dashboard / "act as user") | `browser/sync/protocol.ts` | done (STUDY-34) | The admin key checked as Convex's; `actingAs` accepted too. |
| `Authenticate` {tokenType: "None", baseVersion} (logout) | `browser/sync/protocol.ts` | done (STUDY-23) | Advances the identity version; every query re-runs. |
| `Event` {eventType, event} for client telemetry (ClientConnect marks, ClientReceivedTransition, NetworkRecoveryReconnect) | `browser/sync/protocol.ts`, `crates/sync/src/worker.rs` | done (STUDY-23) | Accepted and ignored (P11). |

### 3. Server → client message types

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `Transition` {startVersion, endVersion, modifications[], clientClockSkew?, serverTs?} | `browser/sync/protocol.ts`, `crates/sync/src/worker.rs` (`finish_update_queries`) | done (STUDY-23) | `clientClockSkew` from `Connect.clientTs`; `serverTs` null, as Convex sends it. |
| `StateVersion` {querySet, ts, identity} | `browser/sync/protocol.ts`, `crates/sync/src/state.rs` | done (STUDY-23) |  |
| `QueryUpdated` {queryId, value, logLines, journal} | `browser/sync/protocol.ts` | done (STUDY-23) | With the run's log lines and journal. |
| `QueryFailed` {queryId, errorMessage, errorData, logLines, journal} | `browser/sync/protocol.ts` | done (STUDY-23) | `errorData` only for a `BunvexError`, as Convex omits it otherwise. |
| `QueryRemoved` {queryId} (acknowledges a Remove inside the transition) | `browser/sync/protocol.ts`, `crates/sync/src/worker.rs` | done (STUDY-23) |  |
| `MutationResponse` success {requestId, result, ts, logLines} | `browser/sync/protocol.ts`, `crates/sync/src/worker.rs` | done (STUDY-23) |  |
| `MutationResponse` failure {requestId, result: message, logLines, errorData?} | `browser/sync/protocol.ts` | done (STUDY-23) | `ts` null. |
| `ActionResponse` success/failure {requestId, success, result, logLines, errorData?} | `browser/sync/protocol.ts` | done (STUDY-23) |  |
| `AuthError` {error, baseVersion, authUpdateAttempted} | `browser/sync/protocol.ts`, `crates/local_backend/src/subs/mod.rs` | done (STUDY-27) | A token that fails verification: `authUpdateAttempted: true`; an expired identity: `false`. Then close. |
| `FatalError` {error} sent before closing on a deterministic user error (BadRequest, Unauthenticated, …); the client logs it and terminates | `crates/local_backend/src/subs/mod.rs`, `browser/sync/client.ts` | done (STUDY-23) | Malformed frames and a `BaseVersionMismatch`. |
| `TransitionChunk` (see §1) | `browser/sync/protocol.ts` | done | `{ type, chunk, partNumber, totalParts, transitionId }`, as Convex's. |
| `Ping` (see §1) | `browser/sync/protocol.ts` | done (STUDY-23) |  |
| `clientClockSkew` computed from `Connect.clientTs`, used for token-expiry estimates | `crates/sync/src/worker.rs`, `browser/sync/authentication_manager.ts` | done (STUDY-27) | Sent in every Transition; the client's auth manager uses it to schedule a reused token's refetch on the server's clock. |

### 4. Consistency guarantees (the core "N" items)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| All of a client's subscribed queries advance together: one Transition carries every changed query, all evaluated at the same `ts` | `crates/sync/src/worker.rs` (`begin_update_queries` → `ExecuteQueryTimestamp::At(new_ts)`) | done (STUDY-23) | One transition per connection at `T = visibleTs`. |
| Transitions are gapless: `startVersion` must equal the client's current version, or the client throws | `browser/sync/remote_query_set.ts` | done (STUDY-23, STUDY-26) | The client throws `Invalid start version: …`, as Convex. |
| Server version never goes backwards (`advance_version` asserts it) | `crates/sync/src/state.rs` | done (STUDY-23) | `T` is `visibleTs`, monotonic. |
| Query-set versioning: server rejects a `ModifyQuerySet` whose `baseVersion` doesn't match (`BaseVersionMismatch`) | `crates/sync/src/state.rs` (`modify_query_set`) | done (STUDY-23) | `FatalError` "Base version … passed up doesn't match the current version …". |
| A query set change is answered by a Transition whose `endVersion.querySet` covers it (the client can tell when a new subscription is loaded) | `crates/sync/src/worker.rs` | done (STUDY-23) |  |
| Read-your-writes: a mutation's promise resolves only after a Transition with `endVersion.ts >= mutation ts` has been applied, so the UI already shows the write | `browser/sync/request_manager.ts` (`removeCompleted`), `browser/sync/client.ts` | done (STUDY-23, STUDY-26) | `RequestManager.removeCompleted(ts)`; checked with 20 sequential mutations, and with the official client against bunvex. |
| Server schedules a query update after every mutation/action completes so a covering Transition always follows | `crates/sync/src/worker.rs` (`schedule_update` after `mutation_futures`) | done (STUDY-23) | Even when nothing changed: an empty transition at the new ts. |
| Failed mutations resolve immediately (no side effects to wait for) | `browser/sync/request_manager.ts` | done (STUDY-26) |  |
| Mutations from one connection run serially, in the order they were sent | `crates/sync/src/worker.rs` (`mutation_futures … buffered(1)`) | done (STUDY-22) | A per-connection queue. A 1001st pending mutation closes the connection with 1013 `TooManyConcurrentMutations` (`OPERATION_QUEUE_BUFFER_SIZE`). Queued mutations of a closed connection never start. |
| Actions run concurrently and are decoupled from the transition ordering | `crates/sync/src/worker.rs` (`action_futures: FuturesUnordered`) | done (STUDY-23) |  |
| Result dedupe: re-executed query with an identical result (hash of value + log lines) produces no modification | `crates/sync/src/state.rs` (`complete_fetch`, `hash_result`) | done (STUDY-23) | v1 hashes the result and its log lines, as Convex. |
| Subscription invalidation by read set vs committed writes | `crates/database` subscriptions, `crates/sync/src/state.rs` (`next_invalidated_query`) | done | The sync hub matches each commit's writes through `ReadSetIndex`, an interval index per index as Convex's `IntervalMap` (STUDY-08 §3.4), and re-runs the executions it hits. |
| Splaying: a commit that invalidates more than `SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD` (200) subscriptions notifies each after a uniform random delay in `[0, count × SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER (5 ms)]` | `crates/database/src/subscription.rs` (`advance_log`, `drop_with_delay`), `crates/common/src/knobs.rs` | done (STUDY-08 §3.5) | `SyncHub.onCommit` counts invalidated session queries; each session wakes at the earliest of its queries' delays, and any other trigger (its own mutation, a query set change) still runs at once. Same knob names in the environment, or `subscriptionSplay` in `createServer`. Owner, 2026-10-01: approved as Convex; may revisit (a cap would be a divergence). |
| Cheap "refresh": an unchanged subscription just extends its validity to the new ts instead of rerunning | `crates/sync/src/worker.rs` (`extend_validity`) | done (STUDY-23) | `Committer.changedBetween(reads, from, to)` over the write log; a result valid at one ts is reused at a later one. |
| Linearizability across backends: `Connect.maxObservedTimestamp` > server's latest ts → error (client saw a future the server doesn't know) | `crates/sync/src/worker.rs` (`Connect` handler) | done (STUDY-23) | The connection closes with 1011, as Convex's internal error. |
| Client tracks `maxObservedTimestamp` from Transitions and MutationResponses | `browser/sync/client.ts` (`observedTimestamp`) | done (STUDY-26) | `getMaxObservedTimestamp()` is a bigint (C5). |
| Backpressure / single-flight: at most N (=2) unsent Transitions queued per client; later updates coalesce into the next one | `crates/sync/src/worker.rs` (`SingleFlightSender`, `SYNC_MAX_SEND_TRANSITION_COUNT`) | partial (STUDY-23) | One transition computed at a time per connection, later triggers coalesced; no cap on unsent frames yet. |
| Query reruns in parallel with bounded concurrency (20) and retry with backoff on retriable errors | `crates/sync/src/worker.rs` (`UPDATE_QUERY_CONCURRENCY`, `SYNC_WORKER_QUERY_RETRY_*`) | partial | Reruns run in parallel, unbounded, with no retry. |
| Temporarily-unavailable features (search index bootstrapping) → skip, then retry later | `crates/sync/src/worker.rs` | missing | Not applicable until search exists. |
| Shared execution across clients for identical queries | `crates/application` query cache | done (STUDY-23) | v1: one execution per (path, args, journal, identity) and ts, single-flight; frames assembled per connection (P3). About 100 deliveries/ms (`packages/server/bench/sync-fanout.ts`), about 1.4× the deleted v0 per delivery, mostly in the per-socket send. |

### 5. Mutation idempotency, request ids and resend

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Session id (UUID v4) generated once per client and sent in `Connect` | `browser/sync/session.ts`, `browser/sync/client.ts` | done (STUDY-26) |  |
| Monotonic per-client `requestId` shared by mutations and actions | `browser/sync/client.ts` | done (STUDY-26) |  |
| Mutations idempotent by (sessionId, requestId): a resent mutation that already committed returns the stored result + original ts instead of running again | `crates/application/src/application_function_runner/mod.rs` (`check_mutation_status` / `write_mutation_status`), `crates/model/src/session_requests` | done (STUDY-23) | A replay answers the recorded result and log lines. Its ts is the snapshot that saw the record, ≥ the original (P13, open). |
| Session request records are written in the same transaction as the mutation and garbage-collected after a retention window (default 2 weeks) | `crates/application/src/system_table_cleanup/mod.rs`, `crates/common/src/knobs.rs` (`MAX_SESSION_CLEANUP_DURATION`) | done (STUDY-23) | Same transaction as the writes; cleanup by `_creationTime`, 64 per transaction, ≤ 256/s, `MAX_SESSION_CLEANUP_DURATION_HOURS`. |
| Per-socket cap on pending mutations/actions (1000) → `TooManyConcurrentMutations` / `TooManyInflightActionsForSingleClient` | `crates/sync/src/worker.rs` | done (STUDY-23) | Mutations and actions. |
| 60 s timeout per WS mutation | `crates/sync/src/worker.rs` (`SYNC_WORKER_PROCESS_TIMEOUT`) | missing | — |
| Server request id derived from session + request id (tracing / logs correlation) | `crates/sync/src/worker.rs` (`RequestId::new_for_ws_session`) | missing | — |

### 6. Reconnect, backoff and connection state (client)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Socket state machine: disconnected / connecting / ready / stopped / terminated, with a paused sub-state | `browser/sync/web_socket_manager.ts` | done (STUDY-26) |  |
| On reopen: send Connect, drop the remote query set, re-send the full query set as `ModifyQuerySet` base 0 → 1, re-send auth, re-send all in-flight mutations (including completed-but-unreflected ones) | `browser/sync/client.ts` (`onOpen`), `browser/sync/local_state.ts` (`restart`), `browser/sync/request_manager.ts` (`restart`) | done (STUDY-26) |  |
| In-flight actions fail on reconnect ("Connection lost while action was in flight"), never resent | `browser/sync/request_manager.ts` | done (STUDY-26) |  |
| Messages sent while disconnected are queued (`NotSent`) and flushed on open/resume | `browser/sync/request_manager.ts`, `browser/sync/web_socket_manager.ts` | done (STUDY-26) |  |
| Exponential backoff with jitter: 100 ms initial for client-side causes, 1 s for unknown server close, 1–3 s for classified server errors (Overloaded, TooManyConcurrentRequests, CommitterFullError, …), capped at 16 s | `browser/sync/web_socket_manager.ts` (`nextBackoff`, `serverDisconnectErrors`) | done (STUDY-26) |  |
| Backoff resets only once the client has "synced past the last reconnect" (all re-sent queries answered, auth confirmed, old requests done) | `browser/sync/client.ts` (`hasSyncedPastLastReconnect`), `browser/sync/local_state.ts` | done (STUDY-26) |  |
| Close codes 1000/1001/1005/4040 treated as normal (4040 = not-found during a push, retried) | `browser/sync/web_socket_manager.ts` | done (STUDY-26) |  |
| Browser `online` event → reconnect immediately, cancelling a pending backoff | `browser/sync/web_socket_manager.ts` (`tryReconnectImmediately`) | done (STUDY-26) |  |
| Server-side reconnect rate limiter weighted by query-set size (avoid thundering herd after an outage) | `crates/sync/src/subscription_reconnect.rs` | missing | Useful once there are many clients. |
| `ConnectionState` {isWebSocketConnected, hasEverConnected, connectionCount, connectionRetries, hasInflightRequests, timeOfOldestInflightRequest, inflightMutations, inflightActions} | `browser/sync/client.ts` | done (STUDY-26) |  |
| `subscribeToConnectionState(cb)` (published once per microtask, only on change) | `browser/sync/client.ts` | done (STUDY-26) |  |
| `onServerDisconnectError` callback for abnormal close reasons | `browser/sync/client.ts` | done (STUDY-26) |  |
| "Unsaved changes" `beforeunload` prompt while mutations are in flight (default on in browsers) | `browser/sync/client.ts` | done (STUDY-26) |  |
| `close()`: terminate the socket, stop auth refresh, never reconnect | `browser/sync/client.ts` | done (STUDY-26) |  |
| Server cleans up a connection's subscriptions on close | `crates/sync/src/worker.rs` | done (#11) | Fixed as B14: a duplicate subscription from one socket no longer leaks a reference count. |

### 7. Auth (client and sync side)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `setAuth(fetchToken, onChange, onRefreshChange?)` with `fetchToken({forceRefreshToken})` → JWT \| null | `browser/sync/client.ts`, `browser/sync/authentication_manager.ts` | done (STUDY-27) | `BaseBunvexClient.setAuth`; `BunvexClient.setAuth(fetchToken, onChange?)` and `getAuth()`. Tested differentially: each scenario runs with the official client and with `BunvexClient` (`sync-e2e/test/client-auth.test.ts`). |
| Pause the socket while fetching the first token, then resume (queries don't run unauthenticated first) | `browser/sync/authentication_manager.ts` (`setConfig`), `browser/sync/local_state.ts` (`pause`/`resume`) | done (STUDY-27) | |
| Auth state machine: cached token → server confirmation → fresh token refetch → scheduled refetch before `exp` (leeway 10 s, max delay 20 days) | `browser/sync/authentication_manager.ts` | done (STUDY-27) | Including Convex's second `onChange(true)` after each confirmed fresh token (STUDY-27 §1.6). |
| Server confirms auth by a Transition whose `identity` version advanced | `browser/sync/authentication_manager.ts` (`onTransition`) | done (STUDY-27) | |
| On `AuthError`: stop socket, force-refresh token, reconnect; after 2 failed confirmations clear auth and report unauthenticated | `browser/sync/authentication_manager.ts` (`tryToReauthenticate`) | done (STUDY-27) | Logs `Failed to authenticate: "<error>", check your server auth config`, as Convex. |
| Ignore stale AuthErrors for older identity versions, and function-level token-expired errors while confirming | `browser/sync/authentication_manager.ts` | done (STUDY-27) | |
| Guard against races between concurrent `setAuth` calls (config version) | `browser/sync/authentication_manager.ts` | done (STUDY-27) | |
| Options `expectAuth` (hold all requests until the first token), `initialAuthTokenReuse`, `authRefreshTokenLeewaySeconds` | `browser/sync/client.ts` | done (STUDY-27) | |
| `clearAuth()` sends `Authenticate{None}`; `getCurrentAuthClaims()` decodes the JWT locally; `hasAuth()` | `browser/sync/client.ts` | done (STUDY-27) | |
| Server: identity version per session; `Authenticate` with the wrong baseVersion is rejected | `crates/sync/src/state.rs` (`modify_identity`) | done (STUDY-23) | |
| Server: identity change invalidates and reruns all subscriptions of that session | `crates/sync/src/worker.rs` (`identity_changed`) | done (STUDY-27) | Shared executions are keyed by identity only when the run read it (B13, DV-12). |
| Server: token expiry checked on every operation; soon-to-expire admin tokens revalidated; expired user token → `AuthError{authUpdateAttempted:false}` | `crates/sync/src/state.rs` (`identity`), `crates/sync/src/worker.rs` (`revalidate_identity`) | done (STUDY-27, STUDY-34) | User tokens: checked before every transition, mutation and action. Admin identities do not expire (DV-163). |
| Admin auth + impersonation (`setAdminAuth(token, fakeUserIdentity)`) | `browser/sync/client.ts`, `react/client.ts` | done (STUDY-26) | `setAdminAuth(key, identity)` on the base client (`Authenticate` Admin with `impersonating`) and on the HTTP client (`Authorization: Bunvex <key>:<base64 identity>`). |

### 8. Optimistic updates

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `mutation(name, args, {optimisticUpdate})`: a synchronous `(localStore, args) => void` applied right away | `browser/sync/client.ts` (`enqueueMutation`), `browser/sync/optimistic_updates.ts` | done (STUDY-26) |  |
| `OptimisticLocalStore.getQuery / getAllQueries / setQuery` (setting `undefined` = show loading) | `browser/sync/optimistic_updates.ts`, `browser/sync/optimistic_updates_impl.ts` | done (STUDY-26) |  |
| Every server transition: rebuild results from server data, then replay all still-pending optimistic updates in order | `browser/sync/optimistic_updates_impl.ts` (`ingestQueryResultsFromServer`) | done (STUDY-26) |  |
| Optimistic update dropped exactly when its mutation is reflected (ts reached) or failed, so there is no flicker | `browser/sync/client.ts` (`notifyOnQueryResultChanges`), `browser/sync/request_manager.ts` | done (STUDY-26) |  |
| Warning when an optimistic update returns a Promise | `browser/sync/client.ts` | done (STUDY-26) |  |
| `localQueryResult(name, args)` also returns optimistic-only values | `browser/sync/client.ts` | done (STUDY-26) |  |
| React: `useMutation(f).withOptimisticUpdate(fn)` (only one per mutation; the function is stable across renders) | `react/client.ts` (`createMutation`) | done (STUDY-26) | `ReactMutation.withOptimisticUpdate`, one per mutation, stable across renders. |
| Paginated helpers: `optimisticallyUpdateValueInPaginatedQuery`, `insertAtTop`, `insertAtBottomIfLoaded`, `insertAtPosition` | `react/use_paginated_query.ts` | done (STUDY-26) |  |

### 9. Pagination on the client (and its server contract)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Query journals: opaque per-query state (the page end cursor) returned in `QueryUpdated/QueryFailed.journal`, stored by the client, re-sent in `Add.journal` on reconnect so pages keep the same boundaries | `browser/sync/protocol.ts`, `browser/sync/local_state.ts`, `crates/sync/src/state.rs` (`complete_fetch` saves journal) | done (STUDY-17, STUDY-23, STUDY-26) | The server pins page ends (#42), sends journals (v1), and the client stores and re-sends them. |
| `paginate({numItems, cursor, endCursor?, maximumRowsRead?, maximumBytesRead?})` → `{page, isDone, continueCursor, splitCursor?, pageStatus?}` | `browser/sync/pagination.ts` (`asPaginationResult`), server `paginationOptsValidator` | done (STUDY-17, STUDY-26) | The shape and `asPaginationResult` in `@bunvex/client`. |
| Gapless reactive pagination: each loaded page is its own subscription, pinned by `endCursor`; pages grow or shrink but never leave gaps | `browser/sync/paginated_query_client.ts`, `react/use_paginated_query.ts` | done (STUDY-26) | `usePaginatedQuery`: one subscription per page, ends pinned by the journal. |
| Page splitting when a page becomes too large (`SplitRecommended` / `SplitRequired` + `splitCursor`): subscribe to two halves, swap once both are loaded | `browser/sync/paginated_query_client.ts` (`splitPaginatedQueryPage`, `completePaginatedQuerySplit`) | done (STUDY-26) | Needed a server fix: a pinned page stopped by a read limit continues at its end (STUDY-26 §8.2). |
| `InvalidCursor` error (or `paginationError` in ConvexError data) → reset to the first page | `react/use_paginated_query.ts` | done (STUDY-26) | By its data (`isBunvexSystemError`, P1) or its message; the server sends the data since STUDY-26 P1. |
| Per-hook pagination `id` in the args as a cache-buster (independent journals per hook instance) | `react/use_paginated_query.ts` (`nextPaginationId`), `browser/sync/udf_path_utils.ts` (`serializePaginatedPathAndArgs`) | done (STUDY-26) |  |
| `usePaginatedQuery(query, args \| "skip", {initialNumItems})` → `{results, status: LoadingFirstPage \| CanLoadMore \| LoadingMore \| Exhausted, isLoading, loadMore(n)}` | `react/use_paginated_query.ts` | done (STUDY-26) |  |
| `usePaginatedQuery_experimental` (object options form) | `react/use_paginated_query2.ts` | done (STUDY-26 §8.4) | Both forms, over the paginated query client. A failed page reaches the hook (DV-250, pending). |
| Non-React paginated subscriptions: `ConvexClient.onPaginatedUpdate_experimental`, `ConvexReactClient.watchPaginatedQuery` | `browser/simple_client.ts`, `react/client.ts` | done (STUDY-26 §8.4) | One `PaginatedQueryClient` under both, as Convex. Checked step by step against the official client. A failed page reaches `onError` (DV-250, pending). |

### 10. Base client API (`BaseConvexClient`, `ConvexClient`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `subscribe(name, args, {journal?})` → `{queryToken, unsubscribe}`; ref-counted per (path, args) on the client, so N subscribers share one server query | `browser/sync/client.ts`, `browser/sync/local_state.ts` | done (STUDY-26) |  |
| Query token = canonical JSON of {udfPath, args} | `browser/sync/udf_path_utils.ts` | done (STUDY-26) |  |
| `addOnTransitionHandler(fn)` with `{queries[{token, modification}], reflectedMutations, timestamp}` | `browser/sync/client.ts` | done (STUDY-26) |  |
| `localQueryResult / localQueryResultByToken / hasLocalQueryResultByToken / localQueryLogs / queryJournal` | `browser/sync/client.ts` | done (STUDY-26) |  |
| `mutation(name, args, opts)` / `action(name, args)` returning values, throwing `ConvexError` with `.data` when `errorData` is present, otherwise `Error` with a "[CONVEX M(name)] … Called by client" message | `browser/sync/client.ts`, `browser/logging.ts` | done (STUDY-26) | As `BaseBunvexClient` / `BunvexClient` (C1); errors are `BunvexError` with `.data`, `[BUNVEX M(path)] …` (C2). |
| `ConvexClient` (framework-free): `onUpdate(query, args, cb, onError)` returning a callable Unsubscribe with `getCurrentValue()` / `getQueryLogs()`; one-shot `query()` via subscribe-then-unsubscribe; `mutation`; `action`; `close`; `disabled` option for SSR | `browser/simple_client.ts` | done (STUDY-26) |  |
| Callbacks for one transition run together after it is applied (no partially applied state visible) | `browser/simple_client.ts`, `react/client.ts` (`transition`) | done (STUDY-26) |  |
| `webSocketConstructor` injection; `setDefaultWebSocketConstructor` (Node entry uses `ws`) | `browser/sync/client.ts`, `browser/simple_client-node.ts` | partial (STUDY-26) | The option exists; Bun and browsers have a global WebSocket, so no `setDefaultWebSocketConstructor` yet. |

### 11. React bindings

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `ConvexReactClient(url, options)`: lazily creates the base + paginated client; `watchQuery`, `query`, `mutation`, `action`, `prewarmQuery({extendSubscriptionFor})`, `connectionState`, `close`, `setAuth`, `clearAuth`, `url`, `logger` | `react/client.ts` | done (STUDY-26) | `BunvexReactClient` (R1); the paginated client since STUDY-26 §8.4; `setAuth` since STUDY-27; `baseClient` injection included. |
| `ConvexProvider` / `useConvex()` context | `react/client.ts` | done (STUDY-26) | `BunvexProvider` / `useBunvex()` (R1). |
| `useQuery(query, args \| "skip")` → value \| undefined while loading; throws query errors to the error boundary; args memoised by their JSON | `react/client.ts` | done (STUDY-26) |  |
| `useQuery_experimental({query, args, throwOnError})` → `{status: pending \| success \| error}` | `react/client.ts` | done (STUDY-26) |  |
| `useQueries(record)`: many queries in one hook, errors returned as `Error` values | `react/use_queries.ts`, `react/queries_observer.ts` | done (STUDY-26) |  |
| Concurrent-mode-safe subscription hook (no tearing between render and subscribe) | `react/use_subscription.ts` | done (STUDY-26) | On `useSyncExternalStore`, with a re-read after subscribing (R2). |
| `useMutation(ref)`: stable function + `.withOptimisticUpdate` | `react/client.ts` | done (STUDY-26) |  |
| `useAction(ref)` | `react/client.ts` | done (STUDY-26) |  |
| `useConvexConnectionState()` | `react/client.ts` | done (STUDY-26) | `useBunvexConnectionState()` (R1). |
| Accepting a function reference or a plain string name (`makeFunctionReference`) | `react/client.ts` | done (STUDY-26) | `anyApi` / `makeFunctionReference`, untyped until the typed API (ARCH open decision 1). |
| `convexQueryOptions({ query, args })`: an identity function typing a query and its args, for `prewarmQuery` and the object form of `useQuery` (`@internal`) | `browser/query_options.ts` | missing | Not the TanStack integration (next row). Low priority. |
| TanStack Query: `ConvexQueryClient` (live cache entries, server-side reads at one snapshot), `convexQuery` / `convexAction`, the hooks re-exported | `@convex-dev/react-query` (separate package) | done (STUDY-48) | `@bunvex/react-query` (DV-260, DV-261); args JSON-encoded in keys (DV-262); paginated queries to come (DV-263). Checked against the official package on the same server. |
| Guard: helpful errors when used outside a provider / when called with an event object by mistake (`assertNotAccidentalArgument`) | `react/client.ts` | done (STUDY-26) | Same messages, naming bunvex and `BunvexProvider`, without the docs link. |

### 12. React auth helpers and providers

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `ConvexProviderWithAuth({client, useAuth})` where `useAuth()` → `{isLoading, isAuthenticated, fetchAccessToken}` | `react/ConvexAuthState.tsx` | done (STUDY-27) | `BunvexProviderWithAuth`. Tested differentially against `convex/react` (`sync-e2e/react/auth.test.tsx`). |
| Effect ordering: `setAuth` in a first child (before children subscribe), `clearAuth` in a last child (after children unsubscribe) | `react/ConvexAuthState.tsx` | done (STUDY-27) | Tested: a query never runs signed out, on mount or on sign-out. |
| `useConvexAuth()` → `{isLoading, isAuthenticated, isRefreshing}` (backend-confirmed, not only IdP state) | `react/ConvexAuthState.tsx` | done (STUDY-27) | `useBunvexAuth()`. |
| `<Authenticated>`, `<Unauthenticated>`, `<AuthLoading>`, `<AuthRefreshing>` | `react/auth_helpers.tsx` | done (STUDY-27) | |
| `ConvexProviderWithClerk` (getToken with template "convex" or `aud === "convex"`, skipCache on force refresh) | `react-clerk/ConvexProviderWithClerk.tsx` | done (STUDY-47) | `BunvexProviderWithClerk` in `@bunvex/react-clerk` (DV-243); template and audience "bunvex" (DV-242). Differential test against Convex's provider. |
| `ConvexProviderWithAuth0` (id_token via getAccessTokenSilently, cacheMode off on force refresh) | `react-auth0/ConvexProviderWithAuth0.tsx` | done (STUDY-47) | `BunvexProviderWithAuth0` in `@bunvex/react-auth0` (DV-243). Differential test against Convex's provider. |

### 13. HTTP client and HTTP API

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `POST /api/query`, `/api/mutation`, `/api/action` with body `{path, args, format}` | `browser/http_client.ts`, `crates/local_backend/src/public_api.rs` | partial | bunvex accepts `{path, args}` with the JSON value encoding (`$integer`, `$bytes`, …); ignores `format`. |
| Response `{status: "success", value, logLines}` \| `{status: "error", errorMessage, errorData?, logLines}`; the client accepts HTTP 200 or 560 for a function error (anything else throws the text) | `browser/http_client.ts`, `crates/local_backend/src/public_api.rs` | done (STUDY-26) | `BunvexHttpClient`; the official `ConvexHttpClient` works against bunvex too. |
| `GET /api/query?path=&args=&format=` | `crates/local_backend/src/public_api.rs` | missing | — |
| `POST /api/function` (any kind, by name) and `/api/run/{path}` | `crates/local_backend/src/public_api.rs`, `browser/http_client.ts` (`function`) | missing | With components (STUDY-26 H3). |
| `consistentQuery`: `GET /api/query_ts` once, then `POST /api/query_at_ts {ts}` so many queries share one snapshot | `browser/http_client.ts`, `crates/local_backend/src/public_api.rs` | done (STUDY-26) | Server `POST /api/query_ts` and `/api/query_at_ts` added (base64 u64 ts); a future ts is a 400 `InvalidTimestamp`. |
| `Authorization: Bearer <jwt>` (user) / `Convex <admin key>` (admin) | `browser/http_client.ts` | done (STUDY-26, STUDY-34) | Sent as `Bearer <jwt>` / `Bunvex <admin key>` (H2); the server verifies both. |
| `setAuth(token)`, `setAdminAuth(token, actingAs)`, `clearAuth()`, constructor `{auth, fetch, logger, skipConvexDeploymentUrlCheck}` | `browser/http_client.ts` | done (STUDY-26) | Option `skipDeploymentUrlCheck` (C1). |
| Mutation queue: HTTP mutations from one client run one at a time in call order unless `{skipQueue: true}` | `browser/http_client.ts` (`enqueueMutation`, `processMutationQueue`) | done (STUDY-26) |  |
| `setDebug` (print server log lines), `setFetchOptions({cache})`, custom `fetch` / global `setFetch` | `browser/http_client.ts` | done (STUDY-26) |  |
| `url` getter / deprecated `backendUrl()` | `browser/http_client.ts` | done (STUDY-26) |  |

### 14. Next.js / SSR

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `fetchQuery / fetchMutation / fetchAction(ref, args, {token?, url?, adminToken?, skipConvexDeploymentUrlCheck?})` over the HTTP client with `cache: "no-store"` | `nextjs/index.ts` | done (STUDY-46) | `@bunvex/nextjs` (DV-241); option `skipDeploymentUrlCheck` (DV-03). |
| `preloadQuery` → `Preloaded` {_name, _argsJSON, _valueJSON}; `preloadedQueryResult` | `nextjs/index.ts` | done (STUDY-46) | The payload is checked equal to `convex/nextjs`'s on the same server. |
| `usePreloadedQuery(preloaded)`: renders the server value first, then switches to the live subscription | `react/hydration.tsx` | done (STUDY-46) | In `@bunvex/react`. |
| Default URL from `NEXT_PUBLIC_CONVEX_URL`, with warnings for an explicitly undefined URL | `nextjs/index.ts` | done (STUDY-46) | `NEXT_PUBLIC_BUNVEX_URL` (DV-240). |

### 15. Logging and errors surfaced to the client

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Server `console.log` lines returned with every query/mutation/action result and printed in the browser as `[CONVEX Q(name)] [LEVEL] …` | `browser/logging.ts`, `browser/sync/remote_query_set.ts`, `browser/sync/request_manager.ts` | done (STUDY-26) | Printed as `[BUNVEX Q(name)] [LEVEL] …` (C2). |
| `Logger` interface {log, warn, error, logVerbose}; `logger: false` silences; `verbose` option | `browser/logging.ts`, `browser/sync/client.ts` | done (STUDY-26) |  |
| `ConvexError` data passed to the client as `errorData` and re-thrown with `.data` | `browser/logging.ts` (`forwardData`), `browser/sync/remote_query_set.ts` | done (STUDY-26) | As `BunvexError.data`. |
| `[CONVEX FATAL ERROR]` on `FatalError` | `browser/logging.ts` | done (STUDY-26) | As `[BUNVEX FATAL ERROR]`; the client terminates. |
| Optional debug telemetry (`reportDebugInfoToConvex`: marks, long-disconnect event to `/api/debug_event`) | `browser/sync/client.ts`, `browser/sync/metrics.ts` | missing | Omitted by design until there is an endpoint (STUDY-26 C4). |
| Error message redaction for non-dev deployments (`RedactedJsError`, `RedactedLogLines`) | `crates/sync/src/worker.rs` | done (STUDY-20) | `REDACT_LOGS_TO_CLIENT` / `redactLogsToClient`, on HTTP and WebSocket. |

### 16. Limits and sizes relevant to clients

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Max function args 16 MiB (30 MB JSON at the edge) | `crates/common/src/knobs.rs` (`FUNCTION_MAX_ARGS_SIZE`, `USHER_MAX_JSON_ARGS_SIZE`) | partial | Implicitly limited by `maxPayloadLength` 8 MiB on WS; unlimited on HTTP. |
| Max function result 16 MiB | `crates/common/src/knobs.rs` (`FUNCTION_MAX_RESULT_SIZE`) | missing | — |
| Per-transaction read limits (32 000 rows, 16 MiB, 4096 read-set intervals) that drive the pagination `maximumRowsRead/BytesRead` split logic | `crates/common/src/knobs.rs` | missing | Engine area; listed because the client reacts to it. |
| Pending ops per socket (1000); WS mutation timeout (60 s) | `crates/sync/src/worker.rs` | missing | See §5. |
| Arg-size metrics per ModifyQuerySet/Mutation/Action | `crates/sync/src/worker.rs` | missing | Observability only. |

### 17. Client configuration (independent of the CLI)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Deployment URL as the only required input; validation (absolute http(s) URL; `skipConvexDeploymentUrlCheck` for self-hosted) | `common/index.ts` (`validateDeploymentUrl`), `browser/sync/client.ts` | done (STUDY-26) | Option `skipDeploymentUrlCheck` (C1). |
| Env-var conventions used by templates (`NEXT_PUBLIC_CONVEX_URL`, `VITE_CONVEX_URL`, …) | `nextjs/index.ts`, templates | done (STUDY-40) | `bunvex dev` writes `BUNVEX_URL` under the framework's prefix (`VITE_`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_`, `REACT_APP_`, `PUBLIC_`), rule 5's names for Convex's. |
| Options: `unsavedChangesWarning`, `webSocketConstructor`, `verbose`, `logger`, `reportDebugInfoToConvex`, `onServerDisconnectError`, `skipConvexDeploymentUrlCheck`, `authRefreshTokenLeewaySeconds`, `expectAuth`, `initialAuthTokenReuse` | `browser/sync/client.ts` (`BaseConvexClientOptions`) | partial (STUDY-26) | All but `reportDebugInfoToConvex` (C4); the auth options since STUDY-27. |
| `ConvexClient` option `disabled` (SSR no-op); `ConvexReactClient` option `baseClient` (inject a custom or mock sync client) | `browser/simple_client.ts`, `react/client.ts` | done (STUDY-26) | `disabled` and `baseClient` (`BunvexReactClientOptions`). |
| Package entry points `convex/browser`, `convex/react`, `convex/nextjs`, `convex/react-clerk`, `convex/react-auth0` | `npm-packages/convex/package.json` | partial | `bunvex/server`, `bunvex/values`, `bunvex/browser` and `bunvex/react` are wired (re-exports, `react` an optional peer); `nextjs`, `react-clerk` and `react-auth0` follow their packages. |
