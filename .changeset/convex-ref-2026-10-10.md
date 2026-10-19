---
"@bunvex/cli": patch
---

Matches Convex at `precompiled-2026-10-10-72ce13c` (STUDY-173): a push refused for a missing environment variable
prints how to set it, one `bunvex env set NAME <value>` per variable (with `--url <url> --admin-key <admin key>` for a
deployment named by its URL), then the dashboard's page when one is served. A variable that `bunvex.config.ts`
requires and the deployment lacks is named the same way, and `bunvex dev` pushes again once it is set.
