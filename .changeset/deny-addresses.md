---
"@bunvex/server": minor
"bunvex": minor
---

Without `--http-proxy`, bunvex screens actions' `fetch`, auth discovery and log streams itself (beyond Convex; pending owner decision DV-325): `--deny-addresses metadata` (the proposed default: link-local and cloud metadata addresses), `private` (also loopback and private networks) or `none` (Convex's behaviour). `createServer({ denyAddresses })` / `BUNVEX_DENY_ADDRESSES` for embedded servers.
