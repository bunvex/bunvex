---
"@bunvex/server": patch
"@bunvex/values": patch
---

Pushed functions match Convex in three places (STUDY-171 §9): `process.env` no longer reads `Object.prototype` names (`process.env.constructor` is unset unless set); `db.vars.commitTs` inside a pushed function's objects is refused in scheduled arguments and resolved in a mutation's result; and a cached query result expires after 17 s only when the query read the time (the server's app metrics no longer read the deterministic clock inside every query).
