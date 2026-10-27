---
"@bunvex/server": patch
---

Matches Convex at `precompiled-2026-10-26-04d2f3b` (STUDY-193): every change STUDY-186 found after `precompiled-2026-10-10-72ce13c` that an app can observe is in, each with its own entry. These include log line limits by kind, no zipped package limit, Node 20 refused, `.staged()` field deltas, `paginate()` in component queries, the import and data sync limits, the mutation permit before the transaction, and `function.runtime` on log stream events. Four new Convex features keep their own studies: storage in mutations, `ctx.auth.signJwt`, the CLI's staged-schema output and `v.function()`.
