---
"@bunvex/server": patch
---

The scheduled job a function runs under now reaches the mutations and actions a scheduled action calls (`ctx.runMutation`, `ctx.runAction`), as Convex propagates `parent_scheduled_job` down the call tree. Canceling a running scheduled action now also cancels what those functions schedule (they are born canceled), so an "action → mutation → schedule the next step" loop stops on cancel; and a mutation it calls cannot cancel that job ("A mutation cannot cancel itself").
