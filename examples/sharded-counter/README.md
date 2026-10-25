# Sharded counter: one million checkboxes

A component from npm, the way an app installs one: `@bunvex/sharded-counter`, bunvex's sharded counter (the same API
as Convex's `@convex-dev/sharded-counter`).

- `bunvex/bunvex.config.ts` mounts it twice: `shardedCounter` and `checkboxCounter`.
- `bunvex/checkboxes.ts` keeps a million checkboxes as bits, 4,000 to a document, and counts the checked ones in
  `checkboxCounter` with 100 shards, so that many clicks at once rarely write the same document.
- `bunvex/example.ts` shows the rest of the client: a counter per key (`counter.for("users")`), `rebalance`,
  `estimateCount`, `reset`, the component's functions called directly, a trigger (`@bunvex/helpers`' `Triggers`)
  that counts the `users` table, and a backfill of the rows written before the counting started.
- The page (`src/App.tsx`) shows every box live, one query per document, and the count; a click flips its box and
  the count at once with an optimistic update.

It is the package's own example app ported to bunvex. Its backfill with the migrations component is left out
(bunvex has no `@bunvex/migrations` yet); `backfillUsers` does the same by hand.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend, checks boxes and follows the count through a
subscription, and runs the counter's other functions.
