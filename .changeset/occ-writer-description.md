---
"@bunvex/core": patch
"@bunvex/server": patch
---

An OCC conflict caused by one of bunvex's own writers describes it by what was done, as Convex's (DV-435): "An edit in the dashboard", "A Fivetran sync", "An Airbyte sync", "A data import" or "A system operation"; a call to the app's function still reads `A call to "<path>"`. Every system write source is now under `_system/`.
