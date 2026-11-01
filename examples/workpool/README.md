# Workpool

`@bunvex/workpool`, bunvex's version of [`@convex-dev/workpool`](https://github.com/get-convex/workpool), with three
pools of one component ([tasks.ts](bunvex/tasks.ts)):

- **big** runs up to 20 jobs at once, and retries a failed action up to three times with a growing wait;
- **small** runs 3 at once and gives up at the first failure;
- **serial** runs one at a time, in the order they were enqueued.

Start jobs on any pool, set how often they fail, and watch each pool keep to its limit. Every job's `onComplete`
records how it ended (succeeded, failed for good, or canceled); "Cancel the rest" cancels what has not ended, and a
job that had not started never runs.

## Run

```sh
bun install
bun run dev
```

## Test

```sh
bun test examples/workpool
```
