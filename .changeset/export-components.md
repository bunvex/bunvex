---
"@bunvex/server": patch
---

Snapshot exports now include every component's tables, `_tables` and (with `includeStorage`) files, each under its component path's `_components/<name>/` prefix, as Convex lays them out. Before, an export of a deployment with components, including the auth component and its accounts, silently left their data out. Importing a ZIP with component entries is still refused, now with a message that says import into components is not built yet.
