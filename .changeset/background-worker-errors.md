---
"@bunvex/server": patch
---

A store failure in a background worker no longer ends the process. The startup cron registration (`createServer({ crons })`) retries a failed diff with the cron executor's backoff (500 ms to 15 s), logging each failure, and starts the executor once it commits; `cronsReady` resolves then (or with `undefined` if the server stops first) and never rejects. Before, a read error during it was an unhandled rejection and the process exited with code 1 and no message. The cron executor's loop now backs off as Convex's does instead of waiting a fixed second. The export and import workers retry a failed read of their queue (they used to wait for the next request) and no longer let a store error escape while recording a failed export or dropping a failed import's tables.
