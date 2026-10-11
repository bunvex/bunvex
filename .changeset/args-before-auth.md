---
"@bunvex/server": minor
---

What a route checks first, as Convex's backend does (checked against its binary):

- The app metrics routes (`/api/app_metrics/*`) read their query arguments, and parse the window, `k` and the function path, before checking ViewMetrics. So bad arguments without a key are a 400, not a 403.
- The log streams read their query string before checking ViewLogs.
- A query-string error reads "Failed to deserialize query string: …".
- A path that does not parse is the same internal error Convex gives.
- The push routes (`/api/get_config_hashes`, `/api/deploy2/*`) take the admin key from the JSON body's `adminKey` only. The body is read first, with each route's request struct and serde's errors, so a body without `adminKey` is a 400 `BadJsonBody`. The `Authorization` header is not read. `bunvex deploy` and `bunvex dev` already send the key in the body.
