# Rate limiter

`@bunvex/rate-limiter`, after Convex's example of [`@convex-dev/rate-limiter`](https://github.com/get-convex/rate-limiter):

- **Playground** ([playground.ts](bunvex/playground.ts)): the limit's config is the page's controls (kind, rate,
  period, capacity, shards). Spend or reserve tokens and watch a timeline of the limit's tokens over the last 10 s.
- **`useRateLimit`** ([example.ts](bunvex/example.ts)): a fixed limit read in the browser. The hook subscribes to one
  query, measures the clock skew to the server once, and computes the tokens and the time the next call fits
  locally, re-rendering when that time comes.
- **The API** ([example.ts](bunvex/example.ts)): limits named in the constructor, `limit`, `check`, `reset`,
  `throws`, an inline config, and the component's functions called directly.
- **A load test** ([loadTest.ts](bunvex/loadTest.ts)): workers calling a sharded limit from one action, counting what
  passed, what the limit refused and what conflicted:

  ```sh
  bunx bunvex run loadTest:run '{"qps": 50}'
  ```

## Run

```sh
bun install
bun run dev
```

## Test

```sh
bun test examples/rate-limiter
```
