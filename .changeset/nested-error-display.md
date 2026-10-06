---
"@bunvex/server": patch
---

A caught error from a nested call reads as Convex's. A `BunvexError` from a nested query or mutation now has the callee's uncaught message ("Uncaught BunvexError: …" and its frames) with its data, where it had the data's text alone. An action that catches a failed `runQuery`, `runMutation` or `runAction` now gets the callee's uncaught message (with `BunvexError` data), where it got the callee's own error. Refusals before the callee runs are unchanged.
