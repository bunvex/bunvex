---
"@bunvex/auth": minor
---

`bunx @bunvex/auth`, run from a project's root, sets up auth: it checks that the project depends on `@bunvex/auth` (if not, it prints the install command for your package manager) and writes `bunvex/auth.config.ts`, `bunvex/bunvex.config.ts` and `bunvex/auth.ts`, never over an existing file, whose expected content it prints instead.
