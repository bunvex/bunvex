---
"@bunvex/core": patch
"@bunvex/helpers": patch
---

Require Bun 1.4.4 or newer. CI, the Docker images and every package's `engines.bun` move off 1.4.2.

A proxy that refuses an `https:` CONNECT still fails with Convex's tunnel message: Bun 1.4.4 throws that refusal instead of answering 407. After an external package is installed, assigning `process.env` still writes the server's own environment.
