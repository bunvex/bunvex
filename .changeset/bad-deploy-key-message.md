---
"@bunvex/server": patch
---

`BadDeployKey` (403, no admin key where an admin is required) now reads "The provided deploy key was invalid for this deployment. …" on every route, as Convex's backend words it. It used to name the deployment (STUDY-34).
