---
"@bunvex/server": patch
---

Data sync follows Convex's latest. A hidden table (an import being written) is no longer synced; once active, it is truncated and walked as a new table. A by-id page that falls out of the index retention window walks the log instead of failing. Pages hold 20 000 rows by default (`DATA_SYNC_PAGE_SIZE_LIMIT`).
