---
"@bunvex/server": patch
---

No frame or path of the server reaches what an app sees of an error. In pushed code, `error.stack` is formatted as Convex's: in V8 the app's frames alone, mapped to its sources; in a `"use node"` action `Error: <message>` and those frames. An error the engine throws (`db.*`, the scheduler, storage, nested calls) carries the app's frames where it awaited the call (`at async …`), in the client's message, in `error.stack` and in logged lines. A pushed module's `BunvexError` is a class of its own realm, still `instanceof`-compatible with the engine's.
