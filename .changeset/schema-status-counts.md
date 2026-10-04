---
"@bunvex/core": patch
---

A push that changes an existing index's fields waits for the new index to backfill, as Convex's does. The schema status (`wait_for_schema`) counts every index the deployment has, the enabled old version and the new one backfilling included, and skips staged ones. Before, it counted the schema's indexes by name. The old version made the push look complete, and `finish_push` then failed with "The schema's indexes are still backfilling".
