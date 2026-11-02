---
"@bunvex/cli": minor
"@bunvex/server": patch
---

`bunvex data --component <path>` prints a component's tables, or a table's documents, as `npx convex data --component` does: the queries subscribe at the component's path, which the server runs them in. A path no component has fails with `Component path '<path>' not found`.
