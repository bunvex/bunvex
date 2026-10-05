# @bunvex/differential

Differential tests ([STUDY-129](../../docs/study/STUDY-129-differential-testing.md)): the same app, the same
calls, on Convex's local backend (the oracle) and on bunvex's; every answer and the final data must match.
Tests only, never published.

```sh
packages/differential/scripts/download-convex-backend.sh   # once: the pinned Convex binary into .cache/
bun run test:differential
```

`CONVEX_BACKEND_BIN` points at another binary. Without one the tests are skipped with a note. Convex's
backend is always started with `--disable-beacon`.

- `app/`: the app, written for this harness: operations as data (`ops:apply`), reads (`ops:read`) and a dump
  of every table (`ops:dump`). Each backend gets it deployed by its own CLI, its imports rewritten for bunvex.
- `harness/backends.ts`: starts each backend fresh, deploys the app, calls it over `/api/query` and
  `/api/mutation`.
- `harness/runner.ts`: a program (calls, ids as references), played on one backend or compared on both.
- `harness/compare.ts`: what is normalised before comparing (ids by first appearance, `_creationTime` by
  rank, request ids and stacks) and the wording rewrites a decided divergence allows (DV-04).
- `test/fixed.test.ts`: fixed programs, one per shape a bug has taken or could take.

A difference is a bug (fixed with a regression test in `core` or `server`) or a decided divergence (one
rewrite in `compare.ts`, with its DV id). Never anything else.
