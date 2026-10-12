---
"@bunvex/server": patch
---

The unawaited-operations warning lists what Convex's does: `ctx.meta`'s calls, `createFunctionHandle`, `log.audit` and an HTTP action's multipart `formData()` count too, and a call left unawaited is listed even when it answered at once (its answer is handed over in the next turn of the event loop, as Convex's tasks are).
