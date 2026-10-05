---
"@bunvex/server": patch
"@bunvex/cli": patch
---

Cron and `_udf_config` rows as Convex stores them (STUDY-134): `_cron_jobs.cronSpec` with int64 schedule numbers
(an absent `minuteUTC` null) and the arguments as the bytes of their JSON, `_cron_next_run.nextTs` / `prevTs` and
`_cron_job_logs.ts` as int64 nanoseconds, an in-progress state's `request_id` / `execution_id`, a logged result's
value as its JSON text, `_modules.analyzeResult.cronSpecs` as `[{identifier, spec}]`, and
`_udf_config.importPhaseUnixTimestamp` as int64 nanoseconds. `bunvex deploy` sends its package version as
`udfServerVersion`, stored as `_udf_config.serverVersion`.
