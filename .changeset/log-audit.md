---
"@bunvex/server": minor
---

The `log` export, as Convex's: `log.audit(body)` in a query or mutation adds an audit log line (keys may not start with "$"; nested calls' lines join their caller's), resolved when the function ends with `log.vars` (`requestId`, `ip`, `userAgent`, `now`, and `bunvexActor`, Convex's `convexActor`, null on a self-hosted deployment) and sent to the log streams as `custom_audit` events; Convex's limits (500 lines, 100 KB a line, 4 MB in all, 4 MB held) answer HTTP 400 with their code; actions refuse it. A sink subscribed to every topic leaves `custom_audit` out (STUDY-82).
