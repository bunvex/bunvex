---
"@bunvex/core": patch
---

Staged validators are validated against the existing documents in the background, as Convex's: after a push with staged validators (and at a start), once the pending schema's own walk is done, each staged row still pending is walked (the active, then the validated, then the pending schema's; tables in name order) and becomes valid, or failed at the first document that does not match (`Document with ID "…" in table "…" does not match the schema: …`). A table that does not exist, or whose shape or enforced validator proves the staged one, is valid without a walk. The push never waits for it (DV-438, STUDY-106 §7.3).
