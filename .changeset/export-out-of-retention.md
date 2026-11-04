---
"@bunvex/core": patch
"@bunvex/server": patch
---

A snapshot export that takes longer than 4 minutes now completes. It used to read every page at its snapshot's timestamp, which the index retention window passes after 4 minutes, so the export of a large deployment failed with `OutOfRetention`, retried at a new snapshot, and failed again. It now reads its snapshot as a table iterator does: each page of a table at a recent timestamp, and each document changed since the snapshot at its version then, from the document log. The snapshot can be up to the document retention window old (14 days). `TableIterator` is exported from `@bunvex/core`.
