---
"@bunvex/server": minor
"@bunvex/core": minor
"@bunvex/persistence": minor
---

Queries also run on execution workers on Postgres and MySQL. Each worker opens connections of its own, without creating tables or taking the store's lease. `PostgresPersistence` and `MysqlPersistence` describe how to open them (`reader()`), and `openReader` opens them. `POSTGRES_MAX_CONNECTIONS` / `MYSQL_MAX_CONNECTIONS` stay the deployment's total. Once a worker can start, the main thread keeps a quarter of it, at least 8, and the workers share the rest, at least 2 each. A pool too small for that starts fewer workers, and one under 10 none. The store's pool is resized then (`setPoolSize`); calls already running on it finish first.

`bunvex-local-backend` and the Docker image carry the drivers for their workers too. They are now registered by `@bunvex/persistence/executable`.

On two 4-vCPU DigitalOcean droplets with Postgres on its own box, uncached queries ran 41% faster with 2 workers. Cached queries were unchanged, and inserts stayed within their run-to-run spread.
