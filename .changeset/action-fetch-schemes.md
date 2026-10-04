---
"@bunvex/core": patch
"@bunvex/server": patch
---

An action's `fetch` takes `http:` and `https:` only, as Convex: another scheme (`file:`, `data:`, `s3:`, …) is Convex's `TypeError`, and Bun's own options (`unix`, `proxy`, `tls`, `s3`) are ignored. A `"use node"` action's `fetch` fails as Node's on what Node's refuses.
