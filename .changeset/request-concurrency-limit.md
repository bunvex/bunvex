---
"@bunvex/server": minor
---

The HTTP server serves at most 128 requests at once, the API's and the site's together, as self-hosted Convex (`ConvexHttpService`); past it a request waits its turn, first come first served, with no error. A request holds its permit until its response head (a streamed body does not count), the wait does not count toward the 300 s timeout, and WebSocket upgrades and `/version` are exempt. `HTTP_SERVER_MAX_CONCURRENT_REQUESTS` sets the limit (DV-364); `createServer` takes `maxConcurrentRequests` (STUDY-110).
