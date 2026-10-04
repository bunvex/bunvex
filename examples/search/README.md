# Full-text search

`bunvex/schema.ts` declares a search index on the messages' `body`; `bunvex/messages.ts`'s `search` returns the
ten best matches with `withSearchIndex`. Like any query it is live: send a matching message and the results
update.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and checks the same behaviour through
the client.
