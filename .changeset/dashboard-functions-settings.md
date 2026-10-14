---
"@bunvex/server": patch
---

The dashboard's Functions and Settings system queries, as Convex's: `_system/frontend/modules:listForAllComponents`,
`modules:list` and `modules:argsValidator` (the deployed modules, their analyzed functions with lines, HTTP routes
and crons, and a function's arguments validator), `components:list`, `getVersion`, `cloudUrl` and `siteUrl`
(Convex's `convexCloudUrl` and `convexSiteUrl`, renamed: DV-474), `listEnvironmentVariables`, `latestExport` and
`snapshotImport:list`, each under Convex's permission.

A snapshot import records the admin key's member that started it (`_snapshot_imports.member_id`), as Convex's
backend does, instead of none.
