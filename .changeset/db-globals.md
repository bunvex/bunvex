---
"@bunvex/core": minor
"@bunvex/server": patch
---

The database globals in `_db`, as Convex's (STUDY-126): `{version, awsPrefixSecret, storageType}`, written at the store's first start. `bunvex-local-backend` pins its storage there at every start: a store started with a local directory refuses `--s3-storage` (and back) with Convex's message, a moved directory is recorded, and the S3 key prefix is `<instance name>-<uuid>/`, refused for another instance. `_instance` keeps the instance secret and name only; `Engine.instanceSetting` is replaced by `Engine.initializeStorage`.
