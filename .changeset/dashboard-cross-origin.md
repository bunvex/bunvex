---
"@bunvex/server": patch
---

`/stats` is behind the API's CORS layer, so the dashboard on its own origin (its image, `bunvex dashboard serve`) can read it: its preflight is answered before the admin check, and its answers carry the origin. The health and CLI routes' answers carry the `vary` list twice, as Convex's. The dashboard reads the version from `/instance_version` (the meta `/version` stays outside the layer, as Convex's), so its header shows the deployment instead of "Deployment unavailable".
