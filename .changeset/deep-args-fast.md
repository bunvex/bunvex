---
"@bunvex/server": patch
---

Arguments nested thousands of levels deep are refused with the nesting message at once, instead of after the ~1.6 s
a stack-overflowing `JSON.stringify` takes in Bun (STUDY-109).
