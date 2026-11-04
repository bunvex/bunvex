---
"@bunvex/core": patch
---

The memory store's log no longer loses acknowledged commits. A write that the OS completes only in part is now finished before the commit is acknowledged. After a write or sync fails, nothing more is appended to the log. Opening a log whose damaged record has complete records after it now fails with an error and leaves the file whole. Before, the log was cut at the damaged record, which permanently discarded every commit after it.
