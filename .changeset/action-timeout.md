---
"@bunvex/server": minor
"@bunvex/core": patch
---

Actions time out, as Convex's: 1800 s (`V8_ACTION_USER_TIMEOUT_SECS`), 600 s for a `"use node"` action (`NODE_ACTION_USER_TIMEOUT_SECS`), counted from when the action holds its permit, awaited calls included. Past it the action fails with Convex's message (`Function execution timed out (maximum duration: 1800s)`, or ``Action `name` execution timed out (maximum duration 600s)``), a user error for its caller, the function log, a scheduled job (`failed`) and an HTTP action (500); its permit is freed. The cut-off handler can no longer call `ctx` (database, scheduler, storage, vector search, other functions) or `fetch`, and its fetches in flight are aborted (STUDY-77).
