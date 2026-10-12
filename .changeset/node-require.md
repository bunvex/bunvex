---
"@bunvex/server": patch
---

`require` works in `"use node"` modules (STUDY-148): Bun's bundle turns `require(…)` of a builtin (also inside bundled CommonJS dependencies) into `import.meta.require(…)`, which the server's modules lacked, so such an action failed with "`__require` is not a function". Each Node module's `import.meta.require` is now a `require` from the module's place, as Convex's executor sets `require` to `createRequire(<module path>)`; builtins resolve, other packages do not (no `node_modules` beside the modules yet).
