---
"@bunvex/server": minor
---

One sync connection holds at most 4096 queries by default. `BUNVEX_MAX_QUERIES_PER_CONNECTION` raises the cap, and `0` turns it off. A `ModifyQuerySet` that would take the connection past the cap closes it with `BadRequest`, before any of the frame is applied.
