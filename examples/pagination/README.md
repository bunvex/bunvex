# Pagination

A message board that loads older messages on demand. `bunvex/messages.ts` paginates with `.paginate()`:
`list` (every message, newest first), `listByAuthor` (over an index, with an argument of its own) and
`listShouted` (a page reshaped before it is returned). `src/App.tsx` uses `usePaginatedQuery`: the first five
messages, `loadMore(5)` for older ones, and new messages appear at the top as they are sent.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

While the first page is also the last one (there are fewer messages than it asked for), it keeps every new
message it covers: start with an empty board, send twenty messages, and all twenty show without "Load more". A
page covers a range of the index, not a count, and that range is open while nothing comes after it. Reload, and
the first page is five again. Convex's pagination behaves the same way.

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and checks the same behaviour through
the client.
