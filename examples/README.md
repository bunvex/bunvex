# bunvex examples

Small apps, one feature each, written for bunvex after the scenarios of Convex's demos (STUDY-90). Each has its
functions in `bunvex/` (with the generated `bunvex/_generated/` committed), a front end (Vite + React, or Next.js),
a README, and an end-to-end test.

## Run one

```sh
cd examples/tutorial
bun install
bun run dev
```

`bun run dev` is `bunvex dev`: it starts a local deployment (its state in `.bunvex/`, its URL in `.env.local`),
pushes the functions, keeps pushing as you edit them, and starts the front end. Like a user's app, it runs the
latest **released** `bunvex-local-backend`, downloaded once to `~/.cache/bunvex/binaries/`.

Some examples need a deployment variable (an API key, an allowed origin). Set it once `bun run dev` has started
the deployment, from another terminal in the example's directory: `bunx bunvex env set NAME value`. Each such
example's README says which.

## Run one against this repository's backend

To work on bunvex itself, run an example against the backend you have checked out instead of the released one:

```sh
bun run example tutorial          # from the repository's root; dev options follow the name
```

It runs the example's `bun run dev` with `BUNVEX_LOCAL_BACKEND_BINARY` pointing to a shim that runs
`packages/bunvex/bin/local-backend.ts` with Bun. The example's local deployment (`.bunvex/`) is the same one
either way: its data stays.

## Tests

```sh
bun run test:examples             # from the repository's root
bun run test:examples:browser     # the front ends in Chromium
```

Each test deploys its example to a fresh backend (this repository's, run by Bun) with `bunvex deploy`, as a
self-hosted user would; checks the committed `_generated/` is what codegen writes; runs the scenario through the
public client; builds the front end; and checks the client bundle holds nothing of the server. External services
(OpenAI, Giphy, Clerk) are replaced by local stand-ins. CI runs them in their own job.

`test:examples:browser` (`examples/_browser/`) serves each example's front end against a fresh deployment and
drives it in Chromium; any page error or console error fails the test.

## The examples

| Example | What it shows |
|---|---|
| [tutorial](tutorial) | A chat: a query, a mutation, a page that stays live |
| [typescript](typescript) | A schema typing documents end to end (`Doc<"messages">`) |
| [args-validation](args-validation) | `args` and `returns` validators, and what a refused call says |
| [custom-errors](custom-errors) | `BunvexError` with a message or data, from mutations and queries |
| [relational-data-modeling](relational-data-modeling) | Channels and messages: `v.id`, an index, a join |
| [pagination](pagination) | `usePaginatedQuery`, `loadMore`, a page that stays live |
| [search](search) | Full-text search over a `searchIndex`, live |
| [vector-search](vector-search) | `vectorSearch` with embeddings from an action (OpenAI) |
| [file-storage](file-storage) | Upload URLs, `ctx.storage`, serving files |
| [file-storage-with-http](file-storage-with-http) | Uploads and downloads through HTTP actions, with CORS |
| [http](http) | HTTP actions: routes, `pathPrefix`, `ctx.runMutation` |
| [scheduling](scheduling) | `ctx.scheduler.runAfter`: messages that count down and delete themselves |
| [cron-jobs](cron-jobs) | `cronJobs()`: a chat cleared every few seconds |
| [system-tables](system-tables) | `db.system`: `_scheduled_functions` and `_storage` |
| [prewarming](prewarming) | `prewarmQuery`: data loaded before the view needs it |
| [giphy-action](giphy-action) | An action calling another service (Giphy), then an internal mutation |
| [dall-e-storage-action](dall-e-storage-action) | An action generating an image (OpenAI) and storing it |
| [react-query](react-query) | TanStack Query (`@bunvex/react-query`), live |
| [nextjs-app-router](nextjs-app-router) | Next.js App Router: `preloadQuery`, `usePreloadedQuery`, a Server Action |
| [nextjs-pages-router](nextjs-pages-router) | Next.js Pages Router, and `fetchQuery` from an API route |
| [users-and-clerk](users-and-clerk) | Signed-in users with Clerk (`bunvex/react-clerk`) |
