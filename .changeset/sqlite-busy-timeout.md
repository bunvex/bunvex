---
"@bunvex/core": patch
---

The SQLite store waits up to 5 s for another connection's lock before failing with `database is locked` (SQLITE_BUSY), as Convex's does (rusqlite's default busy timeout); it failed at once, so opening a store while another process held or was closing it could fail. `close()` now closes the connection at once: its prepared statements kept it open until they were garbage-collected, and its real close (a checkpoint under an exclusive lock) then landed at a random later moment.
