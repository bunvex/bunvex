---
"@bunvex/server": patch
"@bunvex/cli": patch
---

The push analysis gives each function and HTTP route its source position (`pos: { path, start_lineno, start_col }`), read from the module's source map as Convex reads it, and lists them in source order; HTTP routes take Convex's `{ route: { path, method }, pos }` shape. The CLI's source maps now match the pushed modules: the `// @bun` line dropped from each module is dropped from its map too (every mapping was one line off).
