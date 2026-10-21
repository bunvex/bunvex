# @bunvex/sharded-counter

A counter that many mutations can update at once without conflicting: each named counter is spread over several
documents (shards), a write goes to one of them, and the count is their sum. It is bunvex's version of
[`@convex-dev/sharded-counter`](https://github.com/get-convex/sharded-counter) and **matches
`@convex-dev/sharded-counter` 0.2.3**: the same client API, component name (`shardedCounter`), table and index, and
the same function paths, arguments and results, so an app moves by renaming its imports and a Convex export of the
component's data imports unchanged ([STUDY-183](../../docs/study/STUDY-183-sharded-counter.md)).

## Install

```sh
bun add @bunvex/sharded-counter
```

```ts
// bunvex/bunvex.config.ts
import { defineApp } from "@bunvex/server";
import shardedCounter from "@bunvex/sharded-counter/bunvex.config.js";

const app = defineApp();
app.use(shardedCounter);
export default app;
```

## Use

```ts
import { ShardedCounter } from "@bunvex/sharded-counter";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

// 16 shards per counter by default; more for a busy key.
const counter = new ShardedCounter(components.shardedCounter, { shards: { beans: 32 }, defaultShards: 8 });

export const addBeans = mutation({
  args: {},
  handler: async (ctx) => {
    await counter.add(ctx, "beans", 5); // count defaults to 1; negative counts lower it
    await counter.subtract(ctx, "beans", 2);
    await counter.inc(ctx, "beans");
    await counter.dec(ctx, "beans");
  },
});

export const beans = query({ args: {}, handler: (ctx) => counter.count(ctx, "beans") });
```

| Method | What it does |
|---|---|
| `add(ctx, name, count = 1)` | adds `count` to one shard of `name` |
| `subtract(ctx, name, count = 1)`, `inc(ctx, name)`, `dec(ctx, name)` | `add` with `-count`, `1`, `-1` |
| `count(ctx, name)` | the sum of every shard (in a mutation, it conflicts with every write to `name`) |
| `estimateCount(ctx, name, readFromShards = 1)` | the sum of `readFromShards` random shards, scaled to all of them |
| `rebalance(ctx, name)` | gives every shard an equal, unrounded share, and removes the shards past the current number |
| `reset(ctx, name)` | removes the counter |
| `for(name)` | the same methods with `name` given once: `counter.for("users").inc(ctx)` |
| `trigger(name)` | a trigger for `@bunvex/helpers/server/triggers` that keeps `name` equal to a table's size |

```ts
import { Triggers } from "@bunvex/helpers/server/triggers";

const triggers = new Triggers<DataModel>();
triggers.register("users", counter.trigger("users")); // +1 on insert, -1 on delete
```

An instance remembers the shard its last `add` wrote for each name and keeps writing there. bunvex evaluates an
app's modules once per code version, so the remembered shard lasts that long (on Convex, a request): it changes which
shard a write lands on, never a count.

The component's functions can also be called directly: `components.shardedCounter.public.add` (`{ name, count, shard?,
shards? }`, returns the shard), `count`, `estimateCount`, `rebalance` and `reset`, or from the CLI:
`bunvex run --component shardedCounter public:count '{"name": "beans"}'`.

## Test

```ts
import { bunvexTest } from "@bunvex/testing";
import { register } from "@bunvex/sharded-counter/test";

const t = bunvexTest();
const counter = register(t); // mounted as `shardedCounter`, or register(t, "otherName")
await t.mutation(counter.public.add, { name: "beans", count: 2 });
```

## Differences from Convex's package

- Its names are bunvex's: `bunvex.config.js` for `convex.config.js`, and the `./test` entry registers the component
  with `@bunvex/testing` (it has no `modules`: the harness pushes the component's directory).
- The remembered shard lasts a code version rather than a request (see above).
