---
"@bunvex/server": patch
---

The cron executor checks a cron before looking up its function, as Convex. A cron that a push deleted together with its function, after the executor had picked it, used to be retried as a system error forever: an error logged every few seconds, and the cron's slot never freed. It is now dropped, as Convex drops it.
