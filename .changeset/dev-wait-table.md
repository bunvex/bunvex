---
"@bunvex/server": patch
"@bunvex/cli": patch
---

`bunvex dev` waits on the table a schema validation failed on, as Convex's: once that table changes (a fixed document), it pushes again with no file change. The failure prints Convex's `✖ Schema validation failed.` and the error. The server gains Convex's `_system/cli/queryTable` (STUDY-120).
