---
"@bunvex/core": patch
---

`withIndex` range errors now read exactly as Convex's (`IndexRange::split`, crates/common/src/query.rs):
- A second equality on a field names the value already there, not the new one.
- An equality and a bound on the same field is Convex's "Already defined inequality bound in index range. Can't add "<field>" == <value>." instead of an index-order error.
- Values print as Convex's `Display` (`1.0`, not `1`).

Found by the generated differential tests (STUDY-122 phase 2).
