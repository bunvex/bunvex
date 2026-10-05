---
"@bunvex/server": patch
---

A pushed module that does not compile or link reports `Uncaught SyntaxError: <message>` alone, as Convex's isolate does, without the server's own frames (STUDY-95 §6).
