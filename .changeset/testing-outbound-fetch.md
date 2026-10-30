---
"@bunvex/testing": minor
"@bunvex/server": patch
---

`bunvexTest({ outboundFetch })` answers the requests a test deployment's actions send with `fetch`, instead of the network: each arrives as it would go out (the app's headers, the default `User-Agent`, the body; redirects followed one request at a time), and a handler that throws is the action's failed `fetch`. It works under the function sandbox too.
