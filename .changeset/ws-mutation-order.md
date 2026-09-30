---
"@bunvex/server": minor
---

A WebSocket connection's mutations run one at a time, in the order they were sent, as in Convex; more than 1000 pending mutations close the connection with 1013 `TooManyConcurrentMutations`.
