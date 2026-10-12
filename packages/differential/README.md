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
- `test/action-fetch.test.ts` (STUDY-142): an action's `fetch` (the app of `fetch-app/`) to local targets on
  both: how a request fails, redirects, the 407 refusal, aborts, the default `User-Agent`. Local only.
- `test/unawaited-operations.test.ts` (STUDY-143): the unawaited-operations warning of the actions and HTTP
  actions of `unawaited-app/` on both, a timeout included (`env` sets `V8_ACTION_USER_TIMEOUT_SECS` on both).
  Local only.
- `test/external-packages.test.ts` (STUDY-148): `node.externalPackages` with `"*"` (the app of `external-app/`, its
  Node module pushed by `later/ext.ts`), installed by each deployment from a registry the test serves: a failed
  install's 400, `start_push`'s id and its reuse, the actions' answers; the decided differences (a packaged binary's
  mode, the server's own variables) asserted on each side. Local only, and only with `npm` on the machine.
- `test/dashboard-data.test.ts` (STUDY-149 PR 2): the dashboard's Data reads on both, as an admin —
  `_system/frontend/getTableMapping`, `paginatedTableDocuments` (field, type and index filters, refusals,
  cursors), `indexes`, `tableSize`, `listById`, `getById` and `GET /api/get_indexes`. Local only.
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
