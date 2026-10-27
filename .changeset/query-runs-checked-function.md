---
"@bunvex/server": patch
---

A query runs the function its arguments were checked against. Code that landed while the query waited for its permit no longer ran the new handler on arguments only the old validator had accepted.
