---
"@bunvex/server": minor
---

Execution workers are off by default: `MAX_ISOLATE_WORKERS` unset (or `0`) runs every function on the main thread. Set it to a count to run deployed queries and mutations on up to that many worker threads, as before. A value could be lost between a worker and the main thread (a WebSocket mutation returning `undefined`), so the workers stay opt-in until they are hardened.
