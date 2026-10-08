---
"@bunvex/server": patch
---

A deployed code package bunvex cannot read (such as the zip in a store Convex deployed to) is no longer read by a
zip reader: it is ignored with a log line, the server starts with no code, `get_config_hashes` declares no module,
and the next deploy replaces it. Before, such a package failed every deploy (STUDY-139 P4).
