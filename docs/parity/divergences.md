# Divergences from Convex

bunvex must behave the same as Convex. This file is the one place that lists every **deliberate**
difference, what Convex does instead and **why** bunvex differs. The full reasoning stays in the study
(or spec) that found it; each row links there.

- **What counts.** A divergence is any place where bunvex does something other than what Convex's source
  does, and keeps doing it on purpose. The *Observable* column says who can see it:
  - **yes**: an app (its functions, its clients, its tests) can see it;
  - **operational**: whoever runs the server can see it (startup, configuration, storage), apps cannot;
  - **no**: internal only (performance, storage layout), or only in the dashboard (**no (dashboard)**).
- **Bugs are not divergences.** Rows a study classed as BUG are tracked in the roadmap's Phase 0
  ([README.md](README.md#phase-0--correctness-bugs-in-what-already-exists)) and are not repeated here.
  Missing features are tracked as *missing* rows in the other parity files; the few that studies listed
  in their Divergences tables are in [Gaps](#gaps-recorded-in-studies) below.
- **The owner decides every divergence.** Matching Convex needs no decision. Until the owner has decided,
  a divergence is *pending* and the default is to match Convex.
- **Every PR that decides, changes or resolves a divergence updates this file** in the same PR: it adds a
  row, moves a row between tables, or changes its status, and it updates the study's Divergences table.
- **IDs are stable.** `DV-NN` is never reused or renumbered. A row keeps its ID when it moves from
  *Pending* to *Decided* or to *Resolved*. New rows take the next free number.

Sources are cited as the study's own ID (e.g. STUDY-12 D3). Swept from every `docs/study/STUDY-*.md` and
every parity row marked "Divergence?" on `main`, 2026-09-30.

## Decided divergences

| ID | bunvex | Convex | Observable | Why | Decided | Source |
|---|---|---|---|---|---|---|
| DV-01 | `Math.random` in queries and mutations is a seeded sfc32 | seeded ChaCha12 | no | Neither is cryptographic; a seeded PRNG is enough and sfc32 is fast in JS | accepted (#4) | [STUDY-03 D1](../study/STUDY-03-deterministic-execution.md#4-divergences) |
| DV-02 | Determinism is not a sandbox: code that captured `Date.now` before the install, or reaches a non-global API such as `Bun.sleep`, escapes it | every function runs in a V8 isolate with the globals replaced | yes | One process, no isolate | accepted (#4) | [STUDY-03 D2](../study/STUDY-03-deterministic-execution.md#4-divergences) |
| DV-03 | Public names carry no "convex": `isValidator` marker, `toJsonValue` / `fromJsonValue`, `BunvexError` | `isConvexValidator`, `convexToJson` / `jsonToConvex`, `ConvexError` | yes | Owner rule: no "convex" in bunvex's public API (`check:deps` rule 5) | owner, 2026-09-30 (#21, #24, #32) | [STUDY-13 D1](../study/STUDY-13-validators.md#4-divergences), [STUDY-18 D1](../study/STUDY-18-value-model.md#4-divergences), [server-api §8](server-api.md#8-validators-v-and-value-types) (`ConvexError` row), [STUDY-26 C1](../study/STUDY-26-sync-client.md#4-divergences), [STUDY-26 R1](../study/STUDY-26-sync-client.md#73-divergences), [STUDY-26 H1](../study/STUDY-26-sync-client.md#93-divergences) |
| DV-04 | Error messages keep Convex's structure and facts but never name Convex or link to its docs | messages name Convex and link to docs.convex.dev | yes | Owner rule (as DV-03) | accepted (owner rule, #21, #24) | [STUDY-13 D3](../study/STUDY-13-validators.md#4-divergences), [STUDY-26 C2](../study/STUDY-26-sync-client.md#4-divergences) |
| DV-05 | Bytes print as `ArrayBuffer(n bytes)` in validator messages | Rust's `Bytes` display | yes | Rust's form is internal; any readable form will do | accepted (#24) | [STUDY-13 D4](../study/STUDY-13-validators.md#4-divergences) |
| DV-06 | `withIndex` after another query operator fails with a bunvex message | the method does not exist on that stage (a `TypeError`) | yes | One object shape in JS | accepted (#40) | [STUDY-16 D1](../study/STUDY-16-query-chaining.md#4-divergences) |
| DV-07 | Without `INSTANCE_SECRET`, the generated secret is stored in the store (system table `_instance`) | the self-hosted image saves it in a file of its data directory | operational | The data may live in a remote database, not next to the process | owner, 2026-09-30 (option D) | [STUDY-17 D2](../study/STUDY-17-paginate.md#4-divergences) |
| DV-08 | A pagination cursor's fingerprint covers table, index, range and order, not the filter | the fingerprint includes the serialized filter expressions | yes | Filters are JS closures here, not a serialized expression | accepted (#42) | [STUDY-17 D3](../study/STUDY-17-paginate.md#4-divergences) |
| DV-09 | Sync: one query execution per (query, args, identity, ts) is shared by every connection, and each connection assembles its own transition | each connection runs its own queries | no | Same observable behaviour; keeps bunvex's fan-out advantage | owner, 2026-09-30 | [STUDY-23 P3](../study/STUDY-23-sync-protocol-v1.md#6-decisions-accepted-as-recommended-owner-2026-09-30) |
| DV-10 | Sync: transitions over 5 MB are not split into `TransitionChunk`s yet | chunks them for clients that support it | yes | Later, after the client, with the client-version gate | owner, 2026-09-30 | [STUDY-23 P8](../study/STUDY-23-sync-protocol-v1.md#6-decisions-accepted-as-recommended-owner-2026-09-30) |
| DV-11 | Sync: until `@bunvex/auth` exists, only `tokenType: "None"` is accepted; other tokens get an `AuthError` | verifies the token | yes | Never trust an unverified token | owner, 2026-09-30 | [STUDY-23 P9](../study/STUDY-23-sync-protocol-v1.md#6-decisions-accepted-as-recommended-owner-2026-09-30) |
| DV-12 | Sync: identity is part of every shared execution's key | only for results that depend on the identity | no | Correct and simple first; refine later | owner, 2026-09-30 | [STUDY-23 P10](../study/STUDY-23-sync-protocol-v1.md#6-decisions-accepted-as-recommended-owner-2026-09-30) |
| DV-13 | Sync: client telemetry `Event` messages are accepted and ignored | logs them and records client metrics (`crates/sync/src/worker.rs`) | operational | bunvex has no metrics pipeline yet | owner, 2026-09-30 | [STUDY-23 P11](../study/STUDY-23-sync-protocol-v1.md#6-decisions-accepted-as-recommended-owner-2026-09-30) |
| DV-14 | Single writer: the lease has a TTL on the store's clock and a graceful release; a live lease is never taken, so a second process fails to open with `LeaseHeldError` (or waits, `lease.waitMs`). The fence is an epoch checked inside each flush | the newest process takes the lease at once; the loser exits on its next write with `LeaseLostError` | operational | A running server is never displaced by a second start by mistake; a clean shutdown hands over at once | owner, 2026-09-30 (#62) | [PERSIST-01 v2 C7](../specs/PERSIST-01-contract.md#c7--single-writer-lease-and-fencing); STUDY-24 H5 (open PR #54); [platform §22](platform.md#22-deployment-state-health-self-hosted-configuration) "Single writer per database" |
| DV-15 | Dashboard: bunvex's own package, not Convex's dashboard against a compatible API | Convex's Next.js dashboard over ~40 system UDFs | no (dashboard) | One package for self-hosted and a future cloud; Convex's is FSL and tied to its hosts | owner (UI-01 brief) | [STUDY-12 D1](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-16 | Dashboard: the screen is **Database** at `/database/$table` | **Data** at `/data?table=` | no (dashboard) | The owner's naming | owner (UI-01 §12.6) | [STUDY-12 D2](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-17 | Dashboard: live documents via `watchTable` plus refreshing the loaded pages; scheduled functions and cron runs the same way | reactive paginated queries | no (dashboard) | Simpler for the server; same screen | owner (UI-01 §12.6) | [STUDY-12 D3, S1](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-18 | Dashboard: changed data flashes blue | yellow | no (dashboard) | Blue already means "live" in bunvex; yellow reads as a warning | owner (UI-01 §12.5.4) | [STUDY-12 D4](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-19 | Dashboard: changes compared by row id; "new" means arrived among the rows shown | by position; new if `_creationTime` is within 1 s of the viewer's clock | no (dashboard) | Scrolling and paging never flash; no dependence on a skewed clock | owner, 2026-09-30 | [STUDY-12 D5](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-20 | Dashboard: with reduced motion, a steady tint and a polite screen-reader announcement | no flash | no (dashboard) | Accessibility | owner, 2026-09-30 | [STUDY-12 D6](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-21 | Dashboard: the filter URL param is base64url of bunvex's `FilterExpression` | `filters`, base64 of Convex's own shape | no (dashboard) | bunvex's contract shape; no search indexes yet | owner, 2026-09-30 | [STUDY-12 D7](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-22 | Dashboard: a document link is `?doc=<id>` and opens the side panel | a filter `_id eq <id>` | no (dashboard) | The document opens beside the list | owner, 2026-09-30 | [STUDY-12 D8](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-23 | Dashboard: columns are reordered from a keyboard-first Columns panel | header drag and drop | no (dashboard) | Accessible first; dragging can come later | owner, 2026-09-30 | [STUDY-12 D10](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-24 | Dashboard: Delete document from a cell's menu asks first | deletes at once; asks only on production | no (dashboard) | Deletes cannot be undone and bunvex has no deployment kind yet; becomes "production only" once it does | owner, 2026-09-30 | [STUDY-12 D13](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-25 | Dashboard: Functions has no Statistics tab | per-function metrics | no (dashboard) | The server has no app-metrics API yet | owner, 2026-09-29 | [STUDY-12 L1](../study/STUDY-12-dashboard.md#73-divergences) |
| DV-26 | Dashboard: older logs load at the end of the list (paged) | only what the stream's ring buffer holds | no (dashboard) | A server with a longer history can show it | owner, 2026-09-30 | [STUDY-12 L4](../study/STUDY-12-dashboard.md#73-divergences) |
| DV-27 | Dashboard: the log list keeps your place instead of pausing when you scroll | pauses on scroll | no (dashboard) | The grid anchors its top row already; the reader sees the same | owner, 2026-09-30 | [STUDY-12 L5](../study/STUDY-12-dashboard.md#73-divergences) |
| DV-28 | Dashboard: log filters live in the URL and in the browser | in the browser only | no (dashboard) | A link carries the filters | owner, 2026-09-30 | [STUDY-12 L7](../study/STUDY-12-dashboard.md#73-divergences) |
| DV-29 | Dashboard: a function's argument and return validators are shown as code | not shown | no (dashboard) | The owner asked for it | owner, 2026-09-30 | [STUDY-12 V1](../study/STUDY-12-dashboard.md#83-divergences) |
| DV-90 | Function references (`anyApi`, `makeFunctionReference`, `getFunctionName`) live in `@bunvex/protocol`, re-exported by `@bunvex/server` and `@bunvex/client` | in `convex/server` | yes (import path) | The client may not import the server (dependency rules), and both need them | owner, 2026-09-30 (#74) | [STUDY-26 C3](../study/STUDY-26-sync-client.md#4-divergences) |
| DV-91 | The client has no `reportDebugInfoToConvex` option and sends no debug `Event`s or `/api/debug_event` reports | optional debug telemetry | yes (option) | bunvex has no telemetry endpoint | owner, 2026-09-30 (#74) | [STUDY-26 C4](../study/STUDY-26-sync-client.md#4-divergences) |
| DV-92 | `getMaxObservedTimestamp()` returns a `bigint` | a `Long` | yes | bunvex's 64-bit values are bigints | owner, 2026-09-30 (#74) | [STUDY-26 C5](../study/STUDY-26-sync-client.md#4-divergences) |
| DV-93 | The official `convex` npm package is a dev dependency of the private `packages/sync-e2e`, used only as the protocol oracle in tests | (n/a) | no | Wire compatibility (STUDY-23 P1) makes it a free conformance check; never shipped | owner, 2026-09-30 (#74) | [STUDY-26 C7](../study/STUDY-26-sync-client.md#4-divergences) |
| DV-95 | `useSubscription` is built on React's `useSyncExternalStore` | a hand-written state + effect hook (whose own comment suggests `useSyncExternalStore`) | no | Same behaviour: the value on first render, a re-read right after subscribing, one render per change | owner, 2026-09-30 (#81) | [STUDY-26 R2](../study/STUDY-26-sync-client.md#73-divergences) |
| DV-97 | The HTTP client sends admin auth as `Authorization: Bunvex <key>` | `Convex <key>` | yes (wire) | Owner naming rule; the server checks no admin key yet, so this sets the scheme | owner, 2026-09-30 (#85) | [STUDY-26 H2](../study/STUDY-26-sync-client.md#93-divergences) |
| DV-98 | `/api/query_at_ts` with a ts ahead of the server's answers 400 `InvalidTimestamp` | whatever its database layer does for a future snapshot | yes | One node: bunvex's own clients never send one | owner, 2026-09-30 (#85) | [STUDY-26 H4](../study/STUDY-26-sync-client.md#93-divergences) |
| DV-96 | A cursor of another query fails with a `BunvexError` whose data is `{isBunvexSystemError: true, paginationError: "InvalidCursor"}`; `usePaginatedQuery` restarts on that data or on the message | the same, with the key `isConvexSystemError` | yes | Owner naming rule (option a); closes STUDY-17 D4. The official client still recognizes it by the message | owner, 2026-09-30 (#86) | [STUDY-26 P1](../study/STUDY-26-sync-client.md#83-divergences), [STUDY-17 D4](../study/STUDY-17-paginate.md#4-divergences) |
| DV-52 | `performance.timeOrigin` is the process's; no import phase where `now()` is 0 | a module import time; `now()` is 0 at import | yes | Not possible exactly without an isolate per function (the DV-02 architecture); approximable | owner, 2026-09-30: accepted | [STUDY-03 D3](../study/STUDY-03-deterministic-execution.md#4-divergences) |
| DV-81 | The OCC message has no docs-link suffix | ends with `See https://docs.convex.dev/error#1` | yes | Never the same text (DV-04's rule); a link to bunvex's docs, same structure, once they exist | owner, 2026-09-30: accepted | [STUDY-21 D1](../study/STUDY-21-occ-error-and-retries.md#4-divergences) |
| DV-94 | A replayed session mutation (a resend that already committed) answers the ts of the snapshot that saw its record, at or after the original commit | the original commit's ts | yes (protocol ts only) | Temporary: match Convex when `Persistence` returns a version's ts (a PERSIST-01 change) | owner, 2026-09-30: later | [STUDY-23 P13](../study/STUDY-23-sync-protocol-v1.md#6-decisions-accepted-as-recommended-owner-2026-09-30) |
| DV-76 | Error frames are Bun's raw frames, with bunvex's internal frames and absolute paths | source-mapped to the user's modules | yes | Temporary: match Convex with the deploy/bundle step (source maps) | owner, 2026-09-30: later | [STUDY-20 D4](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |
| DV-77 | Captured log lines are also printed to stdout | log streams only | operational | Temporary: stop printing once log streaming reaches the operator | owner, 2026-09-30: later | [STUDY-20 D5](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |
| DV-80 | Only `CommitterStoppedError` is a system error; other internal failures surface as function errors | `ErrorMetadata` tells them apart | yes | Temporary: tag internal failures as system errors as they appear (auth, persistence) | owner, 2026-09-30: later, gradually | [STUDY-20 D8](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |

## Resolved to match Convex

Differences that existed (or were proposed) and now match Convex, or are decided to and are being built.
Kept so the history is in one place.

| ID | What differed | Now | Observable | Decided | Source |
|---|---|---|---|---|---|
| DV-30 | Commit timestamps were a counter (1, 2, 3…) | As Convex: `ts = max(last + 1, wall clock)`. Unit note: bunvex counts **microseconds** internally (a JS number is exact only to 2^53) and sends × 1000, so clients see Convex's wall-clock nanoseconds at µs resolution | yes (sync protocol ts) | owner, 2026-09-30 (#64) | [STUDY-06 D9](../study/STUDY-06-transactions-and-occ.md#4-divergences) |
| DV-31 | No mutation idempotency: no session or request id, a re-sent mutation ran twice | Decided as Convex: `_session_requests` system table, transactional, 2 weeks' retention. Built in #63 (`Engine.sessionMutation`, cleanup by `_creationTime`) | yes | owner, 2026-09-30 | [STUDY-03 D4](../study/STUDY-03-deterministic-execution.md#4-divergences), [STUDY-06 D7](../study/STUDY-06-transactions-and-occ.md#4-divergences), [STUDY-11 D8](../study/STUDY-11-function-results-and-errors.md#4-divergences), [STUDY-23 P5, P6](../study/STUDY-23-sync-protocol-v1.md#6-decisions-accepted-as-recommended-owner-2026-09-30) |
| DV-32 | `performance.now()` was the real clock | Fixed in queries, incrementing in mutations, rounded down to 0.1 ms (the `timeOrigin` part is DV-52) | yes | #41 | [STUDY-03 D3](../study/STUDY-03-deterministic-execution.md#4-divergences) |
| DV-33 | Mutations started in the same millisecond shared an integer `_creationTime` | Sub-millisecond creation times | yes | #10 | [STUDY-05 D3](../study/STUDY-05-index-keys-and-ordering.md#4-divergences) |
| DV-34 | Cross-type order and `-0` differed in index keys | Convex's order (`undefined < null < int64 < float64 < boolean < string < bytes < array < object`), `-0 < 0` | yes | #21 (STUDY-18) | [STUDY-05 D7, D8](../study/STUDY-05-index-keys-and-ordering.md#4-divergences) |
| DV-35 | Index definitions were not validated | Convex's rules for index names and fields | yes | #6, #10 | [STUDY-05 D9](../study/STUDY-05-index-keys-and-ordering.md#4-divergences) |
| DV-36 | No nested field paths in indexes | Dotted paths can be indexed | yes | #21 | [STUDY-05 D10](../study/STUDY-05-index-keys-and-ordering.md#4-divergences) |
| DV-37 | `_id` in index keys was tagged as bytes | A string value, as Convex's `IndexKey` | no | #21 | [STUDY-05 D12](../study/STUDY-05-index-keys-and-ordering.md#4-divergences) |
| DV-38 | OCC: 30 retries with ≤20 ms backoff, and `Error("write conflict")` | Convex's budget (4 retries, 100 ms–2 s) and `OptimisticConcurrencyControlFailure` error | yes | owner (#38) | [STUDY-06 D4, D5](../study/STUDY-06-transactions-and-occ.md#4-divergences), [STUDY-21](../study/STUDY-21-occ-error-and-retries.md) |
| DV-39 | No transaction read or write limits | Convex's read limits (#12) and write limits (#35) | yes | #12, #35 | [STUDY-06 D6](../study/STUDY-06-transactions-and-occ.md#4-divergences) |
| DV-40 | No `filter`, `unique`, `paginate` or async iteration | Built as Convex (#37, #40, #42). `.limit()` is still missing (a gap, not a divergence) | yes | #37, #40, #42 | [STUDY-07 D5](../study/STUDY-07-query-semantics.md#4-divergences) |
| DV-41 | Repeated `order()`, `withIndex` after `order`, and reused queries were allowed | Convex's errors | yes | #40 | [STUDY-07 D6](../study/STUDY-07-query-semantics.md#4-divergences) |
| DV-42 | Undeclared tables threw on read and insert | Read as empty; created on first insert | yes | #33 | [STUDY-07 D7](../study/STUDY-07-query-semantics.md#4-divergences), [STUDY-14 D3](../study/STUDY-14-schemas.md#4-divergences), [STUDY-04 D2](../study/STUDY-04-table-and-index-metadata.md#5-divergences) |
| DV-43 | `db.get(table, id)` with another table's id returned `null` unchecked | Checks the id's table, with Convex's errors | yes | #7 | [STUDY-07 D8](../study/STUDY-07-query-semantics.md#4-divergences) |
| DV-44 | Subscriptions were pushed one by one, and a mutation resolved before the client's queries reflected it | Transitions at one ts per connection and the mutation's commit ts (server side; the client follows) | yes | owner, 2026-09-30 (#50) | [STUDY-08 D4, D5](../study/STUDY-08-cache-and-subscriptions.md#4-divergences), [STUDY-11 D8](../study/STUDY-11-function-results-and-errors.md#4-divergences) |
| DV-45 | Cache and subscription keys depended on argument field order | Canonical JSON of the arguments | no | #21 | [STUDY-08 D7](../study/STUDY-08-cache-and-subscriptions.md#4-divergences) |
| DV-46 | No Int64, Bytes or `$integer`/`$bytes`/`$float` wire encoding; `patch({f: undefined})` left the field present | Convex's value model end to end | yes | #21 (STUDY-18) | [STUDY-10 D2, D10](../study/STUDY-10-documents-and-values.md#4-divergences), [STUDY-11 D4](../study/STUDY-11-function-results-and-errors.md#4-divergences) |
| DV-47 | No field-name validation; `_id`/`_creationTime` in writes silently ignored; fields in insertion order | Convex's field-name rules, system-field checks and sorted fields | yes | #21 | [STUDY-10 D4, D5, D11](../study/STUDY-10-documents-and-values.md#4-divergences) |
| DV-48 | No document limits, no `replace`, silent `delete` of a missing document, a different `patch` message | Convex's limits, `db.replace` and "Update / Replace / Delete on nonexistent document ID" | yes | #35 | [STUDY-10 D6–D9](../study/STUDY-10-documents-and-values.md#4-divergences) |
| DV-49 | Function errors: HTTP 500, bare message, no `errorData`, no redaction, no `logLines` | As Convex's backend: 200 `{status: "error"}`, `[Request ID: …] Server Error`, `errorData`, redaction, `logLines` (the hosted 560 is DV-58) | yes | #32 | [STUDY-11 D1–D3, D7](../study/STUDY-11-function-results-and-errors.md#4-divergences), [STUDY-08 D11](../study/STUDY-08-cache-and-subscriptions.md#4-divergences), [STUDY-20](../study/STUDY-20-function-errors-and-logs.md) |
| DV-50 | Dashboard: values typed in a syntax of bunvex's own | JavaScript literals in a Monaco editor, as Convex | no (dashboard) | owner, 2026-09-30 | [STUDY-12 D9](../study/STUDY-12-dashboard.md#4-divergences) |
| DV-51 | Dashboard: proposed text-file previews, a client-side log filter, and a function runner were weighed | Images only; filters on the client; a Run panel — all as Convex | no (dashboard) | owner, 2026-09-29/30 | [STUDY-12 F1](../study/STUDY-12-dashboard.md#93-divergences), [L2, L3](../study/STUDY-12-dashboard.md#73-divergences) |
| DV-82 | A WebSocket mutation that exhausted its OCC budget got an error result | As Convex on protocol v1: the connection closes with 1013 and the code, and the client re-sends (it runs once, `_session_requests`). v0 `/ws` keeps the old behaviour until it is deleted (STUDY-23 P2) | yes | owner, 2026-09-30 (#50) | [STUDY-21 D2](../study/STUDY-21-occ-error-and-retries.md#4-divergences) |
| DV-58 | HTTP function errors answer 200 | Already as Convex's open-source backend: 200 `{status: "error"}`; only the hosted service answers 560 | yes | owner, 2026-09-30 | [STUDY-20 D1](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |
| DV-70 | Non-Convex return values are coerced or throw an untyped error | As Convex since #21: a value that is not one fails the call with the value model's message (e.g. `… is not a supported value type.`) | yes | owner, 2026-09-30 (#21) | [STUDY-11 D5](../study/STUDY-11-function-results-and-errors.md#4-divergences) |
| DV-71 | Function-not-found text: "function not found: x" | Convex's messages, alone (no `Uncaught`, no frames): `Could not find public function for 'm:x'.` (also for an internal one called from a client), and `Trying to execute m.js:x as Query, but it is defined as Mutation.` | yes | owner, 2026-09-30 | [STUDY-11 D6](../study/STUDY-11-function-results-and-errors.md#4-divergences) |
| DV-74 | A cached query result carries no `logLines` | A cache hit answers the log lines stored with the entry (`Engine` `CacheCompanion`) | yes | owner, 2026-09-30 | [STUDY-20 D2](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |
| DV-79 | `REDACT_LOGS_TO_CLIENT=false` or `0` leaves redaction off | As Convex: any non-empty value enables redaction, `false` too | operational | owner, 2026-09-30 | [STUDY-20 D7](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |

Not a divergence, listed so it is not "fixed" into one: the `0x00`-escape prefix quirk in index keys is the
same in both systems ([STUDY-05 D13](../study/STUDY-05-index-keys-and-ordering.md#4-divergences)).
STUDY-01 chose Convex's id format exactly (option C, owner, 2026-09-29) and STUDY-02 found none.

## Pending owner decisions

Each row's study still says *owner*, *open* or *awaits*. Until decided, the default is to match Convex.

| ID | bunvex | Convex | Observable | Note | Source |
|---|---|---|---|---|---|
| DV-53 | Tablet ids are small integers from a counter; `_tables`/`_index` have fixed ids | random 16-byte ids; persistence globals | no | PERSIST-01 stores integer ids | [STUDY-04 D1](../study/STUDY-04-table-and-index-metadata.md#5-divergences) |
| DV-54 | Index backfill runs synchronously at startup | in the background | operational | Marked "owner (gap)" | [STUDY-04 D3](../study/STUDY-04-table-and-index-metadata.md#5-divergences) |
| DV-55 | No `Backfilled`/staged index state, no namespaces (components) | has both | yes | Marked "owner (gap)" | [STUDY-04 D4](../study/STUDY-04-table-and-index-metadata.md#5-divergences) |
| DV-56 | Stores written by an older bunvex are not readable (no migrations) | migrates | operational | Pre-alpha, no production data; later PRs (#17, #21) repeat it | [STUDY-04 D5](../study/STUDY-04-table-and-index-metadata.md#5-divergences) |
| DV-57 | The read-set of `take(n)`/`first()` is the whole range, not the scanned prefix; this also causes extra subscription re-runs | ends at the last key read | yes | More OCC conflicts (queue heads) | [STUDY-06 D3](../study/STUDY-06-transactions-and-occ.md#4-divergences), [STUDY-08 D10](../study/STUDY-08-cache-and-subscriptions.md#4-divergences) |
| DV-59 | No `db.vars.commitTs` / `v.commitTs()` | has them | yes | Missing API | [STUDY-06 D8](../study/STUDY-06-transactions-and-occ.md#4-divergences), [STUDY-13 D2](../study/STUDY-13-validators.md#4-divergences) |
| DV-60 | The write log is trimmed by count (20 000 commits); a snapshot outside it is a retried conflict | by time or size; `OutOfRetention` | no | Very long mutations fail differently | [STUDY-06 D10](../study/STUDY-06-transactions-and-occ.md#4-divergences) |
| DV-61 | Commit validation is linear over the log | the log is indexed per index | no | Performance only | [STUDY-06 D11](../study/STUDY-06-transactions-and-occ.md#4-divergences) |
| DV-62 | Commit group size per flush is unbounded | ≤64 docs / 64 KiB per batch, up to 16 in flight | no | A large group can hit a remote store's packet limits | [STUDY-06 D12](../study/STUDY-06-transactions-and-occ.md#4-divergences), [STUDY-09 D9](../study/STUDY-09-persistence-layout.md#4-divergences) |
| DV-63 | Query cache: FIFO at 1 000 entries, no coalescing for HTTP calls, subscriptions bypass it | LRU bounded by bytes, coalesced | no | Sync v1 (#50) coalesces its own executions | [STUDY-08 D8](../study/STUDY-08-cache-and-subscriptions.md#4-divergences) |
| DV-64 | Invalidation is a linear scan over subscriptions × writes × intervals | splayed index | no | Performance at many subscriptions | [STUDY-08 D9](../study/STUDY-08-cache-and-subscriptions.md#4-divergences) |
| DV-65 | No retention of old versions or tombstones | index versions 4 min, documents 14 days | no | Storage grows; Phase 3 "retention" | [STUDY-09 D5](../study/STUDY-09-persistence-layout.md#4-divergences) |
| DV-66 | No `prev_ts` and no by-ts document read | has both | no | Needed for retention, export, log rebuild | [STUDY-09 D6](../study/STUDY-09-persistence-layout.md#4-divergences) |
| DV-67 | Documents joined by "newest ≤ ts" per id | by the index entry's exact ts | no | Same answer, one extra lookup | [STUDY-09 D7](../study/STUDY-09-persistence-layout.md#4-divergences) |
| DV-68 | Column types: text ids, int table ids, JSON as text | `BYTEA` ids, binary JSON | no | Follows STUDY-01 | [STUDY-09 D8](../study/STUDY-09-persistence-layout.md#4-divergences) |
| DV-69 | No read-only system tables or `db.system` (table-name rules are done, #6) | `_`-tables only via `db.system`, read-only | yes | Matters once `_storage`, `_scheduled_functions` exist | [STUDY-10 D12](../study/STUDY-10-documents-and-values.md#4-divergences) |
| DV-72 | Dashboard: an event's author is the credential ("admin key") | a team member (null when self-hosted) | no (dashboard) | Recorded as "follows the data", no owner decision | [STUDY-12 H1](../study/STUDY-12-dashboard.md#93-divergences) |
| DV-73 | Pagination cursors are signed (HMAC), not encrypted | encrypted | yes | Encryption needs the key broker (Phase 3) | [STUDY-17 D1](../study/STUDY-17-paginate.md#4-divergences) |
| DV-75 | Subscription updates carry no log lines | `QueryUpdated`/`QueryFailed` do | yes | With protocol v1 | [STUDY-20 D3](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |
| DV-78 | A system error during a WebSocket mutation is that mutation's error | the sync worker fails and the connection closes | yes | Revisit with protocol v1's `FatalError` | [STUDY-20 D6](../study/STUDY-20-function-errors-and-logs.md#4-divergences) |
| DV-83 | The mutation-queue overflow closes the socket without a message the client recognises | the client recognises the close reason | yes | With protocol v1 (close 1013, STUDY-23 §4.5) | [STUDY-22 D1](../study/STUDY-22-ws-mutation-order.md#4-divergences) |
| DV-84 | Storage ids: bunvex could accept only document ids | `Id<"_storage">` and legacy UUIDs | yes | Parity "Divergence?" | [platform §3](platform.md#3-file-storage) |
| DV-85 | Crons: the splay could be skipped | runs without `minuteUTC` get a stable random offset in the hour | yes | Parity "Divergence?" | [platform §5](platform.md#5-cron-jobs) |
| DV-86 | HTTP actions: bunvex could serve them on the same port, by path or host | `/http/*` and a separate site origin (port 3211) | yes | Parity "Divergence?" | [platform §8](platform.md#8-http-actions) |
| DV-87 | `"use node"`: may collapse to "accept and ignore" since Bun has Node APIs | a separate Node runtime for those modules | yes | Parity "Divergence?" | [platform §9](platform.md#9-nodejs-actions-use-node) |
| DV-88 | Database selection uses bunvex's own env names (`PERSISTENCE`, `PERSISTENCE_URL`); could accept Convex's as aliases | `POSTGRES_URL`, `MYSQL_URL`, `DATABASE_URL` | operational | Parity "Divergence?" | [platform §22](platform.md#22-deployment-state-health-self-hosted-configuration) |
| DV-89 | No beacon / telemetry | an hourly beacon (`DISABLE_BEACON`), Sentry | operational | Parity "Divergence?": "bunvex probably shouldn't ship one" | [platform §22](platform.md#22-deployment-state-health-self-hosted-configuration) |

## Gaps recorded in studies

Missing pieces that studies listed in their Divergences tables as *gap* or *follow-up*. They are not
deliberate differences: the plan is to build them as Convex has them (their parity rows track them). If
the owner decides to keep one as a difference, it gets a `DV` row.

| Study row | Missing |
|---|---|
| [STUDY-14 D1](../study/STUDY-14-schemas.md#4-divergences) | Existing documents are not re-checked when the schema changes (deploy/push flow) |
| [STUDY-14 D2](../study/STUDY-14-schemas.md#4-divergences) | `searchIndex`, `vectorIndex`, `staged` (phase 4) |
| [STUDY-15 D1](../study/STUDY-15-query-filter.md#4-divergences) | The query-operator limit (`MAX_QUERY_OPERATORS`) |
| [STUDY-21 D3](../study/STUDY-21-occ-error-and-retries.md#4-divergences) | `TooManyWrites` retried within the budget (no write-throughput limit yet) |
| [STUDY-12 D11, D12](../study/STUDY-12-dashboard.md#4-divergences) | Dashboard: custom query, per-table metrics; function metrics on the Health screen |
| [STUDY-12 L6](../study/STUDY-12-dashboard.md#73-divergences) | Dashboard logs: deployment events, usage and identity, "act as a user", run history, live runner results |
| [STUDY-12 S2, H2](../study/STUDY-12-dashboard.md#93-divergences) | Dashboard: component picker; server-recorded events (pushes, index builds) |
| [STUDY-26 C6](../study/STUDY-26-sync-client.md#4-divergences) | Client: `setAuth` (with `@bunvex/auth`); the paginated query client and the HTTP client come in the next PRs |
| [STUDY-26 R3](../study/STUDY-26-sync-client.md#73-divergences) | React: auth helpers and `usePreloadedQuery` (with `@bunvex/auth` and `@bunvex/nextjs`); `usePaginatedQuery` comes in the next PR |
| [STUDY-26 P2](../study/STUDY-26-sync-client.md#83-divergences) | The non-React paginated client: `BunvexClient.onPaginatedUpdate_experimental`, `BunvexReactClient.watchPaginatedQuery` |
| [STUDY-26 H3](../study/STUDY-26-sync-client.md#93-divergences) | HTTP client `function(name, componentPath, args)` and `/api/function` (with components) |
