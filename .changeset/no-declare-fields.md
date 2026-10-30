---
"@bunvex/values": patch
"@bunvex/core": patch
---

The type-only class fields (a validator's `type`, `SearchFilter`'s brand, `TableSummariesUnavailableError`'s `code`) are declared by merging an interface instead of `declare` fields, so Babel reads the sources without `allowDeclareFields` (an Expo app in a workspace). Nothing changes at run time.
