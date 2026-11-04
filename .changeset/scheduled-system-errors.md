---
"@bunvex/server": patch
---

A scheduled mutation that meets a system error (a store read that failed after the driver's retries, the function sandbox gone, and the like) is retried with backoff, as on Convex, instead of being recorded as `failed` for good; a cron mutation's run is retried the same way instead of being logged as the function's error and skipped until its next time. Only the committer stopping and indexes still being rebuilt were treated as system errors before.
