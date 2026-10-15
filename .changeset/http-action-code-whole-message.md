---
"@bunvex/server": patch
---

An HTTP action's 500 `code` carries the error's message whole, as Convex's: every line of a multi-line message, a trailing newline, and a nested call's frames that are part of its message (`Server Error: Uncaught Error: line one\nline two`). It used to keep the first line only.
