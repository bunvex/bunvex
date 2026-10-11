---
"@bunvex/server": minor
---

Streaming import's first routes (STUDY-141 PR 1), as Convex's `/api/streaming_import/*`, with ImportBackups:

- `PUT clear_tables {tableNames}`: the tables are emptied in one commit, keeping their numbers and indexes. A missing table is created. One `clear_tables` audit event is recorded.
- `GET get_schema`: the active schema's JSON, or `null`.
- `POST replace_tables`: always `OverwriteNotSupported`.

Names are made valid as Convex makes them (`source_` and a slug, transliterated as the `unidecode` crate does). The other streaming import routes are not built yet.
