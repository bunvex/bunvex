---
---

The dashboard's custom test query no longer hangs in "Running…" when the deployment's type files are refreshed during a run: Monaco's TypeScript worker is restarted only once, and a compile a restart overtakes is retried (`@bunvex/ui`, `@bunvex/dashboard`, not published separately).
