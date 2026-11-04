---
"@bunvex/core": patch
"@bunvex/server": patch
---

`list_snapshot` now reads snapshots older than 4 minutes, so a connector whose initial sync of one snapshot takes longer no longer restarts. It used to answer `SnapshotTooOld` once the index retention window had passed the snapshot. It now reads the snapshot through the table iterator, kept between calls, up to the 5-day limit. Its tables and component paths are the snapshot's: a table deleted since is still listed, and one created since is not. A whole listing is also faster, because each page is read once.
