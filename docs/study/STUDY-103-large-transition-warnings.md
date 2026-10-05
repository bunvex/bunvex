# STUDY-103 — Large-transition warnings in the client

- **Status:** implemented; thresholds, per-frame measurement and wording decided by the owner (2026-10-05,
  DV-349; the debug `Event` stays omitted under DV-91)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05; the `convex` npm package
  1.46.0 as the oracle
- **Related:** [STUDY-23](STUDY-23-sync-protocol-v1.md) (transitions, `TransitionChunk`, P8),
  [STUDY-26](STUDY-26-sync-client.md) (the sync client, C4: no debug reporting)

## 1. How Convex does it

**The server** stamps every Transition with two fields (`crates/convex/sync_types/src/types/json.rs`):

- `clientClockSkew`: the client's `clientTs` from its `Connect`, minus the server's clock then, in ms
  (`crates/sync/src/worker.rs`, the `Connect` arm). It is `null` when the client sent no `clientTs`.
- `serverTs`: the server's clock when it sends the transition, in ns.

**The client** measures each frame in `browser/sync/web_socket_manager.ts`, `ws.onmessage` (lines 434–468):

- `messageLength = message.data.length` is taken first, from the frame as received: the string's length
  (UTF-16 code units, which Convex treats as bytes).
- A `TransitionChunk` is buffered until the transition is complete. The assembled Transition is then reported
  with the length of the frame that completed it, the **last chunk**, not the whole transition.
- Every Transition goes through `reportLargeTransition` (lines 885–942) before the client applies it.

`reportLargeTransition({ transition, messageLength })`:

1. Returns when `clientClockSkew` or `serverTs` is `undefined` (a `null` skew goes on, as 0).
2. `transit = monotonicMillis() - clientClockSkew - serverTs / 1_000_000`, in ms. `monotonicMillis()` is the
   same clock the client put in `Connect.clientTs`.
3. Formats: the size as `${Math.round(len / 10_000) / 100}MB`, the transit as `${Math.round(transit)}ms`, and a
   rate in MB per second the same way.
4. Always logs verbosely: `received <size> transition in <transit> at <rate>`.
5. Then, for everyone (`logger.log`, silenced only by `logger: false`):
   - over 20 000 000: `received query results totaling more that 20MB (<size>) which will take a long time to
     download on slower connections`;
   - else over 20 000 ms: `received query results totaling <size> which took more than 20s to arrive
     (<transit>)`.
6. With `reportDebugInfoToConvex`, sends an `Event` `ClientReceivedTransition` with the transit and length.

## 2. What an app can observe

- The two `log` lines above in its logger (the console by default), with Convex's thresholds: strictly over
  20 000 000 characters in one frame, else strictly over 20 s of transit.
- A chunked transition is judged by its last chunk: with 5 MB chunks the size warning never fires for it.
- The verbose line with `verbose: true`.

## 3. How bunvex does it

- **Server:** `packages/server/src/sync.ts` already sends `clientClockSkew` (`clientTs - Date.now()` at
  `Connect`, `null` without one) and `serverTs` (ns) on every Transition, as Convex.
- **Client:** `packages/client/src/web-socket-manager.ts`. `onmessage` keeps the frame's length and, for a
  Transition, calls `reportLargeTransition` before handing it on. The method computes the transit with the
  same `monotonicMillis()` the client sends as `clientTs`, and logs the verbose line and the two warnings with
  Convex's thresholds, formats and order.
- No debug `Event` is sent: bunvex's client has no `reportDebugInfoToConvex` (DV-91).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| LT1 | The size warning reads "totaling **more than** 20MB"; Convex's reads "more that" | A typo in Convex's message; the rest of the line is the same | owner, 2026-10-05: fix the wording (DV-349) |
| — | No `ClientReceivedTransition` debug `Event` | bunvex has no debug reporting | already decided: DV-91 (no new DV) |

## 4b. Additions (beyond Convex)

None.

## 5. Tests

**Differential** (`packages/sync-e2e/test/large-transition-warnings.test.ts`): BunvexClient and the official
ConvexClient, each with a recording logger, against a sync server the test scripts. The server's clock runs
10 minutes ahead, and it takes the client's `clientTs` from `Connect` to compute the skew as the servers do, so
the transit is right only if the skew is taken out. Four cases:

- a transition whose `serverTs` is 30 s old: both log the 20 s warning, the transit measured within
  30 000–35 000 ms;
- one frame of 21 MB: both log the size warning (Convex's line with "more that" read as "more than");
- a 25 MB transition in 5 chunks, 30 s old: both log the 20 s warning with the last chunk's size (5MB), and no
  size warning;
- a 21 MB transition without `clientClockSkew` and `serverTs`: neither logs anything.

In each case the verbose lines must match too, timing normalized.

**Unit** (`packages/client/test/web-socket-manager.test.ts`) covers:

- the size threshold exactly: a frame of 20 000 000 characters (no warning) and one of 20 000 001 (the warning);
- the size warning alone when both thresholds are passed;
- 19 s (nothing) and 21 s (the transit warning);
- nothing without the server's timing.

Sabotage checks, each caught:

| Sabotage | Unit | Differential |
|---|---|---|
| size threshold 25 MB | fails | fails |
| `>=` for the size | fails | passes |
| transit threshold 40 s | fails | fails |
| the whole transition measured, not the frame | passes | fails (chunked case) |
| the skew added instead of subtracted | passes | fails |
| both warnings (no `else`) | fails | passes |
| the wording changed | fails | fails |

**Measurement.** `onmessage` runs once per frame. Each small Transition frame is a few hundred bytes. The cost
was measured with the manager on a fake socket, 300 000 frames, median of 7 runs, 3 runs each:

- main: 1087–1137 ns per frame;
- this change: 1189–1206 ns per frame.

That is about 80 ns, for the verbose line's formatting, which Convex also does on every transition.

## 6. Open questions

None.
