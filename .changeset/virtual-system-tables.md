---
"@bunvex/core": patch
"@bunvex/server": patch
---

Convex's system table layout: files are stored in `_file_storage`, scheduled jobs in `_scheduled_jobs` with their arguments in `_scheduled_job_args`, in Convex's document shapes. `_storage` and `_scheduled_functions` are virtual tables over them, read through `db.system` with the same ids; filters on them see the virtual fields, and `db.system.get` / `db.get` refuse the other kind of table as Convex does. Data stored by earlier versions is not read.
