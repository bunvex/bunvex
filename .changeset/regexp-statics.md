---
"@bunvex/server": patch
---

Functions in the isolate no longer see the deprecated RegExp statics (`RegExp.$1`, `lastMatch`, `input`, …), which held the last match across calls; Convex's runtime deletes them (DV-436). `"use node"` modules keep them.
