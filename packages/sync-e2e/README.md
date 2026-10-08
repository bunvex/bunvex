# @bunvex/sync-e2e

End-to-end tests of the sync protocol (STUDY-23, STUDY-26), never published:

- `@bunvex/client` against a real bunvex server;
- the official `convex` npm client against a bunvex server, as the protocol oracle (STUDY-26 C7);
- `react/`: `@bunvex/react`, `@bunvex/nextjs`, `@bunvex/react-clerk`, `@bunvex/react-auth0` and
  `@bunvex/react-query` in happy-dom (`bun run test:react`).

These live in their own workspace because the dependency rules keep `@bunvex/client` from importing the
server, and keep the `convex` package out of every shipped package.
