---
"@bunvex/server": patch
---

The sync socket's heartbeat is Convex's: a WebSocket ping every 5 s, and a client that sent nothing (no message, pong or ping) for 120 s is closed with 1000 `ClientDisconnected`. Close frames follow Convex's mapping: 1000 with the short code for `NotFound`, `PaginationLimit`, `Forbidden` and `ClientDisconnect` (a `FatalError` first for `Forbidden`), and a close without a code arrives as 1005, as Convex's. `createServer({ wsHeartbeat })` shortens the timings for tests.
