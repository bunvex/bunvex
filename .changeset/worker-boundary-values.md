---
"@bunvex/core": patch
"@bunvex/server": patch
---

With execution workers on (`MAX_ISOLATE_WORKERS`), what a call returns or throws now reaches the client as it does without them:
- a query whose result is not a value (`undefined` in an array, a bigint out of the 64-bit range) fails with its error, as on the main thread, where it used to succeed with `null`;
- a `BunvexError` whose data holds bytes delivers its data, where it used to fail as an internal error.
