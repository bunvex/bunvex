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
  class), queries and pages. Indexed and filtered fields take values from small pools, so ranges meet real
  documents, ties and mixed types. Documents are named by position, so a failure shrinks to a small program.
- `harness/compare.ts`: what is normalised before comparing (ids by first appearance, `_creationTime` by
  rank, request ids and stacks, a page's cursors) and the wording rewrites a decided divergence allows
  (DV-04).
- `test/fixed.test.ts`: fixed programs, one per shape a bug has taken or could take.
- `test/generated.test.ts`: `DIFF_RUNS` generated programs (25 by default), both backends started once and
  reset before each program. `DIFF_SEED` replays a run. A difference is shrunk, written to
  `.cache/failures/last.json` (the program and the differences, ready to become a fixed program) and fails
  the test with its seed.

A difference is a bug (fixed with a regression test in `core` or `server`) or a decided divergence (one
rewrite in `compare.ts`, with its DV id). Never anything else.
