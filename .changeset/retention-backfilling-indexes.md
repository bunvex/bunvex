---
"@bunvex/core": patch
---

Retention no longer prunes an index while a backfill is scanning its table; it catches up on that index once the scan is done, before the index is enabled. Before, a document changed or deleted while a long backfill ran (over the 4-minute index window) could stay in the new index as its old version. A backfill whose retention phase has started is not scanned again after a restart.
