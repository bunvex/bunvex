---
"@bunvex/cli": patch
---

`bunvex typecheck [--typescript-compiler tsc|tsgo]` typechecks the functions as Convex's `typecheck` does, with Convex's messages. `tsgo` comes from `@typescript/native-preview`. The compiler comes from the flag, else `typescriptCompiler` in `bunvex.json`, else `tsc`; `deploy`, `dev` and `codegen` use it too. The compiler now runs with `--noEmit --pretty true`, so type errors print as colored `file:line:column` diagnostics. A TypeScript older than 4.8.4 gets Convex's warning.
