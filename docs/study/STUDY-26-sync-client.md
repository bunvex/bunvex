# STUDY-26 — The sync client (`@bunvex/client`)

- **Status:** accepted: C3–C7, R2–R3, P1–P2 and H2–H4 (owner, 2026-09-30)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** STUDY-23 (sync protocol v1; this is its step 7), #50 (sessions), #63 (`_session_requests`),
  ARCH-01 §6 open decision 1 (types: codegen or inference)

## 1. How Convex does it

The browser client is `npm-packages/convex/src/browser/` (about 6 700 lines). A **base client** does the
protocol, and friendlier clients are built around it.

### 1.1 `BaseConvexClient` (`sync/client.ts`)

- **Construction.**
  - The deployment URL is validated (`validateDeploymentUrl`, `common/index.ts`): it must be defined, a
    string, start with `http:`/`https:`, and parse as a URL. `skipConvexDeploymentUrlCheck` skips this.
  - The socket URL is `ws(s)://<origin>/api/<npm version>/sync`.
  - There is one `sessionId` per client (UUID v4, `sync/session.ts`), and `requestId`s count from 0,
    shared by mutations and actions.
  - Options:
    - `webSocketConstructor`;
    - `unsavedChangesWarning`: default on in browsers. A `beforeunload` prompt appears while a request is
      not yet answered;
    - `verbose`, `logger`, `onServerDisconnectError`;
    - `authRefreshTokenLeewaySeconds`, `expectAuth`, `initialAuthTokenReuse`;
    - `reportDebugInfoToConvex`.
- **`onOpen`** (every socket):
  1. send `Connect {sessionId, connectionCount, lastCloseReason, maxObservedTimestamp, clientTs}`;
  2. drop the remote query set;
  3. send `LocalSyncState.restart()`: the whole query set as `ModifyQuerySet 0 → 1`, then `Authenticate`
     base 0 when there is auth;
  4. resend `RequestManager.restart()`: every mutation not yet reflected, including completed ones, since
     mutations are idempotent. In-flight actions fail with "Connection lost while action was in flight".
- **Messages.**
  - `Transition`:
    1. record `maxObservedTimestamp`;
    2. update the auth manager;
    3. apply to `RemoteQuerySet`;
    4. apply to `LocalSyncState` (journals);
    5. `requestManager.removeCompleted(ts)` resolves the mutations whose `ts ≤` the new version's ts:
       **read-your-writes**;
    6. recompute the optimistic view and notify.
  - `MutationResponse`:
    - success: records the ts. The promise stays pending until a transition reaches it;
    - failure: resolves at once, since there are no side effects to wait for.
  - `ActionResponse` resolves at once.
  - `AuthError` goes to the auth manager.
  - `FatalError` logs `[CONVEX FATAL ERROR] <msg>`, terminates the socket and throws.
- **API:**
  - `subscribe(name, args, {journal})` returns `{queryToken, unsubscribe}`;
  - `localQueryResult(name, args)`, `localQueryResultByToken`, `queryJournal`;
  - `mutation(name, args, {optimisticUpdate})`, `action(name, args)`;
  - `setAuth(fetchToken, onChange)`, `clearAuth()`;
  - `connectionState()`, `subscribeToConnectionState(cb)` (published once per microtask, only on change);
  - `addOnTransitionHandler`, `getMaxObservedTimestamp()`, `close()`.
- **Errors reach callers** as `Error("[CONVEX M(path)] <message>\n  Called by client")`, or a
  `ConvexError` with `.data` when the server sent `errorData` (`logging.ts`: `createHybridErrorStacktrace`,
  `forwardData`). A query's error is thrown by `localQueryResult`.
- **Log lines** of queries, mutations and actions are printed through the logger as
  `[CONVEX Q(path)] [LEVEL] args`.

### 1.2 Local and remote state

- **`LocalSyncState`** (`sync/local_state.ts`) holds what the client *asks for*:
  - the query set as a map from token to `{id, path, args, numSubscribers, journal}`. The token is
    `JSON.stringify({udfPath: canonical, args: convexToJson(args)})`, so identical subscriptions share one
    query id;
  - the query-set and identity versions;
  - the auth token;
  - a paused mode (for auth): modifications queue, and `resume()` sends them as one `ModifyQuerySet`.

  Unsubscribing the last subscriber sends `Remove`. Journals from `QueryUpdated`/`QueryFailed` are stored
  and re-sent on reconnect.
- **`RemoteQuerySet`** (`sync/remote_query_set.ts`) holds what the server *sent* on this socket:
  - results by query id, plus the current `StateVersion`;
  - a transition whose `startVersion` differs throws `Invalid start version: …` (gapless);
  - it prints log lines.
- **`RequestManager`** (`sync/request_manager.ts`) tracks in-flight mutations and actions. Each one is
  `NotSent`, `Requested` or `Completed(ts)`. It also tracks the requests older than the last restart, for
  backoff.

### 1.3 Optimistic updates (`sync/optimistic_updates_impl.ts`)

- An update `(localStore, args) => void` runs at once over the current results, and its changes are
  published.
- On every server transition, the view is rebuilt: server results first, then every optimistic update
  still pending, re-applied in order. An update is dropped once its mutation is reflected (completed and
  covered by a transition) or has failed.
- `localStore`:
  - `getQuery` (errors read as `undefined`);
  - `getAllQueries(query)`;
  - `setQuery(query, args, value | undefined)`, where `undefined` means "loading".
- A changed query is one whose result object changed (a shallow compare).

### 1.4 The socket (`sync/web_socket_manager.ts`)

- **States:** `disconnected → connecting → ready`, plus `stopped` (auth) and `terminated`. Pausing is a
  sub-state.
- **Reconnect** after any close, with jittered exponential backoff: `initial × 2^retries`, capped at
  16 s, ± 50 %.
  - The initial delay is 100 ms when the client itself closed (no evidence of a server problem) and
    1 s for an unknown server close.
  - A close reason that starts with a known code gets a fixed initial delay:
    - `InternalServerError`: 1 s;
    - overload codes (`TooManyConcurrentRequests`, `CommitterFullError`, `SystemTimeoutError`, …): 3 s.
  - `retries` resets only when the client "has synced past the last reconnect". That means every query and
    every request from before the restart was answered, and auth was confirmed.
  - Codes 1000, 1001, 1005 and 4040 are not reported as errors.
- **Inactivity:** with nothing received for 60 s (the server pings every 15 s), the client closes and
  reconnects (`InactiveServer`).
- The browser `online` event reconnects at once. `TransitionChunk`s are reassembled in order.
- Messages sent while not ready are not sent. `sendMessage` returns false, and the request is `NotSent`
  until the next open.

### 1.5 `ConvexClient` (`simple_client.ts`)

This is the non-React client. It wraps the base client with a paginated-query client:

- `onUpdate(query, args, callback, onError?)` returns an `Unsubscribe`, which is a function that also has
  `{unsubscribe, getCurrentValue, getQueryLogs}`. If a result is already in memory, the callback runs on
  a `setTimeout(0)`. Without `onError`, errors are thrown.
- `query(query, args)` is one-shot: it subscribes until the first result, then unsubscribes.
- `mutation`, `action`, `setAuth`, `connectionState`, `onPaginatedUpdate_experimental`, `close()`,
  `disabled`.

### 1.6 Function references (`server/api.ts`)

- `anyApi` is a `Proxy`: `api.dir.file.fn[functionName]` gives `"dir/file:fn"`, and `.default` gives
  `"dir/file"`.
- `makeFunctionReference(name)` gives `{[functionName]: name}`.
- `getFunctionName(ref)` also accepts a plain string at runtime ("a legacy thing and also a convenience").
- Types come from the generated `_generated/api.d.ts`.

## 2. What an app can observe

- **The API shape:**
  - `onUpdate`/`query`/`mutation`/`action`/`close`;
  - the `Unsubscribe` object;
  - `connectionState()` fields;
  - `optimisticUpdate` with `getQuery`/`setQuery`/`getAllQueries`.
- **Consistency:**
  - all subscribed queries change together (one transition);
  - `await mutation()` resolves only once every subscription already reflects the write;
  - a failed mutation rejects at once;
  - optimistic values show immediately and are replaced by the server's, with no flicker back to the old
    value.
- **Reconnect:**
  - subscriptions come back by themselves;
  - unanswered mutations are resent and run once (`_session_requests`);
  - actions in flight fail with `Connection lost while action was in flight`;
  - the backoff timings of §1.4.
- **Errors:** `[<PRODUCT> M(path)] <server message>\n  Called by client`, and an app error class carrying
  `.data`.
- **A `FatalError`** stops the client for good.

## 3. How bunvex does it

`@bunvex/client` gets a from-scratch implementation of §1.1–§1.5 with the same structure, so the
behavior can be checked piece by piece:

- `BaseBunvexClient`, `LocalSyncState`, `RemoteQuerySet`, `RequestManager`, `OptimisticQueryResults`,
  `WebSocketManager`;
- `BunvexClient`, the counterpart of `ConvexClient`;
- the transport is `@bunvex/protocol`'s `v1` codecs;
- values are `@bunvex/values` (`toJsonValue`/`fromJsonValue`), and app errors are `BunvexError` with
  `.data`;
- timestamps are `bigint` (Convex's are `Long`).

**Function references** (`anyApi`, `makeFunctionReference`, `getFunctionName`) go in
`@bunvex/protocol`. Both the client and the server depend on it, and the dependency rules keep the engine
out of browser bundles. `bunvex/server` re-exports them, as Convex's `convex/server` does. Their types are
generic (`FunctionReference<type, visibility, args, returns>`), so a later typed API, from codegen or
inference (ARCH-01 open decision 1), plugs in without changing the client.

**Order of work:**

1. This PR:
   - the base client, local and remote state, the request manager, optimistic updates, the socket
     manager with backoff and inactivity, and `BunvexClient`;
   - function references.
2. `@bunvex/react`: `BunvexReactClient`, `BunvexProvider`, `useQuery`, `useMutation`, `useAction`.
3. The paginated-query client and `usePaginatedQuery`.
4. The auth manager (`setAuth`), with `@bunvex/auth`, which verifies tokens on the server (STUDY-23
   step 6).
5. `BunvexHttpClient`.
6. Delete protocol v0 (`/ws`), once nothing uses it (STUDY-23 P2).

## 4. Divergences

Recorded in [docs/parity/divergences.md](../parity/divergences.md): C1–C2 under DV-03/DV-04, C3–C5 and C7 as
DV-90–DV-93, C6 under Gaps.

| # | Divergence | Why | Decision |
|---|---|---|---|
| C1 | Public names say bunvex: `BaseBunvexClient`, `BunvexClient` (later `BunvexReactClient`, `BunvexProvider`, `BunvexHttpClient`), and the option `skipDeploymentUrlCheck` | Owner's rule: no "convex" in public names | follows the rule |
| C2 | Messages say bunvex: `[BUNVEX M(path)] …`, `[BUNVEX FATAL ERROR] …`; the function-argument error says "a bunvex function" | Same rule, same message structure | follows the rule |
| C3 | Function references live in `@bunvex/protocol` and are re-exported by `bunvex/server` (Convex: `convex/server`) | Both sides need them; the client may not pull the server | **accepted** |
| C4 | No `reportDebugInfoToConvex` option and no `/api/debug_event` reporting; the client sends no `Event` messages | bunvex has no telemetry endpoint; the server ignores `Event` (P11) | **accepted** omitting |
| C5 | `getMaxObservedTimestamp()` returns a `bigint`, not a `Long` | bunvex's values use bigint for 64-bit integers | **accepted** |
| C6 | `setAuth`, paginated queries and the HTTP client come in later PRs (§3); until then `setAuth` is absent | They depend on `@bunvex/auth` and `@bunvex/react` | **accepted** this order; all landed (`setAuth` with STUDY-27), the non-React paginated client is P2 |
| C7 | The official `convex` npm package becomes a **dev dependency**, used only in tests as the protocol oracle: `ConvexClient` against a bunvex server | STUDY-23 P1 chose wire compatibility so this is possible; Apache-2.0, never shipped | **accepted** |

## 5. Tests

- **Unit tests,** one per piece, with the base client and a fake socket, as Convex's `client_node_test_helpers`:
  - a mismatched `startVersion` throws;
  - a mutation resolves only after the covering transition, and a failed one resolves at once;
  - on restart, the query set is `0 → 1` with journals, auth is re-sent, completed-but-unreflected
    mutations are re-sent, and actions fail;
  - the backoff sequence and when it resets;
  - optimistic updates are applied, re-applied on transitions, and dropped when reflected or failed.
- **Against a real bunvex server:**
  - two subscriptions change in one transition;
  - after `await mutation()` a synchronous read shows the write;
  - kill the socket between the commit and the response, and the mutation resolves once with the
    recorded value;
  - server restart and reconnect;
  - a `FatalError` terminates the client.
- **Oracle:** the official `ConvexClient` against a bunvex server runs the same scenarios: subscribe,
  update, read-your-writes, reconnect with resend, errors with `data`.

## 6. Open questions

- `unsavedChangesWarning` stays on by default in browsers, as in Convex. Is that also right for bunvex's
  dashboard (another session's work)?

## 7. The React bindings (`@bunvex/react`)

### 7.1 How Convex does it (`npm-packages/convex/src/react/`)

- **`ConvexReactClient`** (`client.ts`):
  - it creates the base client lazily, on first use, and `baseClient` injects another one;
  - it keeps listeners by query token, and a transition calls the callbacks of the tokens it changed;
  - `watchQuery(query, args, {journal})` returns `{onUpdate, localQueryResult, localQueryLogs, journal}`,
    and nothing is subscribed before the first `onUpdate`;
  - `prewarmQuery` holds a subscription for 5 s;
  - also `query`, `mutation`, `action`, `connectionState`, `subscribeToConnectionState`, `setAuth`,
    `clearAuth`, `setAdminAuth` and `close`.
- **`ConvexProvider` / `useConvex`:** a React context.
- **`useQuery(query, args | "skip")`:**
  - it goes through `useQueries` with one entry, memoized by the function name and the args' JSON;
  - it returns `undefined` while loading and throws a failed query's error to the error boundary.
- **`useQuery_experimental({query, args, throwOnError})`:** returns `{status: "pending" | "success" |
  "error"}`.
- **`useQueries`** (`use_queries.ts` and `queries_observer.ts`):
  - a `QueriesObserver` holds one watch per identifier and replaces a watch when its function or args
    change;
  - results are read in render (`getLocalResults`), and failures come back as `Error` values;
  - subscribing happens in the subscription's `subscribe`, after render.
- **`useSubscription`** (`use_subscription.ts`) keeps a component's value in step with a store, safely in
  concurrent React. It re-checks the value right after subscribing. Convex's own comment says it "could
  probably be replaced with `useSyncExternalStore()`".
- **`useMutation(ref)`** returns a function that is stable per client and name. `.withOptimisticUpdate(fn)`
  returns a new one, and a second call throws `Already specified optimistic update for mutation <name>`.
- **`useAction(ref)`** and **`useConvexConnectionState()`**.
- **Guards:**
  - a hook outside the provider throws "Could not find Convex client! `useQuery` must be used in the React
    component tree under `ConvexProvider`…";
  - a React event passed as the arguments throws (`assertNotAccidentalArgument`).
- **Consistency:** one transition calls every changed query's listeners together, so React renders them
  in one pass. Two queries never disagree on screen.

### 7.2 How bunvex does it

`@bunvex/react` is `BunvexReactClient`, `BunvexProvider`, `useBunvex`, `useQuery` (with `"skip"`),
`useQuery_experimental`, `useQueries`, `useMutation` (with `withOptimisticUpdate`), `useAction` and
`useBunvexConnectionState`, with the same structure (client, observer, hooks). `usePaginatedQuery`, the
auth helpers and hydration (`usePreloadedQuery`) come with the paginated client, `@bunvex/auth` and
`@bunvex/nextjs`.

Tests run against a real server in `packages/sync-e2e/react`, in their own process with a DOM
(happy-dom, as the UI packages do):

- loading, value and changes;
- **read-your-writes in the rendered page** after `await mutate()`;
- two queries a mutation changes render together, never one without the other;
- `"skip"`;
- error boundary with `.data`;
- the optimistic guess renders at once, and only one update is allowed per mutation;
- `useAction`, the connection state, and the provider guard;
- `useSubscription` re-reads after subscribing.

### 7.3 Divergences

Recorded in [docs/parity/divergences.md](../parity/divergences.md): R1 under DV-03, R2 as DV-95, R3 under Gaps.

| # | Divergence | Why | Decision |
|---|---|---|---|
| R1 | Names say bunvex: `BunvexReactClient`, `BunvexProvider`, `useBunvex`, `useBunvexConnectionState`; the guard messages name `BunvexProvider` and drop the docs link | Owner's naming rule | follows the rule |
| R2 | `useSubscription` is built on `useSyncExternalStore` (Convex: a hand-written state + effect hook) | The replacement Convex's own comment suggests; the same observable behavior (value on first render, re-read after subscribing, one render per change) | **accepted** |
| R3 | `usePaginatedQuery`, the auth helpers and `usePreloadedQuery` come in later PRs | They need the paginated client, `@bunvex/auth` and `@bunvex/nextjs` | **accepted** this order |

## 8. Paginated queries (`usePaginatedQuery`)

### 8.1 How Convex does it (`react/use_paginated_query.ts`, `browser/sync/pagination.ts`)

- **Pages.**
  - Each loaded page is its own subscription of the query with `paginationOpts: {numItems, cursor, id}`.
  - The first page starts at `cursor: null`, and `loadMore(n)` adds a page at the last page's
    `continueCursor`.
  - `id` comes from a module-wide counter, one per hook instance, so two hooks never share a page.
  - The server pins each page's end through the query journal, so pages grow or shrink with the data but
    never leave a gap or overlap.
- **Splits.**
  - A page is split at its `splitCursor` when the server marks it `SplitRecommended` or `SplitRequired`,
    or when it holds more than twice `initialNumItems`.
  - It becomes two pages, `(cursor, splitCursor]` and `(splitCursor, continueCursor]`, which replace it
    once both have loaded.
  - While a page is `SplitRequired`, the results stop before it and the status is `LoadingMore`.
- **Status:**
  - `LoadingFirstPage` before any page;
  - `LoadingMore` while a page is loading;
  - `CanLoadMore`;
  - `Exhausted` once the last page `isDone`.

  `loadMore` is a no-op outside `CanLoadMore` and works once per render.
- **`InvalidCursor`:** an error whose message contains it (or a Convex system error carrying
  `paginationError: "InvalidCursor"`) resets to the first page with a warning. Other errors are thrown.
- **New arguments** (compared by JSON) or a new function reset the state. `"skip"` renders
  `LoadingFirstPage` with no subscription.
- **Optimistic helpers:**
  - `optimisticallyUpdateValueInPaginatedQuery`: maps every loaded page of the same args;
  - `insertAtTop`: first page, once loaded;
  - `insertAtBottomIfLoaded`: only into a done last page, otherwise the item would pop out;
  - `insertAtPosition`: sorted, per group of pages, where a group is same args plus pagination `id`.
- **The server contract** this relies on (`async_syscall.rs` `read_page_from_query`): a page with an end
  cursor (explicit, or from the journal) answers that end cursor as its `continueCursor`, even when a read
  limit stopped it early (`end_cursor.or_else(query.cursor())`).

### 8.2 How bunvex does it

`@bunvex/react` exports `usePaginatedQuery`, the four helpers and `resetPaginationId`, with the same
state machine over `useQueries`. `@bunvex/client` exports the `PaginationOptions` and `PaginationResult`
shapes and `asPaginationResult`.

**A server fix found by these tests.** bunvex's `paginate` (STUDY-17) answered "after the last row read"
for a pinned page stopped by `maximumRowsRead`, so the split halves lost the rest of the page. It now
answers the pinned end, as Convex does. There is a regression test in `core/test/paginate.test.ts`.

The tests (`packages/sync-e2e/react/pagination.test.tsx`) cover:
- first page, `loadMore`, and exhaustion;
- pages growing with new data without a gap or duplicate;
- a page that outgrows its read limit being split until whole;
- `"skip"`;
- `insertAtTop`.

### 8.3 Divergences

Recorded in [docs/parity/divergences.md](../parity/divergences.md): P1 as DV-96 (decided), P2 under Gaps.

| # | Divergence | Why | Decision |
|---|---|---|---|
| P1 | The server's `InvalidCursor` for a cursor of another query is a `BunvexError` with `{isBunvexSystemError: true, paginationError: "InvalidCursor"}` (Convex: `isConvexSystemError`); the client recognizes it by that data or by its message, as Convex's | Owner's naming rule for the key; it closes STUDY-17 D4. The official client still recognizes it by the message | **accepted**: option (a) |
| P2 | `onPaginatedUpdate_experimental` (`BunvexClient`) and `watchPaginatedQuery` (`BunvexReactClient`), the non-React paginated client, come later | `usePaginatedQuery` does not use them, in Convex either | **accepted** later |

## 9. The HTTP client (`BunvexHttpClient`)

### 9.1 How Convex does it (`browser/http_client.ts`, `crates/local_backend/src/public_api.rs`)

- **Calls.**
  - `query`, `mutation` and `action` `POST /api/{query,mutation,action}` with
    `{path, format: "convex_encoded_json", args: [args]}`.
  - Headers:
    - `Content-Type: application/json`;
    - `Convex-Client: npm-<version>`;
    - `Authorization: Bearer <jwt>`, or `Convex <admin key>[:<base64 identity>]` for admin.
- **Responses.**
  - A success reads `value`, printing the `logLines` unless `setDebug(false)`.
  - A function error (HTTP 200, or 560 on the hosted service) throws `ConvexError(errorMessage)` with
    `.data` when there is `errorData`, else `Error(errorMessage)`. The message has no product prefix.
  - Any other non-OK status throws the response text.
- **Mutations** from one client run one at a time, in call order, unless `{skipQueue: true}`.
- **`consistentQuery`** fetches `POST /api/query_ts` once, `{ts}` as base64 u64, then runs every such query
  with `POST /api/query_at_ts {path, args, ts}`, so they all read one snapshot.
- **Other options:**
  - `setFetch` (global), the constructor's `fetch`, and `setFetchOptions({cache})`;
  - `url`, and `backendUrl()` (deprecated);
  - `function(name, componentPath, args)` calls `/api/function`, for components.

### 9.2 How bunvex does it

- **`BunvexHttpClient`** has all of the above except `function`.
- **The server gains `POST /api/query_ts`**, which answers the visible ts encoded as the sync protocol
  does (µs × 1000, base64 u64).
- **It also gains `POST /api/query_at_ts`,** which runs the query at that snapshot, uncached. A ts ahead
  of the server's is a 400 `InvalidTimestamp`.
- **The official `ConvexHttpClient`** works against bunvex: query, mutation, `consistentQuery`, and errors
  with `data`.

### 9.3 Divergences

Recorded in [docs/parity/divergences.md](../parity/divergences.md): H1 under DV-03, H2 as DV-97, H4 as DV-98, H3 under
Gaps.

| # | Divergence | Why | Decision |
|---|---|---|---|
| H1 | The client header is `Bunvex-Client: npm-<version>`, and no `format` field is sent (Convex: `Convex-Client`, `format: "convex_encoded_json"`) | Owner's naming rule; the server ignores both and always answers encoded JSON | follows the rule |
| H2 | Admin auth is sent as `Authorization: Bunvex <key>` (Convex: `Convex <key>`) | Same rule. The server verifies no admin key yet, so the scheme is decided now for when it does | **accepted** |
| H3 | No `function(name, componentPath, args)` / `/api/function` | Components are phase 4 | **accepted** later |
| H4 | `query_at_ts` with a ts ahead of the server's answers 400 `InvalidTimestamp` | Convex's behavior there comes from its database layer; bunvex has only one node, so its own clients never send one | **accepted** |

