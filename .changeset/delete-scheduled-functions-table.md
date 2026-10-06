---
"@bunvex/server": minor
"@bunvex/core": minor
---

`POST /api/delete_scheduled_functions_table`, as Convex's (STUDY-113): with WriteData, the scheduled functions' table is replaced with an empty one in one commit, whatever it holds, with a `delete_scheduled_jobs_table` audit event; a job running meanwhile finds its document gone and records nothing. `Engine.replaceWithEmptyTables` is bunvex's `replace_with_empty_table`.
