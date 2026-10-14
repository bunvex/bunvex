---
"@bunvex/server": patch
---

An HTTP action's response gets the headers Convex gives it: a string body's `text/plain;charset=UTF-8`, a Blob's own type (not Bun's MIME table's), `Response.json`'s `application/json` (over an explicit type too), each in the function's `response.headers` as soon as it is built, and the `content-length` of any body that is not a stream (a HEAD request included). Untyped bytes past Bun's first chunk still go chunked (DV-483, accepted).
