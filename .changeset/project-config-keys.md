---
"@bunvex/cli": minor
"@bunvex/server": minor
---

`bunvex.json` reads Convex's remaining keys (STUDY-145): `node` and `bundler` are checked with Convex's messages, in its schema's key order. `node.nodeVersion` is sent with the push; the deployment takes "20", "22" and "24", refuses "18" and anything else with Convex's 400 `InvalidConfig` messages, stores it in `_source_packages.nodeVersion`, answers it from `get_config_hashes` and diffs it in the audit log's `node_version_diff` (Node actions still run in Bun). `bundler.includeSourcesContent` keeps the original sources in the pushed source maps; by default they are left out, as Convex's esbuild does. The push sends `functions` as configured.
