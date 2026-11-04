---
"@bunvex/server": minor
---

An embedded server (`persistenceConfigFromEnv`) now uses SQLite (`$DATA/bunvex.sqlite`) when no `PERSISTENCE` or database URL is set, as the Docker image, the executable and `bunvex dev` already did. Set `PERSISTENCE=memory` to keep the memory store. A data directory that holds a memory store and no SQLite file is refused at open, with a message saying so, rather than opened as an empty deployment.
