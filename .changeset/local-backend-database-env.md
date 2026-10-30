---
"@bunvex/server": patch
---

`bunvex-local-backend` (and the Docker image) reads the database variables Convex's binary reads: `POSTGRES_TIMEOUT_SECONDS`, `MYSQL_TIMEOUT_SECONDS` bound one database call, and `PG_CA_FILE` / `MYSQL_CA_FILE` add a trusted CA. They were read only by a server embedded with `persistenceConfigFromEnv`; the executable always used the defaults. The image's entry script also turns S3 on when only `S3_STORAGE_SEARCH_BUCKET` or `S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET` is set (STUDY-38 §7).
