---
"@bunvex/core": patch
---

`Engine.close()` runs once: a second call waits for the first. `bunvex-local-backend` closed the engine twice on SIGINT/SIGTERM (the server's shutdown, then its own stop), and the second close flushed the search indexes after the SQLite lock was released, which stopped the committer with "another process holds this SQLite store" (STUDY-133 §12 M15).
