---
"@bunvex/server": minor
"@bunvex/cli": minor
"@bunvex/core": minor
---

System tables can be browsed (STUDY-131 AD-24, a bunvex addition). The system queries `_system/debug/systemTables` and `_system/debug/systemTable` list every system table the catalog has, private ones included, with a one-line description each, and page through one's documents as stored. They are read-only, need an admin key with ViewData, and function code cannot call them. `bunvex data --system` lists the tables, and `bunvex data --system <table>` prints one's documents. `SYSTEM_TABLE_DESCRIPTIONS` sits next to `SYSTEM_TABLE_NUMBERS` in `@bunvex/core`.
