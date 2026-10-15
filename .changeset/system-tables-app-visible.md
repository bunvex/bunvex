---
"@bunvex/server": patch
---

`_system/debug/systemTables` marks `_file_storage` and `_scheduled_jobs` as `appVisible` (apps read them through `db.system` as `_storage` and `_scheduled_functions`); every system table read as private before, so `bunvex data --system` printed them `private`. The dashboard's Data screen now lists and opens the system tables on a deployment (STUDY-131 AD-24).
