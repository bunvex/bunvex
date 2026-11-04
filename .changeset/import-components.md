---
"@bunvex/server": patch
"@bunvex/cli": patch
---

Snapshot imports now restore components. A ZIP's `_components/<name>/` entries go into each component's namespace, and so does the `componentPath` of a single-table import (`bunvex import --component <path>`). Components the deployment lacks are created unmounted. The confirmation lists the changes per component, and `--replace-all` clears every component's tables. A ZIP that `bunvex export` wrote from a deployment with components now imports back.
