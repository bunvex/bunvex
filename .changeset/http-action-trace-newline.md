---
"@bunvex/server": patch
---

An HTTP action's 500 keeps the newline at the end of its `trace`, as Convex's: after the last frame, or after the message when the error has none (`"Uncaught a string\n"`).
