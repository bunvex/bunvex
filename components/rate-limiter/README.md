# @bunvex/rate-limiter

Application-layer rate limits for bunvex: token buckets and fixed windows, per key or shared, checked and taken in
the same transaction as your mutation, sharded for throughput, or applied in the background for very busy limits.
It is bunvex's version of [`@convex-dev/rate-limiter`](https://github.com/get-convex/rate-limiter) and **matches
`@convex-dev/rate-limiter` 0.4.2**: the same client API, React hook, component name (`rateLimiter`), tables,
function paths, arguments, results, math and messages, so an app moves by renaming its imports and a Convex export of
the component's data imports unchanged.

## Install

```sh
bun add @bunvex/rate-limiter
```

```ts
// bunvex/bunvex.config.ts
import { defineApp } from "@bunvex/server";
import rateLimiter from "@bunvex/rate-limiter/bunvex.config.js";

const app = defineApp();
app.use(rateLimiter); // brings its child, @bunvex/batch-worker
export default app;
```

## Use

```ts
import { HOUR, MINUTE, RateLimiter } from "@bunvex/rate-limiter";
import { components } from "./_generated/api";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Per user: about one every 6 seconds, up to 3 at once after a quiet spell.
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  // One shared limit, in hourly windows.
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
  // A very busy limit: checked at the transaction's start, taken in the background.
  apiCalls: { kind: "token bucket", rate: 1000, period: MINUTE, applyUpdates: "asynchronously" },
});

export const sendMessage = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const userId = await getUserId(ctx);
    await rateLimiter.limit(ctx, "sendMessage", { key: userId, throws: true });
    // …
  },
});
```

| Method | What it does |
|---|---|
| `limit(ctx, name, { key?, count?, reserve?, throws?, config? })` | checks and takes `count` (1) tokens: `{ ok, retryAfter }`, or throws with `throws` |
| `check(ctx, name, …)` | the same answer, taking nothing |
| `getValue(ctx, name, { key?, sampleShards? })` | the stored `{ value, ts, shard, config }` |
| `reset(ctx, name, { key? })` | removes the limit (queued, for an asynchronous one) |
| `hookAPI(name, { key?, sampleShards? })` | `{ getRateLimit, getServerTime }` to export for `useRateLimit` |

- **`reserve`** takes tokens ahead of time (the value goes negative, up to `maxReserved`); `ok` then comes with the
  `retryAfter` to wait before doing the work.
- **`shards`** spreads a busy limit over several rows: each call reads two at random and takes from the fuller one.
- **`applyUpdates: "asynchronously"`** checks at the transaction's start (no conflicts with other callers) and queues
  the consumption for the batch worker: eventually consistent, and never sharded.
- **Errors.** With `throws`, a limited call throws `BunvexError({ kind: "RateLimited", name, retryAfter })`;
  `isRateLimitError(e)` tells it apart. A request that could never fit (`count` above the capacity) always throws.

### In React

```ts
// bunvex/limits.ts
export const { getRateLimit, getServerTime } = rateLimiter.hookAPI("sendMessage", {
  key: async (ctx) => getUserId(ctx),
});
```

```tsx
import { useRateLimit } from "@bunvex/rate-limiter/react";

const { status, check } = useRateLimit(api.limits.getRateLimit, { getServerTimeMutation: api.limits.getServerTime });
// status: { ok: true } | { ok: false, retryAt }; it re-renders when retryAt passes.
```

## Test

```ts
import { bunvexTest } from "@bunvex/testing";
import { register } from "@bunvex/rate-limiter/test";

const t = bunvexTest();
register(t); // mounted as `rateLimiter`, with its batch worker
```

## Differences from Convex's package

- Its names are bunvex's: `bunvex.config.js` for `convex.config.js`, `BunvexError` for `ConvexError` (the same
  `data`), and the hook reads `useBunvex` where Convex's reads `useConvex`.
- The `./test` entry registers the component with `@bunvex/testing` (no `modules`: the harness pushes the
  component's directory, and its child comes with it).
