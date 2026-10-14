---
"@bunvex/server": patch
---

An HTTP action's streamed body that fails after the head ends the response cleanly (the client keeps what was sent), with Convex's `error:httpAction` line (`Uncaught <error>` and its frames); one that fails in the handler's turn fails the run, answered with the 500, as Convex's.
