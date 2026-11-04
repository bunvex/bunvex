# STUDY-207 — A cap on one connection's query set
<!-- index: `BUNVEX_MAX_QUERIES_PER_CONNECTION` (default 4096, 0 for none) refuses a `ModifyQuerySet` that would take a connection past it, which Convex has no counterpart for (AD-50, audit decision 3) | implemented -->

The 2026-11-03 production audit sent a single `ModifyQuerySet` frame of 20 000 distinct queries to an anonymous
connection. bunvex accepted it, ran the queries in 2.7 s and held every subscription. The performance audit
measured about 11 KB of server memory per subscription. One unauthenticated socket can therefore make the backend
hold roughly 220 MB, and a client can repeat that on every connection it opens. On 2026-11-04 the owner chose to
add a cap (decision 3). Convex has none, so the cap is an addition (AD-50).

## 1. How Convex does it

- `ClientMessage::ModifyQuerySet` (`crates/sync/src/worker.rs:645-662`) records the size of the added arguments
  (`log_query_modification_args_size`) and calls `SyncState::modify_query_set` (`crates/sync/src/state.rs:223`).
  `modify_query_set` checks only the versions and queues the modifications. Nothing bounds how many queries a
  connection holds.
- What bounds a frame is the WebSocket's 16 MiB message cap (tungstenite's default; bunvex's `maxPayloadLength`,
  STUDY-64 §1.7). At about 50 bytes a query, 16 MiB carries roughly 300 000 queries in one frame. Frames can
  accumulate past that.
- A connection reruns its queries `UPDATE_QUERY_CONCURRENCY` (20) at a time (STUDY-64 §1.4). This bounds how much
  CPU one connection takes at once, but not the memory its subscriptions hold.

## 2. What apps observe

A Convex app with a few hundred live queries is large. Every `useQuery` is one query, and every loaded page of a
`usePaginatedQuery` is one more. The cap is set far above what a real page holds: 4 096 by default. An app past it
sees what a client sees on any refused message, through the client's normal behaviour:

- The connection closes with a `BadRequest` error: "Too many queries on this connection: 5000, past
  BUNVEX_MAX_QUERIES_PER_CONNECTION (4096)". The client logs it and reconnects with backoff.
- The reconnect sends the same query set, and it is refused again, so the app does not load past the cap. That is
  the intent: an app that needs more queries raises the knob.

An app under the cap observes nothing.

## 3. How bunvex does it

- `SyncDeps.maxQueriesPerConnection`, else the `BUNVEX_MAX_QUERIES_PER_CONNECTION` knob (an unsigned integer;
  `knob`), else 4096. `0` turns the cap off, which is Convex's behaviour.
- On `ModifyQuerySet`, after the version checks and before anything is queued, the session counts the query set the
  frame would leave. It starts from the queries it holds and walks the modifications still pending and then the
  frame's: an `Add` of an id not yet in the set adds one, and a `Remove` of an id in it takes one away. A count past
  the cap fails the connection with `BadRequest`, so nothing of the frame is applied. The check costs one pass over
  the frame, which the parser has already made.
- A frame that removes queries and adds as many is accepted at the cap: only the result counts.
- **Its cost** (measured with the counting loop alone, Apple M-series): 0.04 µs for a frame of one `Add`,
  0.2 µs for 10, 39 µs for 2 000. A frame of 2 000 queries then runs them in about 270 ms, so the count is noise.

## 4. Divergences and additions

| # | bunvex | Convex | Status |
|---|---|---|---|
| AD-50 / DV-584 | A connection's query set is capped (default 4096, `BUNVEX_MAX_QUERIES_PER_CONNECTION`, `0` for none). A frame that would pass the cap fails the connection with `BadRequest`. | no cap; only the 16 MiB frame | owner, 2026-11-04 (audit decision 3): add it. The default and the knob's name are as proposed here. |

What it does not do: it bounds one connection, not one client. A client that opens many connections is the
concern of a connection-rate or per-IP limit in front of the backend, the reverse proxy's job (the self-hosting
guide).
