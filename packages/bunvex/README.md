# bunvex

The package an app installs: bunvex/server, bunvex/values, bunvex/browser, bunvex/react, bunvex/nextjs,
bunvex/react-clerk, bunvex/react-auth0, and the bunvex CLI.

**Status:** every subpath of Convex's package is wired: `bunvex/server`, `bunvex/values`, `bunvex/browser`
(`@bunvex/client`), `bunvex/react`, `bunvex/nextjs`, `bunvex/react-clerk` and `bunvex/react-auth0` re-export their
`@bunvex/*` packages (`react` and `@auth0/auth0-react` are optional peers, as Convex's), and the `bunvex` command.
TanStack Query is `@bunvex/react-query`, a package of its own as Convex's `@convex-dev/react-query`. What lives
here, and its status, is tracked in [ARCHITECTURE.md](../../ARCHITECTURE.md):

- re-exports only; bin: bunvex
