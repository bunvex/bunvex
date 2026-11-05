---
"@bunvex/core": minor
---

SQLite's page cache defaults to SQLite's own 2 000 KiB, as Convex's, instead of 256 MiB. A backend on a SQLite store now holds up to ~250 MB less memory. `BUNVEX_SQLITE_CACHE_SIZE` still raises it. On the backend's read path, a 256 MiB cache measured within the noise of 2 000 KiB.
