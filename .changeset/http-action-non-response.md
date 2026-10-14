---
"@bunvex/server": patch
---

An HTTP action whose handler returns something other than a Response is logged as failed, with Convex's error (`Uncaught Error: HTTP actions must return a Response`), not as a success; it is still answered with the 500.
