---
"@bunvex/server": patch
---

An HTTP action whose client leaves while its body streams ends its log lines with `[INFO] Client disconnected` (system code `info:httpActionClientDisconnect`), as Convex: the line is sent as its own progress entry and the run is logged with the response's status. A HEAD request or a body read to its end gets no such line. The run no longer gets a spurious `Controller is already closed` error line when the client leaves while a chunk is being read.
