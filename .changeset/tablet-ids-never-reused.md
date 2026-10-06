---
"@bunvex/core": patch
---

A table's persistence id (tablet) is never reused, as Convex's random tablet ids (STUDY-04 §7, DV-408). Tablets come from a counter in `_next_tablet_id`, written with the tables each transaction creates. Before, a new table took the highest stored tablet + 1, so a purged newest table's id went to the next table.
