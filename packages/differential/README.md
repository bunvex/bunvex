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
  `/api/mutation`.
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
- `test/component-store.test.ts` (STUDY-152 steps 1–2): a store Convex writes with the components of
  `component-store-app/` (a `counter` component, mounted twice, with a table of the root's name), opened by bunvex
  (the root's tables only, read, written, listed by `data`), then by Convex again (its components intact). Run by
  the nightly too.
- `test/component-definitions.test.ts` (STUDY-153 PR 1): the same `defineApp` / `defineComponent` / `use` /
  `componentsGeneric` calls with Convex's package and bunvex's, their `export()` and errors compared. No backend
  needed; run by the nightly too.
- `test/action-fetch.test.ts` (STUDY-142): an action's `fetch` (the app of `fetch-app/`) to local targets on
  both: how a request fails, redirects, the 407 refusal, aborts, the default `User-Agent`. Local only.
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
- `test/paginate-args.test.ts`: `paginate`'s options (the client's checks, the `queryPage` syscall's serde
  messages in their field order, its own checks), a query's `limit` that is not a usize and a cursor that does
  not parse, from the app of `paginate-app/`; then the system functions' own argument errors, with an admin
  key. Local only.
- `test/generated.test.ts`: `DIFF_RUNS` generated programs (25 by default), both backends started once and
  reset before each program. `DIFF_SEED` replays a run. A difference is shrunk, written to
  `.cache/failures/last.json` (the program and the differences, ready to become a fixed program) and fails
  the test with its seed.

## Every night

`.github/workflows/differential-nightly.yml` runs `scripts/nightly.sh` against Convex's released backend,
downloaded at run time:
- the fixed programs;
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
