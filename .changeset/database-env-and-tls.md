---
"@bunvex/persistence": minor
"@bunvex/server": minor
---

Postgres and MySQL connections now require TLS by default and verify the server's certificate (chain and host name), as Convex does; `DO_NOT_REQUIRE_SSL` (any non-empty value) turns the requirement off, and `PG_CA_FILE` / `MYSQL_CA_FILE` add a trusted CA. Postgres sessions must be read-write (`target_session_attrs=read-write`). Convex's `POSTGRES_URL`, `MYSQL_URL` and `DATABASE_URL` are accepted as aliases of `PERSISTENCE` / `PERSISTENCE_URL`; the URL must name the database. **Breaking for local databases without TLS:** set `DO_NOT_REQUIRE_SSL=1`.
