# bunvex

An internal workspace aggregate: bunvex/server, bunvex/values, bunvex/browser, bunvex/react, bunvex/nextjs,
bunvex/react-clerk, bunvex/react-auth0, and the bunvex CLI, for this repository's examples and tests. It is private
and never published: npm will not allow the name `bunvex` (owner, 2026-10-12; STUDY-40 L7), so apps install the
scoped `@bunvex/*` packages (`bun add @bunvex/server @bunvex/values`, `bun add -d @bunvex/cli`).

**Status:** every subpath of Convex's package is wired: `bunvex/server`, `bunvex/values`, `bunvex/browser`
(`@bunvex/client`), `bunvex/react`, `bunvex/nextjs`, `bunvex/react-clerk` and `bunvex/react-auth0` re-export their
`@bunvex/*` packages (`react` and `@auth0/auth0-react` are optional peers, as Convex's), and the `bunvex` command.
TanStack Query is `@bunvex/react-query`, a package of its own as Convex's `@convex-dev/react-query`. What lives
here, and its status, is tracked in [ARCHITECTURE.md](../../ARCHITECTURE.md):

- re-exports only; bin: bunvex
