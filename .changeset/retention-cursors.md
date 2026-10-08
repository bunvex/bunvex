---
"@bunvex/core": patch
---

Retention's cursors and document window follow Convex's (STUDY-133 §12 M11): a pass prunes the versions below its window and a caught-up cursor (`confirmed_deleted_ts`) is the window − 1; the document window never passes the index cursor last recorded, so the index deleter always finds the versions it derives keys from.
