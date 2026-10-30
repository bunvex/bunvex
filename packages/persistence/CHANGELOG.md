# @bunvex/persistence

## 0.1.0-alpha.2

### Patch Changes

- 79f8fac: On MySQL, a connect that does not finish within the call's timeout fails with `DatabaseTimeoutError`, as Convex's, so the committer retries the flush. mysql2's own `connect ETIMEDOUT` no longer stops the committer.
- fae5446: MySQL errors are retried as Convex's now classifies them: of the IO errors, only a refused or reset connection, an unexpected end and a temporary DNS failure (`EAI_AGAIN`) count as a lost connection. A broken pipe, a timeout, or an unreachable host or network is no longer retried.
- deab272: `GET /api/debug/topology` (an admin key with ViewMetrics) reports the deployment's topology for the dashboard's
  Topology screen: this process as the leader alone, with its connections, subscriptions, query cache, commits per
  second, CPU and memory and a minute of samples, and the store with its driver and lease, read from counters the
  server already keeps. Each persistence driver names itself (`driver`), and the engine keeps its lease's holder and
  last renewal round trip (`leaseState`).
- Updated dependencies [eadda52]
- Updated dependencies [2088702]
- Updated dependencies [0ea0a8d]
- Updated dependencies [3f01dcf]
- Updated dependencies [a11b239]
- Updated dependencies [017ef5b]
- Updated dependencies [73835d5]
- Updated dependencies [497900c]
- Updated dependencies [61a9ab5]
- Updated dependencies [3d41523]
- Updated dependencies [beca1af]
- Updated dependencies [8700316]
- Updated dependencies [823507c]
- Updated dependencies [7d97595]
- Updated dependencies [0572b42]
- Updated dependencies [fb0c977]
- Updated dependencies [67bb45e]
- Updated dependencies [87fde6b]
- Updated dependencies [3b82fa1]
- Updated dependencies [e84cf7a]
- Updated dependencies [d1543b1]
- Updated dependencies [c3b026b]
- Updated dependencies [77572e8]
- Updated dependencies [f6745eb]
- Updated dependencies [1408599]
- Updated dependencies [88d2e14]
- Updated dependencies [0ec64a4]
- Updated dependencies [5cb27ae]
- Updated dependencies [07ad661]
- Updated dependencies [deab272]
- Updated dependencies [d2207bc]
- Updated dependencies [7b1ef5f]
- Updated dependencies [c2ac7a5]
  - @bunvex/core@0.1.0-alpha.2

## 0.1.0-alpha.1

### Minor Changes

- 3bbb247: Postgres and MySQL connections now require TLS by default and verify the server's certificate (chain and host name), as Convex does; `DO_NOT_REQUIRE_SSL` (any non-empty value) turns the requirement off, and `PG_CA_FILE` / `MYSQL_CA_FILE` add a trusted CA. Postgres sessions must be read-write (`target_session_attrs=read-write`). Convex's `POSTGRES_URL`, `MYSQL_URL` and `DATABASE_URL` are accepted as aliases of `PERSISTENCE` / `PERSISTENCE_URL`; the URL must name the database. **Breaking for local databases without TLS:** set `DO_NOT_REQUIRE_SSL=1`.
- 0fbd9b6: PERSIST-01 C11, the log by timestamp: `Persistence.readLog(afterTs, upToTs, limit)` returns the durable commits after `afterTs`, whole and in ts order, each with its index write set and the ts of the commit before it (`prevTs`). Every first-party driver implements it on a new index on `indexes.ts`, built on an existing store when the lease is acquired (MongoDB: at open). Conformance K25.

### Patch Changes

- a365529: Security: `console.log(ctx.db)`, `console.log(ctx)`, a query object or `ctx.db.system` no longer prints the engine's state into the log lines sent to the caller, the function log and the log streams (the catalog, the store, other transactions' writes, ~32 KB a line). Engine objects now print as their name, `Tx {…}`, under object-inspect, `util.inspect` and `Bun.inspect`; app values print as before (DV-321).
- 4894096: A read over an index entry whose document is missing or deleted at the snapshot (a corrupt store) now fails with `DanglingReferenceError`, as Convex does ("Dangling index reference", "Index reference to deleted document"), instead of skipping the entry, which returned fewer documents and could end a query's range early. Applies to the engine and to the Postgres, MySQL and MongoDB `scanDocs` (PERSIST-01 C15).
- Updated dependencies [419640e]
- Updated dependencies [866197d]
- Updated dependencies [9e4de66]
- Updated dependencies [659e400]
- Updated dependencies [8518f1b]
- Updated dependencies [1b56759]
- Updated dependencies [a365529]
- Updated dependencies [4fb5d5e]
- Updated dependencies [4894096]
- Updated dependencies [09edbb5]
- Updated dependencies [a7d2e6c]
- Updated dependencies [618386b]
- Updated dependencies [bcf7066]
- Updated dependencies [dff094d]
- Updated dependencies [6c0f49b]
- Updated dependencies [25c9dc9]
- Updated dependencies [da1ea24]
- Updated dependencies [f1cf707]
- Updated dependencies [c95bac7]
- Updated dependencies [fe9c7e6]
- Updated dependencies [92007b0]
- Updated dependencies [1a4930f]
- Updated dependencies [899b394]
- Updated dependencies [039d52d]
- Updated dependencies [a293cd6]
- Updated dependencies [749ad53]
- Updated dependencies [5e704cb]
- Updated dependencies [8d72c7e]
- Updated dependencies [40a120c]
- Updated dependencies [cc06646]
- Updated dependencies [9702a35]
- Updated dependencies [0fbd9b6]
- Updated dependencies [96c97c6]
- Updated dependencies [1936703]
- Updated dependencies [4495763]
- Updated dependencies [3751b64]
- Updated dependencies [e8d876e]
- Updated dependencies [4798f6d]
- Updated dependencies [9e453ce]
- Updated dependencies [20c1b83]
- Updated dependencies [2f5dc44]
- Updated dependencies [90cef9b]
- Updated dependencies [4a23a44]
- Updated dependencies [382f4b9]
- Updated dependencies [a19b158]
- Updated dependencies [4ac2aa2]
- Updated dependencies [587a148]
- Updated dependencies [81c7621]
- Updated dependencies [f3c1a64]
- Updated dependencies [2b760fe]
- Updated dependencies [9ebaaed]
- Updated dependencies [6ee62d3]
- Updated dependencies [1749e82]
- Updated dependencies [c515f8d]
- Updated dependencies [88c9ac8]
- Updated dependencies [0295b08]
- Updated dependencies [3509dc9]
- Updated dependencies [7747b60]
- Updated dependencies [841b66c]
- Updated dependencies [3e2bcf3]
- Updated dependencies [416b14b]
- Updated dependencies [509eaaa]
- Updated dependencies [b408ccd]
- Updated dependencies [f4b35bf]
- Updated dependencies [975b496]
- Updated dependencies [8bcf6de]
- Updated dependencies [e5851ce]
- Updated dependencies [1c2e062]
- Updated dependencies [1401f94]
- Updated dependencies [dc97491]
- Updated dependencies [e572862]
- Updated dependencies [f857400]
- Updated dependencies [95a77e9]
  - @bunvex/core@0.1.0-alpha.1
