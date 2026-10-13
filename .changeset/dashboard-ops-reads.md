---
"@bunvex/server": patch
---

The dashboard's schedule and file system calls answer as Convex's backend: `POST /api/cancel_job` with an id that
is not a scheduled job's is a 400 `InvalidId` ("Invalid ID for table _scheduled_jobs") instead of a 500;
`_system/frontend/fileStorageV2:getFile` answers null for an id that is not a storage id (a malformed one or a user
table's), as Convex's masked `db.system.get`; `_system/frontend/paginatedScheduledJobs` matches `udfPath` exactly
(the canonical `module.js:name` the dashboard sends) instead of also accepting `module:name`.

The app metrics' subscription invalidations (`/api/app_metrics/subscription_invalidations_top_k`, the dashboard's
Health) also count what Convex's scheduler and cron executor subscriptions count: `<mutation>:_scheduled_jobs` for a
commit that schedules before the next future run, twice for a scheduled mutation's run, `<function>:_cron_next_run`
for a cron run; the scheduler's own commits carry Convex's write-source names.
