---
"@bunvex/server": minor
---

A deployed code package is stored as Convex's zip (`modules/<path>`, `modules/<path>.map`, `metadata.json`) instead
of one gzip JSON blob (DV-166 resolved to match). A package an earlier version wrote is not read: the server logs it
and starts without code, and the next `bunvex deploy` replaces it.
