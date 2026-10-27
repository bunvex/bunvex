# Batch worker

`@bunvex/batch-worker` running two named workers on one component, after Convex's example of
[`@convex-dev/batch-worker`](https://github.com/get-convex/batch-worker):

- **Work queue** ([example.ts](bunvex/example.ts)): batch and sum events, deleting what was processed.
- **Live scoreboard** ([aggregates.ts](bunvex/aggregates.ts)): one writer folds scores into per-team totals, so
  scorers never conflict.

Both resume from a `v.commitTs()` cursor that the work query returns: the component commits it with the batch and
passes it back, so each scan starts where the last one stopped. Convex's third worker, rate-limited LLM batches, comes
with `@bunvex/rate-limiter`.

## Run

```sh
bun install
bun run dev
```

## Test

```sh
bun test examples/batch-worker
```
