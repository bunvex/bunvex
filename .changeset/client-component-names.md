---
"@bunvex/server": patch
---

Security fix: over the WebSocket, a client without an admin key could reach a mounted component's public queries, mutations and actions (the HTTP routes already refused it). As on Convex, only a component path, which only an admin or the system may give, now reaches a component; a client's function path is always the app's. Upgrade if your app mounts components, `@bunvex/auth` included.
