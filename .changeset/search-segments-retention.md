---
"@bunvex/core": minor
"@bunvex/server": patch
---

Search index workers as Convex's (STUDY-111): every `DATABASE_WORKERS_POLL_INTERVAL`, a memory part older than `SEARCH_WORKERS_MAX_CHECKPOINT_AGE` is flushed and idle indexes are fast-forwarded in the new `_index_worker_metadata` system table, so a start replays nothing older and document retention never overtakes an idle index.
