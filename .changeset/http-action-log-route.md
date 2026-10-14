---
"@bunvex/server": patch
---

An HTTP action is logged as Convex logs it: its Completion, `function_execution` event and app metrics by the route that matched (`GET /files/*` for a prefix route) once it ran to the end, its lines by the request (`GET /files/abc`, HEAD as GET). A failed run, a client that left, or a request no route matches keeps the request's name and is not measured; a request no route matches is now logged with its 404.
