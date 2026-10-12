---
"@bunvex/cli": patch
---

`bunvex.json`'s `node.externalPackages` is checked as Convex's `convex.json` (STUDY-148): an array of strings, an element named by its index (`` `node.externalPackages.1` in `bunvex.json`: Expected string, received number ``), before `node.nodeVersion`. The listed packages are still bundled; installing them on the deployment is designed in STUDY-148 and waits on the owner.
