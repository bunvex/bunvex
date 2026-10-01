---
"@bunvex/core": minor
"@bunvex/persistence": minor
"@bunvex/persistence-conformance": minor
---

PERSIST-01 C11, the log by timestamp: `Persistence.readLog(afterTs, upToTs, limit)` returns the durable commits after `afterTs`, whole and in ts order, each with its index write set and the ts of the commit before it (`prevTs`). Every first-party driver implements it on a new index on `indexes.ts`, built on an existing store when the lease is acquired (MongoDB: at open). Conformance K25.
