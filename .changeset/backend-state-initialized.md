---
"@bunvex/core": patch
---

`_backend_state` gets its one document, running (`{system, usage_limit, user}` all `"none"`), at the store's first start, as Convex writes it when it creates the table (STUDY-134, DV-427).
