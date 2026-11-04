---
"@bunvex/server": patch
---

A mutation sent over the WebSocket runs as the user who sent it, as on Convex: its identity and session are taken as it arrives. Before, a mutation still waiting in the connection's queue took whatever identity was current when it started, so an account switch or a sign-out sent after it changed who it ran as.
