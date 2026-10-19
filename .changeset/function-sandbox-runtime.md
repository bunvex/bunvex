---
"@bunvex/server": patch
---

The push evaluates its auth config and schema through the function executor (`evaluateDefault`), with no change in behaviour, and `@bunvex/server/executor` exports the executor seam for the function sandbox's child runtime (STUDY-171 §7).
