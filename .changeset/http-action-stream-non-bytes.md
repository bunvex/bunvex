---
"@bunvex/server": patch
---

An HTTP action's streamed body whose chunk is not bytes (a string, a number, an object, a shared or resizable buffer) fails as Convex's: in the handler's turn the run fails with the 500, after the head the response ends cleanly with an `error:httpAction` line, both with `Uncaught Error: serde_v8 error: invalid type; expected: buffer, got: <type>`. A string chunk is no longer sent as text. A null or undefined chunk is skipped, as Convex, instead of ending the body with an error line.
