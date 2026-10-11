---
"@bunvex/core": patch
"@bunvex/server": patch
---

A failed `fetch` in an action is Convex's `TypeError`: reqwest's cause (connection refused, DNS, a closed connection) or `fetch to <url> failed: error decoding response body`, with the URL's query string, fragment and credentials dropped; an abort is Convex's `AbortError`. Redirects follow Convex's loop (20 hops, its errors and rules). Requests carry `User-Agent: Bunvex/1.0` by default and no idle timeout. bunvex's address screen reports a target it cannot reach as that failure, closes when a target closes early, and tries every address of a name.
