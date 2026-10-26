---
"@bunvex/core": patch
"@bunvex/server": patch
---

A client's queries and mutations run through the function call boundary (STUDY-194, STUDY-190 PR 2a): the request and its outcome (the result, the read set, the writes) cross as text in #878's format, still in the main thread. A client's mutation takes its permit before its transaction begins, so its snapshot has what committed while it waited, as Convex's d328f85 (STUDY-186 A11); a session's request already committed is answered even without a permit; scheduled and cron mutations keep the old order. `@bunvex/core` exports the boundary (`Call`, `CallRunner`, the codec) and renames the request metadata type `CallRequest` to `RequestMetadata`.
