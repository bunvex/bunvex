# STUDY-22 — Mutation order on one WebSocket connection

- **Status:** implemented; D1 decided by the owner (2026-10-01): match Convex, with protocol v1
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - [STUDY-08](STUDY-08-cache-and-subscriptions.md): the sync protocol.
  - [STUDY-21](STUDY-21-occ-error-and-retries.md): an OCC error on the socket.
  - The protocol v1 study, which covers ordering with idempotency and reconnects.

## 1. How Convex does it

`crates/sync/src/worker.rs`, `SyncWorker`:

- `SyncWorker::new` creates `mpsc::channel(OPERATION_QUEUE_BUFFER_SIZE)` (1000) and wraps the receiver
  as `ReceiverStream::new(receiver).buffered(1)`, commented "Execute at most one operation at a time".
- `handle_message` for `ClientMessage::Mutation` builds the execution as a future and `try_send`s it
  into that channel, in the order the messages arrive. `buffered(1)` polls one future at a time, in
  channel order.
  - So a connection's mutations **start and finish one after another, in the order they were sent**.
  - Their `MutationResponse`s go out in the same order.
- A full channel fails `try_send`. The error is `ErrorMetadata::rate_limited("TooManyConcurrentMutations",
  "Too many concurrent mutations. Only up to 1000 pending mutations allowed on a single websocket.")`,
  which ends the worker. `close_frame` (`crates/errors/src/lib.rs`) maps `RateLimited` to
  `CloseCode::Again` (1013), with the short message as the reason
  (`crates/local_backend/src/subs/mod.rs`).
- When the worker ends, queued futures are dropped with it: a mutation that had not started never runs.
  The client re-sends unanswered mutations after reconnecting
  (`npm-packages/convex/src/browser/sync/request_manager.ts`, `restart`).
- **Actions** go to `action_futures: FuturesUnordered` instead. They run concurrently, limited to the
  same 1000, and are not ordered.
- Different connections have separate workers, so there is no ordering between them.

The client does not serialise. `ConvexHttpClient` has its own queue (`processMutationQueue`), but the
WebSocket client sends each mutation at once and relies on the server's order.

## 2. What an app can observe

1. Two mutations sent on one connection, A then B, never overlap. A's effects are visible to B, and A's
   response arrives first. This is what makes a sequence of `useMutation` calls from one tab behave
   sequentially.
2. A slow mutation holds back the connection's later mutations, but not other connections'.
3. More than 1000 pending mutations on one connection end it with close code 1013.

## 3. How bunvex does it

`packages/server/src/server.ts`:

- Each connection's `WsData` holds `mutations`, the tail of a promise chain, and `pendingMutations`.
- A `mut` frame is appended to the chain **synchronously in the message handler**, before any `await`.
  Queue order is therefore the order Bun delivers frames, which is the order they were sent. The chain
  runs them one at a time.
- `MAX_PENDING_MUTATIONS = 1000`. The next one closes the socket with 1013 and the reason
  `TooManyConcurrentMutations`.
- On close, the connection is marked closed. Queued mutations that have not started are skipped, and a
  running one finishes without sending a response.
- Subscriptions are unaffected: `sub`/`unsub` are still handled as they arrive.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | The overflow closes the socket without first sending a message. Convex sends none either for a rate-limit error, but its client recognises the close reason; bunvex has no client yet | Nothing to do until `@bunvex/client` exists | Decided (owner, 2026-10-01): match Convex (gap, to be built), with protocol v1 (DV-83) |

No other divergence: bunvex has no WebSocket actions yet. When they come, they must run concurrently,
outside this queue, as in Convex.

## 5. Tests

`packages/server/test/ws-order.test.ts`:

- three mutations on one connection start and end strictly in order, and their responses arrive in
  order, while the first is held open;
- a second connection's mutation completes while the first connection's is blocked;
- a failing mutation (unknown function) does not stall the queue;
- the 1001st pending mutation closes the socket with 1013 `TooManyConcurrentMutations`, and the queued
  ones never start.

Sabotage:

| Broken | Result |
|---|---|
| Mutations run concurrently (no chain) | 2 tests fail |
| No closed check | 1 fails |
| No cap | 1 fails |

## 6. Open questions

1. D1.
