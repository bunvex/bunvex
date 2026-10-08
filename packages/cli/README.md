# @bunvex/cli

The `bunvex` command: develop, deploy and run functions on a [bunvex](https://github.com/bunvex/bunvex)
deployment, a reactive backend for Bun with Convex's model (queries, mutations, actions, live queries).

```sh
bun add @bunvex/server @bunvex/values
bun add -d @bunvex/cli typescript @types/bun
mkdir bunvex                                   # your functions: bunvex/messages.ts, bunvex/schema.ts, …
bunx bunvex dev                                # a local deployment, pushed to on every change
```

With nothing configured, `bunvex dev` runs the project's local deployment: it downloads `bunvex-local-backend`
from the latest release, keeps its state in `.bunvex/local/default/`, and writes `.env.local`. To use a
self-hosted deployment instead, set `BUNVEX_SELF_HOSTED_URL` and `BUNVEX_SELF_HOSTED_ADMIN_KEY`.

Commands: `dev`, `deploy`, `codegen`, `run`, `env`, `admin-key`, `data`, `logs`, `export`, `import`,
`function-spec`, `typecheck`, `deployment`, `mcp`. `bunvex <command> --help` for each.

This is an alpha preview, published from the TypeScript sources: it needs Bun.

What is built, and what is next: [ARCHITECTURE.md](https://github.com/bunvex/bunvex/blob/main/ARCHITECTURE.md).
