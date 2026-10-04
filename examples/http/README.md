# HTTP actions

A chat that is also an HTTP API. `bunvex/http.ts` routes three HTTP actions (in `bunvex/messages.ts`) on the
deployment's site origin:

- `POST /postMessage` with `{ "author": "User 1", "body": "hi" }` posts a message, through `ctx.runMutation`;
- `GET /getMessagesByAuthor?authorNumber=1` (or an `authorNumber` header) returns `User 1`'s messages as JSON;
- `GET /getAuthorMessages/1` does the same with the number as the path's last segment (a `pathPrefix` route).

The page (`src/App.tsx`) shows the messages live, whichever way they were posted, and the `curl` commands to try.

```sh
bun install
bun run dev
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and calls the routes with `fetch`.
