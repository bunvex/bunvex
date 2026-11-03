---
"@bunvex/server": minor
"@bunvex/core": minor
---

Queries run on execution workers: Bun Workers beside the main thread. This applies to a deployment's queries (pushed code) on a SQLite file, for calls from clients. Each worker reads the store through a read-only connection of its own, at the query's snapshot, with the code and the catalog the main thread checked the call against; counts and text searches are answered by the main thread. A query's result, errors, log lines and read set are the same as in-thread, and every test suite that runs a deployment on a SQLite file checks that.

Workers start lazily, one each time every running one is busy, up to `MAX_ISOLATE_WORKERS`. The default is the machine's core count, and `0` runs everything on the main thread; `createServer({ executionWorkers })` sets it per server. While no worker is ready, a query runs on the main thread. A worker that dies fails its calls with a system error and is replaced. A query that never yields fails with the user time limit's timeout and its worker is replaced, while the others keep answering. The SQLite page cache (`BUNVEX_SQLITE_CACHE_SIZE`) is shared: the main connection keeps half, the workers split the rest.

Mutations and actions still run on the main thread, and so does every query on Postgres or MySQL. On two 4-vCPU DigitalOcean droplets, uncached queries ran 1.83× faster with 2 workers, with no change to cached queries or inserts.
