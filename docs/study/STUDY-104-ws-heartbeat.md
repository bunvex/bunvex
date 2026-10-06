# STUDY-104 — The sync socket's WS heartbeat and close frames

- **Status:** implemented (owner decisions of 2026-10-05: DV-352, DV-353, DV-354)
- **Convex source read:** commit `4577b9031cbe32ddffbf8b6a61a07fe4a5dd6922` of get-convex/convex-backend
- **Related:** STUDY-23 §4.5 (close codes, the application `Ping`), STUDY-26 (the client's close handling),
  STUDY-64 §6 (the open question on `CLIENT_TIMEOUT`), DV-311

## 1. How Convex does it

### 1.1 The heartbeat

`run_sync_socket` (`crates/local_backend/src/subs/mod.rs`) runs three loops on one socket: a receive loop, a
send loop and the sync worker. The heartbeat lives in the first two.

- Constants (`:94-97`): `HEARTBEAT_INTERVAL` = 5 s, `CLIENT_TIMEOUT` = 120 s. Neither is a knob.
- The receive loop (`:152-202`) sets `last_received` to now on **every** frame that arrives (`:162`), before it
  looks at the frame's kind: a `Text` message, a `Pong`, a `Ping` (whose pong tungstenite sends by itself,
  `:189-193`). A `Pong` also logs the round trip since the last ping (`log_websocket_pong`, `:185-188`).
- The send loop (`:205-242`) has a `tokio::time::interval(HEARTBEAT_INTERVAL)` ticker (`:206`). On each tick
  (`:209-221`):
  - if `now - last_received > CLIENT_TIMEOUT`, it logs `log_websocket_client_timeout` and fails with
    `ErrorMetadata::client_disconnect()` with the context "Websocket ping/pong timeout" (`:212-215`);
  - otherwise it records the ping time, logs `log_websocket_ping` and sends a WS `Ping` with an empty payload
    (`:216-220`).
  A tokio interval's first tick is immediate, so the first ping goes out as the socket opens; the timeout
  is checked only on ticks, so a silent client is closed between 120 and 125 s after its last frame.
- `client_disconnect()` (`crates/errors/src/lib.rs:215`) is `ErrorCode::ClientDisconnect` with the short
  message `ClientDisconnected` (`:1110`) and the message "Client disconnected" (`:1109`).

There is also an application-level `Ping` *message* from the sync worker after 15 s without a frame
(`crates/sync/src/worker.rs` `HEARTBEAT_INTERVAL`); bunvex has it already (STUDY-23). The two are independent.

### 1.2 How a failed socket closes

After the three loops end (`subs/mod.rs:263-338`):

- With an error that carries `ErrorMetadata` (`:275-301`): an `AuthError` for `AuthUpdateFailed` and
  `Unauthenticated`; else a `FatalError` with the error's display (its message) when
  `is_deterministic_user_error()` (`crates/errors/src/lib.rs:513-533`: `BadRequest`, `Conflict`,
  `PaginationLimit`, `Unauthenticated`, `AuthUpdateFailed`, `Forbidden`). Not for `NotFound`,
  `ClientDisconnect`, rate limits, OCC or internal errors. The send is best effort.
- Then `Message::Close(err.close_frame())` (`:320-325`). `ErrorMetadata::close_frame` (`lib.rs:676-708`):
  - `NotFound`, `PaginationLimit`, `Forbidden`, `ClientDisconnect` → `CloseCode::Normal` (1000);
  - `OCC`, `OutOfRetention`, `Overloaded`, `FeatureTemporarilyUnavailable`, `RateLimited`,
    `RejectedBeforeExecution`, `MisdirectedRequest`, `TooEarly` → `CloseCode::Again` (1013);
  - `OperationalInternalServerError` → `CloseCode::Error` (1011);
  - `BadRequest`, `Unauthenticated`, `AuthUpdateFailed`, `Conflict` → no frame (`None`): "the client will
    handle and close the connection instead".
  The reason is the error's short message, truncated to 123 bytes (RFC 6455: a 125-byte payload, 2 for the
  code). An error without `ErrorMetadata` closes with 1011 `InternalServerError` (`lib.rs:1048-1056`).
- `Message::Close(None)` is a close frame with an empty payload; a browser reports it as code **1005** ("no
  status received").
- With no error (`Ok`), no close message is sent by the server.

So a client silent for 120 s gets close 1000 `ClientDisconnected` and no `FatalError` first.

## 2. What an app can observe

- A client that answers pings (every browser and Node WebSocket does, below the app) is never closed by the
  heartbeat, however long it is idle.
- A peer that sends nothing at all (a dead network path, a frozen tab whose socket still looks open, a raw
  client that never answers pings) is closed after 120–125 s with 1000 `ClientDisconnected`; the client
  library sees a normal close and reconnects (`web_socket_manager.ts` treats 1000 as normal).
- The close codes of every sync error, and the `FatalError` before `Forbidden`.
- A close without a code arrives as 1005. The official client treats 1000, 1001, 1005 and 4040 the same way
  (no error logged; STUDY-26), so this shows only to code that reads the close event.

## 3. How bunvex does it

Before this study: the sync socket ran with Bun's `idleTimeout: 960` and its default `sendPings: true`, so
uWS pinged a socket only as its 960 s idle timeout neared and closed it abruptly (1006) if nothing came
back. A dead peer stayed up to about 16 minutes. `ws.close()` without a code sent close **1000**, not an
empty frame. There was no `NotFound` or `Forbidden` close.

Now (`packages/server/src/sync.ts`, `close-frame.ts`, `server.ts`):

- **Heartbeat.** The `SyncHub`'s one timer (already ticking every second for the application `Ping`) calls
  `SyncSession.heartbeat(now)` for every session. A session whose client sent nothing for more than
  `CLIENT_TIMEOUT_MS` (120 000) fails with `ClientDisconnect` / `ClientDisconnected`; otherwise it sends a WS
  ping (`ws.ping()`) every `WS_PING_INTERVAL_MS` (5 000), then the application `Ping` if one is due.
  `heard()` records the client's frames: called from `message()`, and from Bun's `ping` and `pong` handlers on
  the WebSocket (Bun answers a client's ping by itself). The interval and the timeout are injectable:
  `SyncDeps.wsHeartbeat` and `ServerOptions.wsHeartbeat`; the hub's tick is the shorter of 1 s and the ping
  interval.
- **Bun's own pings are off** (`sendPings: false`): one heartbeat, the session's. The idle timeout stays at
  960 s as a backstop: it only fires on a socket nothing came in on for 16 minutes, which the session closes
  at 120 s, so in practice it never fires; it is there should a session's timer ever not run for a socket.
  Removing it (`idleTimeout: 0`) would gain nothing.
- **Close frames.** `close-frame.ts` is Convex's mapping: `ErrorCode`, `closeFrame()` (code and a reason cut
  to 123 bytes at a character boundary) and `isDeterministicUserError()`. `SyncSession.fail()` takes a
  `{ code, shortMsg, msg }` failure, sends a `FatalError` first for a deterministic user error, then the close
  frame, or an empty one (Bun's `ws.close(0)`, which a client sees as 1005, as Convex's `Close(None)`). Every
  existing failure was mapped to its Convex code: malformed messages and a bad `baseVersion` →
  `BadRequest`; OCC → `OCC`; `TooManyConcurrentMutations`, `TooManyInflightActionsForSingleClient`,
  `TooManyConcurrentRequests`, `TooManyWrites` → `RateLimited`; `SearchIndexesUnavailable` →
  `FeatureTemporarilyUnavailable`; out of retention → `OutOfRetention` (reason `InternalServerError`, as
  Convex's); any other error → `OperationalInternalServerError`. The codes on the wire are unchanged for all
  of them. `AuthError` closes without a code too (1005), as Convex's `Unauthenticated` / `AuthUpdateFailed`.
- No bunvex sync path raises `NotFound`, `PaginationLimit`, `Forbidden` or `Conflict` yet; the mapper has them
  for when one does.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| H1 | The WS heartbeat (DV-352): Bun's pings near a 960 s idle timeout → a 5 s WS ping and a 120 s timeout closing with 1000 `ClientDisconnected`; any inbound frame (message, pong, ping) counts | was Bun's default; now matches Convex | owner, 2026-10-05: match Convex, injectable timings, `sendPings: false` with the idle timeout kept as a backstop |
| H2 | Close frames (DV-353): `NotFound`, `PaginationLimit`, `Forbidden`, `ClientDisconnect` → 1000 with the short code; a `FatalError` first for `Forbidden`; a close without a code was 1000, now an empty frame (1005) | now matches Convex | owner, 2026-10-05 (the mapper, `NotFound`/`Forbidden`, `ClientDisconnect`); the 1005 close follows the owner's request to confirm it and matches Convex |
| H3 | What still differs (DV-354): no ping/pong metrics (`log_websocket_ping`, `log_websocket_pong` round trip, `log_websocket_client_timeout`); the timeout is checked every second (Convex: on its 5 s ticks, so 120–125 s), and the first ping goes after 5 s (Convex: as the socket opens); Bun's 960 s idle timeout remains as a backstop | Ainda não fizemos: the metrics belong to the `/metrics` work. The 1 s check reuses the hub's one timer for all sessions instead of one per socket | owner, 2026-10-05 (metrics skipped here) |

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- `packages/server/test/ws-heartbeat.test.ts` (timings injected: a 25 ms ping, a 200 ms timeout):
  - the close frame of each of Convex's 17 error codes; the short code as the reason; 1000/1011/1013;
  - `isDeterministicUserError`: `Forbidden` yes, `NotFound` and `ClientDisconnect` no;
  - the reason cut to 123 bytes at a character boundary;
  - Convex's constants, 5 s and 120 s;
  - a raw client that never answers: pinged on the interval, then closed with 1000 `ClientDisconnected`, not
    before the timeout, with no `FatalError`, its session gone;
  - a raw client that sends only pongs, only pings of its own (and gets Bun's pongs), or only messages, stays
    open past three timeouts, then is closed once silent;
  - a WebSocket client (answering pings itself) stays connected across many intervals and still gets a
    transition;
  - closes without a code: a malformed message (`FatalError`, then an empty close frame on the raw socket),
    a bad `baseVersion` (a WebSocket client sees 1005), an `AuthError` (1005).
- `packages/sync-e2e/test/ws-heartbeat.test.ts` (oracle): a raw TCP peer that never answers pings is closed
  with 1000 `ClientDisconnected` after pings and nothing else; the official `ConvexClient` stays connected
  across five timeouts (no reconnect, one connection) and its subscription still updates.
- Sabotage (each broke at least one test, then restored; `git diff` clean of it):
  - the `pong` handler not counting → 2 server tests and the official-client e2e fail;
  - the `ping` handler not counting → the "pings of its own" test fails;
  - messages not counting → 2 server tests and the official-client e2e fail;
  - no WS ping sent (interval × 1000) → 2 server tests and both e2e tests fail;
  - `ClientDisconnect` closing with 1011 → 5 server tests and the raw-peer e2e fail;
  - reason `ClientDisconnect` instead of `ClientDisconnected` → 4 server tests and the raw-peer e2e fail;
  - a no-code close sent as `close()` (1000) → both 1005 tests fail;
  - `Forbidden` not a deterministic user error → the mapper test fails;
  - the reason cut at 125 bytes → the truncation test fails;
  - the ping interval at 15 s → the constants test fails;
  - the injected timeout ignored → 4 server tests and the raw-peer e2e fail.
- Measurement: the per-frame cost added is one `performance.now()` (about 38 ns on an M-series laptop, against
  about 150 ns for `JSON.parse` of a small `Mutation` frame); the hub's per-second loop over the sessions
  existed already and gains a comparison and, every 5 s, one `ws.ping()` per socket, as Convex.

## 6. Open questions

None. Ping/pong metrics come with the `/metrics` work.
