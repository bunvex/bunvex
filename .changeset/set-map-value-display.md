---
"@bunvex/values": patch
"@bunvex/server": patch
---

A `Set` or `Map` where a value goes now fails with Convex's text, its entries included (`Set[1] is not a supported
value type.`), also from a pushed function, whose `Set` is its own context's and printed as `Set {…}`. A result is
converted before its size, nesting and `returns` checks, and scheduled and nested-call arguments (which must be an object) before anything
else, so their messages are Convex's. `scheduler.runAt` takes a pushed function's own `Date`. An object that only
claims the `ArrayBuffer` tag is an object, not empty bytes (STUDY-18 §9).
