# Tutorial: a chat

A chat in a few lines: `bunvex/messages.ts` has a query (`list`) and a mutation (`send`), and `src/App.tsx`
renders the messages with `useQuery`, which stays live: open the page in two tabs and talk to yourself.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and checks the same behaviour through
the client.
