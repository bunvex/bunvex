---
"@bunvex/core": patch
---

Internal: `BUNVEX_FREEZE_ENGINE_VALUES=1` freezes the values the engine keeps, so a missed copy throws in the tests instead of corrupting data. Off outside the tests.
