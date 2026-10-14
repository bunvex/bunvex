---
"@bunvex/cli": minor
---

The CLI links the local dashboard where Convex's CLI links its own (STUDY-149 PR 8, DV-477): `bunvex dev`'s "View the bunvex dashboard at" line, `export` and `import` (Settings → Snapshots), a push's staged indexes and slow schema wait, the auth config's missing variable, and the MCP `status` tool's `dashboardUrl` — while `bunvex dev` serves it for the deployment; otherwise, and on a self-hosted deployment, no link. A push waiting on its schema prints Convex's three progress lines.
