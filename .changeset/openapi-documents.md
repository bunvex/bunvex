---
"@bunvex/server": minor
---

The deployment serves its OpenAPI 3.1 documents, as Convex: the platform API at `GET /api/v1/openapi.json`, the dashboard routes at `/api/dashboard_openapi.json` and the function API at `/api/public_openapi.json`, as pretty JSON with no auth. They document the routes bunvex has, with Convex's paths, operation ids and schemas; the platform API's security scheme is the admin key, `Authorization: Bunvex <key>` (STUDY-115). Any other `/api/v1/` path is 404.
