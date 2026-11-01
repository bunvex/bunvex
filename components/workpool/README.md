# @bunvex/workpool

A pool of work for bunvex: actions, mutations and queries enqueued from your functions and run at most
`maxParallelism` at a time, with retries and backoff for actions, an `onComplete` mutation when each job ends,
cancelation, status, and recovery of jobs whose run died. It is bunvex's version of
[`@convex-dev/workpool`](https://github.com/get-convex/workpool) and **matches `@convex-dev/workpool` 0.4.14** (as of
its commit `7fde769`, whose report pages with the built-in `.paginate()`): the same client API, component name
(`workpool`), tables and indexes, function paths, arguments, results, defaults, limits, messages and log events, so an
app moves by renaming its imports and a Convex export of the component's data imports unchanged.

Its loop runs on [`@bunvex/batch-worker`](../batch-worker), mounted as its child.

## Install

```sh
bun add @bunvex/workpool
```

```ts
// bunvex/bunvex.config.ts
import { defineApp } from "@bunvex/server";
import workpool from "@bunvex/workpool/bunvex.config.js";

const app = defineApp();
app.use(workpool, { name: "emailWorkpool" }); // one pool per mount; brings its batch worker
app.use(workpool, { name: "scrapeWorkpool" });
export default app;
```

## Use

```ts
import { vOnCompleteArgs, Workpool } from "@bunvex/workpool";
import { v } from "@bunvex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";

const pool = new Workpool(components.emailWorkpool, {
  maxParallelism: 10,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
});

export const signUp = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const userId = await ctx.db.insert("users", { email });
    await pool.enqueueAction(ctx, internal.email.sendWelcome, { email }, {
      onComplete: internal.email.welcomeSent,
      context: { userId },
    });
  },
});

export const welcomeSent = internalMutation({
  args: vOnCompleteArgs(v.object({ userId: v.id("users") })),
  handler: async (ctx, { workId, context, result }) => {
    if (result.kind === "failed") console.error(`welcome email to ${context.userId} failed: ${result.error}`);
  },
});
```

| Method | What it does |
|---|---|
| `enqueueAction(ctx, fn, args, options?)`, `enqueueMutation`, `enqueueQuery` | queues one job: its `WorkId` |
| `enqueueActionBatch(ctx, fn, argsArray, options?)`, `enqueueMutationBatch`, `enqueueQueryBatch` | queues one job per item: their ids, in order |
| `cancel(ctx, id)`, `cancelAll(ctx, { limit? })` | a job not started never starts; a running one finishes and is not retried |
| `status(ctx, id)`, `statusBatch(ctx, ids)` | `{ state: "pending" \| "running", previousAttempts }` or `{ state: "finished" }` |
| `defineOnComplete({ context?, returnValue?, handler })` | an internal mutation with `vOnCompleteArgs`, to pass as `onComplete` |

- **Options of a job:** `onComplete` (a mutation, called with `{ workId, context, result }` once the job ends),
  `onCompleteExcludeKinds` (the results not to call it for: `"success"`, `"failed"`, `"canceled"`), `context`,
  `runAt` or `runAfter`, `name` (logged), and `retry` for actions (`true`, `false` or a `RetryBehavior`).
- **Retries.** Only actions are retried by the client: a failed attempt waits `initialBackoffMs * base^(n - 1)`, with
  a jitter of ±50%, and an intermediate failure never calls `onComplete`. Throw `NonRetryableError` to end a job at
  once.
- **Options of the pool:** `maxParallelism` (default 10, at most 200; 0 pauses it), `logLevel` (`REPORT` by default;
  `INFO` adds a JSON event per job enqueued, started and completed; `DEBUG` adds the loop's steps),
  `retryActionsByDefault` and `defaultRetryBehavior`. The class applies no defaults: an option left unset keeps what
  the pool has stored, and each `enqueue*` stores those that are set.
- **Recovery.** A job running for more than five minutes is checked against the scheduler about once a minute; one
  whose run failed, was canceled from the dashboard or is gone fails, and goes through its retries.
- **Limits.** Arguments and an `onComplete` context are each at most 1 000 000 bytes; above 8 000 they are kept in a
  table of their own.

### Logs

At `REPORT` the pool writes one JSON line a minute while it works, for a log pipeline to parse:

```json
{ "component": "workpool", "event": "report", "completed": 12, "succeeded": 10, "failed": 1, "retries": 1,
  "canceled": 0, "lastReportTs": 1793353730827, "running": 3, "backlog": 0, "failureRate": 0.1667,
  "permanentFailureRate": 0.0909 }
```

At `INFO`, `enqueued`, `started` and `completed` events too (`completed` carries `status`: `success`, `failed`,
`canceled` or `retrying`).

### Maintenance

From the dashboard or the CLI: `kick:forceKick` restarts a stuck loop; `stats:diagnostics` and `stats:running`
describe the queue; `danger:clearPending` and `danger:clearOldWork` delete old jobs without calling their
`onComplete`.

## Test

```ts
import { bunvexTest } from "@bunvex/testing";
import { register } from "@bunvex/workpool/test";

const t = bunvexTest();
register(t); // mounted as `workpool`, with its batch worker
```

## Differences from Convex's package

- Its names are bunvex's: `bunvex.config.js` for `convex.config.js`, and `NonRetryableError` is a `BunvexError`
  whose data carries `__bunvexWorkpoolNonRetryable` (Convex's `ConvexError`, `__convexWorkpoolNonRetryable`).
- The functions and aliases Convex keeps only for jobs scheduled by older versions are not here: `loop:main`,
  `loop:updateRunStatus`, `worker:runActionWrapper`, and the deprecated `resultValidator`, `workIdValidator` and
  `vOnCompleteValidator` (use `vResult`, `vWorkId` and `vOnCompleteArgs`).
- `loop:getBatch` declares the batch worker's result validator, whose work branch has an optional `cursor`.
- The `./test` entry registers the component with `@bunvex/testing` (no `modules`: the harness pushes the
  component's directory, and its child comes with it).
