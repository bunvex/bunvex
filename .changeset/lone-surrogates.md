---
"@bunvex/values": patch
"@bunvex/core": patch
"@bunvex/server": patch
---

A string with a lone surrogate (`"\ud800"`) is refused where Convex refuses it (STUDY-135). Writes, queries, nested calls and the scheduler fail with "Received invalid json: …", with serde's column. A function's result with one fails the function, and a client's arguments with one are "Invalid arguments provided". Log lines and error messages show U+FFFD in its place, and an application error whose data holds one has no data.
