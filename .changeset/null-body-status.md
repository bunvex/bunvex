---
"@bunvex/server": patch
---

In functions, `new Response(body, { status })` with a body and a null body status (204, 205 or 304) throws a `TypeError` "Response with null body status cannot have body", as Convex's runtime does. `Response.json` and an empty string count as bodies.
