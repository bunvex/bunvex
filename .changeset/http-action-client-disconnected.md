---
"@bunvex/server": patch
---

An HTTP action whose client went away before the response head could be sent is logged as Convex logs it: the execution fails with "Client disconnected" in the function log (and log streams), instead of a success. The handler still runs to the end and what it wrote stays, as before.
