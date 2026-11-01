# TanStack Start: a chat rendered on the server

The tutorial's chat on [TanStack Start](https://tanstack.com/start): the page arrives with the messages already
rendered on the server, then updates live in the browser. `bunvex/messages.ts` has a query (`list`) and a mutation
(`send`); `src/router.tsx` sets up TanStack Query with `@bunvex/react-query`; `src/routes/index.tsx` reads the
messages with `useSuspenseQuery(bunvexQuery(api.messages.list, {}))`, its `loader` starting the query first.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, starts TanStack Start
```

On the server, every query of a render reads one snapshot over HTTP, and the results go to the browser with the
page; there the same queries continue as live subscriptions, so nothing loads twice and nothing flashes. Open the
page in two tabs and talk to yourself.

In this repository the app runs Vite under Bun (`bun --bun vite`): the workspace's `@bunvex/*` packages are their
TypeScript sources. An app that installs `@bunvex/*` from npm gets compiled JavaScript and can run Vite under Node too.

Its end-to-end test (`test/e2e.test.ts`) builds the app and checks that a page request's HTML holds the messages;
`examples/_browser/tanstack-start.browser.ts` checks the page stays live in two tabs once hydrated.
