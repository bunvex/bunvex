---
"@bunvex/persistence": minor
"@bunvex/server": minor
---

The MongoDB driver is removed, as Convex has none: `@bunvex/persistence/mongodb`, `PERSISTENCE=mongodb`, `bunvex-local-backend --db mongodb` and `MONGODB_TIMEOUT_SECONDS` are gone (`PERSISTENCE=mongodb` is now refused as an unknown driver). To move a MongoDB deployment, export it with 0.1.0-alpha.2 (`bunvex export`) and import it into SQLite, Postgres or MySQL. The PERSIST-01 suite stays public, for drivers of other packages.
