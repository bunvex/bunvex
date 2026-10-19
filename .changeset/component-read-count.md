---
"@bunvex/core": patch
"@bunvex/server": patch
---

A component's function counts its start reads as Convex's backend does (STUDY-161 §16.7): its own modules (with the chunk Convex's library would be in) and one more read, and a component's write no longer counts its mounted check against the read limit.
