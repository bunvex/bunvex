---
"@bunvex/cli": minor
"@bunvex/server": minor
"@bunvex/core": patch
---

`node.externalPackages` (STUDY-148): `bunvex deploy` leaves the listed packages (or every dependency, with `"*"`) as imports in the `"use node"` bundle, as Convex's CLI does, and names them and their installed versions in the push. The deployment installs them with `bun install` (running every install script), records Convex's `_external_deps_packages` row and blob, reuses one of the last ten installs with the same packages, counts them in the package size limit, and answers a failed install with Convex's 400 `InvalidExternalModules`. Node actions import and `require` them from a per-process directory (file modes kept), and they read the deployment's variables first.
