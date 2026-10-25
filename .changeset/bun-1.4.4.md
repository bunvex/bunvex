---
"@bunvex/core": patch
"@bunvex/server": patch
"@bunvex/helpers": patch
---

Require Bun 1.4.4 or newer. CI, the Docker images and every package's `engines.bun` move off 1.4.2.

A proxy that does not open an `https:` CONNECT fails with Convex's tunnel message: `proxy authorization required` for a 407, `unsuccessful` for any other status (before, the proxy's own 403 or 502 reached the app as a response). Bun 1.4.4 throws that refusal instead of answering it. An `https:` target that bunvex's address screen cannot reach still fails as it would without the screen. After an external package is installed, assigning `process.env` still writes the server's own environment.
