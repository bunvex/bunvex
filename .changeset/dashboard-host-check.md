---
"@bunvex/cli": patch
---

The local dashboard `bunvex dev` serves answers only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`, as Convex's CLI does now: any other `Host` gets an empty 403 on every path, not only on `/api/current_deployment`. A page that rebinds its own name to 127.0.0.1 gets nothing from it. `bunvex dashboard serve` still serves any `Host`.
