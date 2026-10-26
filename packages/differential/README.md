# @bunvex/differential

Differential tests ([STUDY-122](../../docs/study/STUDY-122-differential-testing.md)): the same app, the same
calls, on Convex's local backend (the oracle) and on bunvex's; every answer and the final data must match.
Tests only, never published.

```sh
packages/differential/scripts/download-convex-backend.sh   # once: the pinned Convex binary into .cache/
bun run test:differential
```

`CONVEX_BACKEND_BIN` points at another binary. Without one the tests are skipped with a note. Convex's
backend is always started with `--disable-beacon`.

- `app/`: the app, written for this harness: operations as data (`ops:apply`), reads (`ops:read`, with an
  index range, a filter, an order, and `collect` / `take` / `first` / `unique`), pages (`ops:page`), a dump of
  every table (`ops:dump`) and `ops:reset`. JSON has no `undefined`: a program writes `{ $undefined: true }`.
  Each backend gets it deployed by its own CLI, its imports rewritten for bunvex.
- `harness/backends.ts`: starts each backend fresh, deploys the app, calls it over `/api/query` and
  `/api/mutation`. A test starts both with `startAll([startConvex(…), startBunvex(…)])`, not `Promise.all`: when one
  start fails, the others are waited for and stopped, so a failed `beforeAll` leaves no backend running
  (`test/setup-failure.test.ts`). `harness/preload.ts` stops, once the run ends, every backend a test left running.
- `harness/runner.ts`: a program (calls, ids as references, a page's cursor named for a later page), played on
  one backend or compared on both.
- `harness/generate.ts`: generated programs (fast-check): writes and reads inside one mutation (the #410
  class), queries and pages; nested `runQuery` / `runMutation` (caught or not), actions (queries, mutations
  and failures, each its own transaction), application errors with data, validated arguments and results,
  and writes past the limits (phase 3). Indexed and filtered fields take values from small pools, so ranges meet real
  documents, ties and mixed types. Documents are named by position, so a failure shrinks to a small program.
- `harness/compare.ts`: what is normalised before comparing (ids by first appearance, `_creationTime` by
  rank, request ids and stacks, a page's cursors) and the wording rewrites a decided divergence allows
  (DV-04).
- `test/fixed.test.ts`: fixed programs, one per shape a bug has taken or could take.
- `test/cross-open.test.ts` (STUDY-133 PR 9): a store each binary wrote, opened by the other (same SQLite file
  and storage, the app of `cross-open-app/` redeployed by its CLI), read back by every kind of index, written,
  and read back by the first. Local only: the nightly does not run it.
- `test/backfill-progress.test.ts` (STUDY-174 S1): a push adds an index to a table with documents (the app of
  `backfill-progress-app/`); once backfilled, the `_index_backfills` row is read from each store's SQLite file and
  compared: the count, the table's total, the cursor. Local only.
- `test/schemas-overwritten.test.ts` (STUDY-187 X3): the app of `schemas-overwritten-app/` deployed with four
  schemas in a row (one its document does not match, the last one twice); the `_schemas` rows are read from each
  store's SQLite file and compared, by creation time: the replaced ones `overwritten`, the refused one `failed`, the
  last `active`. Local only.
- `test/component-store.test.ts` (STUDY-152 steps 1–2): a store Convex writes with the components of
  `component-store-app/` (a `counter` component, mounted twice, with a table of the root's name), opened by bunvex
  (the root's tables only, read, written, listed by `data`), then by Convex again (its components intact). Run by
  the nightly too.
- `test/component-env.test.ts` (STUDY-171 §15.7, Q-PR7-1): a component's `process.env` on both, from the app of
  `component-env-app/` (`envc` mounted with its variables bound, and again without): called from the app's query,
  mutation and action, from one component into another and back into the app through handles, before and after the
  app's variables are set, a bad name included; every value compared. Local only.
- `test/component-definitions.test.ts` (STUDY-153 PR 1): the same `defineApp` / `defineComponent` / `use` /
  `componentsGeneric` calls with Convex's package and bunvex's, their `export()` and errors compared. No backend
  needed; run by the nightly too.
- `test/log-stream-egress.test.ts` (STUDY-187 X6): a webhook log stream on both, until the first
  `log_stream_egress` event (Convex's fixed 60 s, so about a minute): its fields, and its bytes are the bodies sent
  before it, the connection test left out. Local only.
- `test/action-fetch.test.ts` (STUDY-142): an action's `fetch` (the app of `fetch-app/`) to local targets on
  both: how a request fails, redirects, the 407 refusal, aborts, the default `User-Agent`. Local only.
- `test/unhandled-rejections.test.ts` (STUDY-171 §13): queries, mutations and actions of `rejections-app/` that leave
  a promise rejected with no handler, on Convex's backend and on bunvex's under `BUNVEX_FUNCTION_SANDBOX=process` (under
  `vm` it is printed and the call goes on, DV-528): the status, the error's first line, its data, the value, the log
  lines, whether the error has the app's frames, and what the writes left. Local only.
- `test/caller-realm.test.ts` (STUDY-171 §TBD, Q-PR7-2): a nested call's error as the caller of `caller-realm-app/`
  catches it (query → query, mutation → query, action → mutation, and the app → its `thrower` component), on both and
  on bunvex under `process` too: `instanceof Error`, `instanceof` the application class, its prototype, constructor,
  name, message, data and own keys. Local only.
- `test/dynamic-import.test.ts` (STUDY-188 §X14): a dynamic `import()` in the functions of `dynamic-import-app/` on
  both, and on bunvex under `process` too: an action importing a sibling module and a chunk only it reaches,
  specifiers resolved against the importing module, missing paths, a module that throws while loading (it fails the
  action even inside `try`), a query, a mutation and an action's nested query refused, a V8 action importing a
  `"use node"` module (an internal error, HTTP 500), and a `"use node"` action importing as Node does (`vm` only).
  Local only.
- `test/unawaited-operations.test.ts` (STUDY-143): the unawaited-operations warning of the actions and HTTP
  actions of `unawaited-app/` on both, a timeout included (`env` sets `V8_ACTION_USER_TIMEOUT_SECS` on both).
  Local only.
- `test/http-content-type.test.ts` (STUDY-31 §8): an HTTP action response's implicit headers on both, from the app
  of `http-headers-app/` — every body type (string, number, URLSearchParams, FormData, typed and untyped Blob,
  `Response.json`, bytes, a 1 MiB string, streams, no body), with and without an explicit type or length, by GET and
  HEAD, read off a raw socket; the framing each backend picks (DV-483) asserted per backend. Local only.
- `test/http-action-result.test.ts` (STUDY-31 §9): a handler of `http-results-app/` that returns something other
  than a Response (an object, `undefined`, `null`, a string, a number, a Response-like object), on both: the 500, the
  log entries (the Completion's error) and the route's app metrics compared. Local only.
- `test/http-body-error.test.ts` (STUDY-31 §10): streamed bodies of `http-body-errors-app/` that fail in the handler's
  turn or after the head, on both, read off a raw socket: the status, the body, a clean end, the 500, the log entries
  and the route's app metrics compared. Local only.
- `test/http-internal-error.test.ts` (STUDY-31 §12): a system error in an HTTP action of `http-internal-app/` on both:
  the internal error's status, type and body, and the run's log entries, compared whole; a nested call's system error
  spelled out per backend (they differ, STUDY-31 §12.4). Local only.
- `test/http-action-log-route.test.ts` (STUDY-31 §7): what an HTTP action is logged as, on both — requests to the
  exact, prefix and failing routes of `http-routes-app/` and to paths no route matches; the answers, the function log
  stream's entries (names, statuses, errors, lines) and the app metrics per route compared. Local only.
- `test/external-packages.test.ts` (STUDY-148): `node.externalPackages` with `"*"` (the app of `external-app/`, its
  Node module pushed by `later/ext.ts`), installed by each deployment from a registry the test serves: a failed
  install's 400, `start_push`'s id and its reuse, the actions' answers; the decided differences (a packaged binary's
  mode, the server's own variables) asserted on each side. Local only, and only with `npm` on the machine.
- `test/push-table-numbers.test.ts` (STUDY-161 §7): the numbers a push gives new tables (the app of `push-order-app/`:
  tables with and without indexes of each kind, mixed case), then a second push adding tables, on both:
  `_system/frontend/getTableMapping` compared. Local only.
- `test/dashboard-data.test.ts` (STUDY-149 PR 2): the dashboard's Data reads on both, as an admin —
  `_system/frontend/getTableMapping`, `paginatedTableDocuments` (field, type and index filters, refusals,
  cursors), `indexes`, `tableSize`, `listById`, `getById` and `GET /api/get_indexes`. Local only.
- `test/dashboard-indexes.test.ts` (STUDY-149 "Index list"): `_system/frontend/indexes` and `GET /api/get_indexes` on
  both for the app of `indexes-app/` (database, search and vector indexes, staged and not), once no staged index is
  still building. Local only.
- `test/dashboard-search-filter.test.ts` (STUDY-163 §5): `paginatedTableDocuments` with a search index's filter on
  both, for the app of `indexes-app/`: the documents found (as sets) and every refusal. Local only.
- `test/dashboard-functions.test.ts` (STUDY-149 PR 4): the dashboard's Functions, runner and Settings reads on both,
  from the app of `functions-app/` — `_system/frontend/modules:*`, `components:list`, `getVersion`, the URLs
  (DV-474), `listEnvironmentVariables`, `latestExport`, `snapshotImport:list`; a function run over the socket as an
  admin and acting as a user; custom test queries (`/api/run_test_function`). Local only.
- `test/dashboard-cors.test.ts` (STUDY-67 §9): the dashboard's routes, the health and meta routes and some CLI routes
  from another origin on both: each preflight (the admin key's and the client's headers asked) compared whole, and
  each request's CORS headers (`vary` included). Local only.
- `test/storage-ids.test.ts`: a storage id's errors from every storage method in a query, a mutation and an
  action (the app of `storage-app/`): another table's id, ids that do not parse, UUIDs. Local only.
- `test/nested-errors.test.ts`: a nested call's error from a V8 and a "use node" action (the app of `nested-errors-app/`):
  a query, a mutation, a V8 and a Node action that throw, the error uncaught (the client's message: the callee's
  display, then the action's own `await`) or caught (its name, message and data). Local only.
- `test/run-missing.test.ts` (STUDY-188 §X21): a function that is not there or of another kind, called, scheduled or
  taken a handle of from a V8 action, a "use node" action and a mutation of `run-missing-app/` (a missing module or
  export, an internal function, the wrong kind, the `cmp` component's missing or internal export, a missing child): the
  error uncaught and caught compared. Local only.
- `test/node-frames.test.ts` (STUDY-188 §X11, DV-482 as amended): https-proxy-agent 9.1.0 bundled into a "use node"
  action of `node-frames-app/`: an https request through it made (agent-base finds `node:https:` in the stack), and the
  stack an agent sees when a request reads its protocol (its header and Node's frames above the app's call, positions
  aside). Local only.
- `test/paginate-args.test.ts`: `paginate`'s options (the client's checks, the `queryPage` syscall's serde
  messages in their field order, its own checks), a query's `limit` that is not a usize and a cursor that does
  not parse, from the app of `paginate-app/`; then the system functions' own argument errors, with an admin
  key. Local only.
- `test/generated.test.ts`: `DIFF_RUNS` generated programs (25 by default), both backends started once and
  reset before each program. Besides the answers and the final data, each program's function log is compared
  (STUDY-174 §5.2): per completed call its kind, function, cache hit, failure and usage counters (documents,
  bytes, index rows), read from `/api/stream_function_logs` after the program's last call. `DIFF_SEED` replays
  a run. A difference is shrunk, written to
  `.cache/failures/last.json` (the program and the differences, ready to become a fixed program) and fails
  the test with its seed.

## Every night

`.github/workflows/differential-nightly.yml` runs `scripts/nightly.sh` against Convex's released backend,
downloaded at run time:
- the fixed programs;
- a store with components as Convex writes it, and components' definitions (`component-store`,
  `component-definitions`);
- what the log stream says about each call (STUDY-174 Q5): the cache's hits, misses and expiry
  (`cache-metadata`), the read-limit warning and error (`read-count`), unawaited operations
  (`unawaited-operations`) and an HTTP action's log lines (`http-action-log-route`);
- then batches of `DIFF_RUNS` generated programs (200), each from a fresh seed, for `MINUTES` (20).

Every seed is in the log. On a difference:
- the run fails and uploads `.cache/failures/`;
- it opens an issue, or comments on the open one, with the reproduce line and the shrunk program.

Locally: `MINUTES=1 scripts/nightly.sh`. A pull request that changes the harness or the workflow runs it for
one minute.

## Triage

A difference is a bug (fixed with a regression test in `core` or `server`) or a decided divergence (one
rewrite in `compare.ts`, with its DV id). Never anything else.

- **A bug:** add the shrunk program to `test/fixed.test.ts`, fix bunvex with a test of its own in `core` or
  `server`, and close the issue with the fix.
- **A decided divergence:** one rule in `compare.ts`, with its DV id.
