---
"@bunvex/server": patch
---

Log stream `console` and `function_execution` events carry `function.runtime`, as Convex's do now: `"bunvex"` for a function that runs in bunvex's isolate runtime (Convex says `"convex"`), `"node"` for a `"use node"` action, and `null` for an action that failed before it ran (no such function, or arguments its validator refused).
