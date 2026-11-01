# @bunvex/batch-worker

A loop that drains your own table in batches: a query picks the next batch, a mutation processes it, both in one
transaction, and the loop reschedules itself until the queue is empty. It is bunvex's version of
[`@convex-dev/batch-worker`](https://github.com/get-convex/batch-worker) and **matches `@convex-dev/batch-worker`
0.3.6**: the same client API, component name (`batchWorker`), tables and index, function paths, arguments, results,
defaults and log events, so an app moves by renaming its imports and a Convex export of the component's data imports
unchanged.

## Install

```sh
bun add @bunvex/batch-worker
```

```ts
// bunvex/bunvex.config.ts
import { defineApp } from "@bunvex/server";
import batchWorker from "@bunvex/batch-worker/bunvex.config.js";

const app = defineApp();
app.use(batchWorker);
export default app;
```

## Use

Insert work into your own table, then `ping`. The work query returns the next batch, or `idle`. Alongside a batch it
may return a `cursor` saying how far it got: the component commits it with the batch and passes it back as
`args.cursor`, so the next scan resumes there. `defineBatchWorkerValidators` gives the query's and the mutation's
validators from one declaration, so they agree.

```ts
import { defineBatchWorkerValidators, ping } from "@bunvex/batch-worker";
import { v } from "@bunvex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";

export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    // `db.vars.commitTs` becomes, at commit, an int64 in commit order: a safe cursor.
    await ctx.db.insert("events", { value, insertedAt: ctx.db.vars.commitTs });
    await ping(ctx, components.batchWorker, {
      name: "events", // one independent queue per name
      workQuery: internal.events.getBatch,
      workerMutation: internal.events.processBatch,
    });
  },
});

const { vQueryArgs, vQueryReturns, vMutationArgs } = defineBatchWorkerValidators({
  batch: { events: v.array(v.object({ id: v.id("events"), value: v.number() })) },
}); // the cursor is a commit timestamp unless `cursor` is given

export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("insertedAt", (q) => q.gte("insertedAt", cursor ?? 0n))
      .take(10);
    if (events.length === 0) return { kind: "idle" as const }; // or { kind: "idle", timeoutMs: 30_000 }
    return {
      kind: "work" as const,
      batch: { events: events.map((e) => ({ id: e._id, value: e.value })) },
      cursor: events.at(-1)!.insertedAt,
    };
  },
});

export const processBatch = internalMutation({
  args: vMutationArgs,
  handler: async (ctx, { events }) => {
    for (const { id } of events) {
      // … the work …
      await ctx.db.delete("events", id); // the worker cleans up what it processed
    }
    // Returning nothing runs the loop again at once; `{ debounceMs }` waits, `{ cursor }` overrides the query's.
  },
});
```

### The loop

- The work query runs at the transaction's start snapshot (`useStaleSnapshot`), so inserts racing the loop never
  make it retry; the worker mutation runs in the same transaction, and the cursor commits with it.
- With nothing to do, the loop polls every `pollIntervalMs` (200 ms) for `cooldownMs` (2 s) after the last work, then
  waits `timeoutMs` if the query gave one, or goes idle until the next `ping`.
- `config: { debounceMs, monitorLagMs }` on `ping`: wait `debounceMs` (0) before the first batch after idle; the
  monitor restarts a loop that missed its run `monitorLagMs` (60 s) later.

### Failures

A work query or worker mutation that throws fails that run, and nothing reschedules it; the monitor restarts the loop
`monitorLagMs` later and the same batch comes back. Processing is at least once, and an item that always throws
wedges its queue: catch per-item errors in the mutation and move the bad rows aside.

### Controlling a worker

Call these on `components.batchWorker.lib`:

| Function | What it does |
|---|---|
| `start({ name })` | resumes a `stopped` worker (a ping does not) |
| `stop({ name })` | cancels its run and monitor; pings are ignored until `start` |
| `kick({ name })` | restarts it from any state, e.g. after its scheduled functions were cancelled from the dashboard |
| `status({ name })` | `{ kind: "idle" \| "running" \| "stopped" }`, or `null` |
| `getCursor({ name })` / `setCursor({ name, cursor? })` | read, replace or (omitted) clear the cursor; `setCursor` needs a pinged worker |

### Logging

The parent may bind `LOG_LEVEL` (`DEBUG`, `TRACE`, `INFO`, `REPORT`, `WARN`, `ERROR`; `REPORT` by default). Events
such as a restart are one JSON line, `{"component":"worker","event":"restart",…}`, logged at `INFO` and below.

## Test

```ts
import { bunvexTest } from "@bunvex/testing";
import { register } from "@bunvex/batch-worker/test";

const t = bunvexTest();
register(t); // mounted as `batchWorker`, or register(t, "otherName")
await t.mutation(api.events.addEvent, { value: 1 });
await t.finishAllScheduledFunctions();
```

## Differences from Convex's package

- Its names are bunvex's: `bunvex.config.js` for `convex.config.js`, and the `./test` entry registers the component
  with `@bunvex/testing` (it has no `modules`: the harness pushes the component's directory).
- `vBatchQueryArgs`, `vBatchResult` and `vWorkerResult`, deprecated since Convex's 0.3.0, are not there:
  use `defineBatchWorkerValidators`.
