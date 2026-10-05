---
"@bunvex/server": minor
---

The health routes, as Convex's (STUDY-112): `GET /instance_version` and `GET /version` (also on the site port) answer `@bunvex/server`'s version instead of `bunvex`; `GET /` answers that the deployment is running; `POST /echo` streams the body back, up to `MAX_ECHO_BYTES` (default 128 MiB; 413 past it). No auth, CORS as the API's; another method is a 405 with `allow`.
