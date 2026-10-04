---
"@bunvex/server": patch
"@bunvex/client": patch
"@bunvex/cli": patch
---

Value formats and the isolate compute metric carry bunvex's names (DV-307, DV-308). `format` (HTTP function API and streaming export) accepts `json` or `clean_json`, `encoded_json` and `export_json`; Convex's `convex_encoded_json`, `convex_clean_json` and `convex_json` are now a 400 `BadFormat`. `BunvexHttpClient` and the CLI ask for `encoded_json`, so a client and a server from before this change do not mix. The usage-limit metric `actionComputeConvexGbHours` is now `actionComputeIsolateGbHours`.
