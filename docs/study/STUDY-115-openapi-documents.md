# STUDY-115 — The deployment's OpenAPI documents

- **Status:** implemented; O1–O2 decided by the owner (2026-10-05), DV-381, DV-382
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-34](STUDY-34-admin-keys.md) (admin keys, DV-97), [STUDY-67](STUDY-67-http-function-api.md)
  (the function API), [STUDY-48](STUDY-48-audit-log.md), [STUDY-59](STUDY-59-log-streams.md),
  [STUDY-63](STUDY-63-pause-deployment.md), [STUDY-69](STUDY-69-data-sync.md), [STUDY-71](STUDY-71-usage-metering.md)

## 1. How Convex does it

`crates/local_backend/src/router.rs` builds three OpenAPI documents with utoipa (`OpenApiRouter`, each
handler's `#[utoipa::path]` annotation) and serves each as the `String` that `to_pretty_json()` returns.

| URL | Document | Built from |
|---|---|---|
| `GET /api/v1/openapi.json` | `PlatformApiDoc` (router.rs:236-259) | `platform_router()` of environment_variables.rs, deployment_audit_log.rs, deployment_info.rs, usage_limits.rs, canonical_urls.rs, log_sinks.rs, deployment_state.rs, streaming_export.rs (router.rs:366-382) |
| `GET /api/dashboard_openapi.json` | `DashboardApiDoc` (router.rs:274-285) | `common_dashboard_api_router()` (dashboard.rs:345-356) and `local_only_dashboard_router()` (dashboard.rs:340, empty) (router.rs:294-317) |
| `GET /api/public_openapi.json` | `PublicApiDoc` (router.rs:261-272) | `public_api_router()` (public_api.rs:769-783) (router.rs:394-410) |

- **No auth.** The routes are plain axum `get` closures returning the text; no extractor checks a key.
- **Format.** `serde_json`'s pretty printer: two-space indent. An axum `String` is answered as
  `text/plain; charset=utf-8`. A `get` route also answers HEAD; another method is 405 with `allow: GET,HEAD`.
  The routes sit under `/api`, so the CORS layer applies.
- **Info.** `openapi: "3.1.0"`; `info.title`, `info.description`, `info.version: "1.0.0"`, and
  `info.license` from the crate (`LicenseRef-FSL-1.1-Apache-2.0`).
  - Platform: "Convex Deployment API", "Admin API for interacting with deployments."; server
    `{deployment-url}/api/v1` with a `deployment-url` variable.
  - Dashboard: "Convex Dashboard HTTP routes", "Endpoints intended for dashboard use"; server `/api`.
  - Public: "Convex Public HTTP routes", "Endpoints that require no authentication"; server `/api`.
- **Security** (platform only, `SecurityAddon`, router.rs:167-233): four `apiKey` schemes on the
  `Authorization` header: "Deploy Key", "OAuth Team Token", "Team Token" and "OAuth Project Token", each
  described with the `Convex <token>` prefix. Every platform operation lists the four. An "Admin Key" `http`
  bearer scheme is written but commented out. The dashboard and public documents declare no security, though
  `/api/function` and the dashboard routes need an admin key.
- **Operations.** Each has `tags`, `summary` and `description` (the doc comment), `operationId` (the
  handler's name, or an explicit one: `get deployment info`), `parameters`, `requestBody` (always
  `required: true`, from the `Json` extractor), and `responses` with a `200` whose `description` is `""`.
  - Platform: `update_environment_variables`, `list_environment_variables`, `list_audit_log_events`,
    `deployment_info`, `get_current_usage` (tags `Usage Limits`, `beta`), the four usage limit routes,
    `update_canonical_url`, `get_canonical_urls`, the six log stream routes, `pause_deployment`,
    `unpause_deployment`, `data/sync`, `data/list_active_syncs`, `data/sync/{sync_id}` (tags `Data Sync`,
    `pro`).
  - Dashboard: `check_admin_key` (tag `public_api`), `shapes2`, `get_indexes`, `delete_tables`,
    `delete_component`, `delete_scheduled_functions_table`.
  - Public: `/query` GET and POST, `/query_ts`, `/query_at_ts`, `/query_batch`, `/mutation`, `/action`,
    `/function`, `/run/{*functionIdentifier}` (axum's wildcard syntax, kept in the path key).
- **Schemas.** `components.schemas`, sorted by name, from each type's `ToSchema` derive: serde's renames,
  tagged enums as `oneOf` (with `allOf` for the internally tagged log stream configs), `Option` as
  `["T", "null"]`, `u64` as `integer`/`int64`/`minimum: 0`, `serde_json::Value` as `{}`. Three selection types
  are registered explicitly (utoipa issue 1330).
- **Consumers.** Build time only: the documents are checked in at `npm-packages/@convex-dev/platform/
  deployment-openapi.json`, `public-deployment-openapi.json` and `npm-packages/dashboard/
  dashboard-deployment-openapi.json`, and `openapi-typescript` turns them into `@convex-dev/platform`'s types
  (`generateDeploymentApiSpec`). Nothing fetches the URLs at run time.

## 2. What an app can observe

- The three URLs answer 200 with the text, without a key, with CORS.
- A client generated from a document (openapi-typescript, openapi-fetch) gets the paths, operation ids,
  parameters and request and response types; they must be what the server takes and answers.
- The security scheme tells a generated client which header to send.

## 3. How bunvex does it

`packages/server/src/openapi.ts` holds one table, `OPENAPI_OPERATIONS`: per route, its document, method,
path, operation id, tags, summary, description, parameters, request schema and response schema.
`openApiDocument(doc)` builds a document from it, in utoipa's key order, with the schemas of
`openapi-schemas.ts`; `openApiText(doc)` is `JSON.stringify(…, null, 2)` (the same layout as serde's), built
once. The API server answers the three URLs before any other route, with no auth, as Convex (text/plain,
HEAD, 405 with `allow: GET,HEAD`, CORS from the existing layer).

- **Paths, operation ids, parameters, schemas:** Convex's, for every route bunvex has. The schemas were
  taken from the structure of Convex's checked-in documents, with bunvex's wire names where bunvex already
  differs: `bunvexCloud` / `bunvexSite` and `bunvexCloudUrl` / `bunvexSiteUrl` (DV-278),
  `actionComputeIsolateGbHours` (DV-308). Tags are Convex's, `beta` and `pro` included.
- **Left out** (`OPENAPI_LEFT_OUT`, DV-381): Convex's routes bunvex does not answer.

  | Route | Document | Reason |
  |---|---|---|
  | `GET /api/v1/deployment_info` | platform | not built yet (a self-hosted Convex answers `{kind: "selfHosted"}`) |
  | `GET /api/get_indexes` | dashboard | not built yet (the dashboard reads indexes through system queries) |
  | `POST /api/delete_component` | dashboard | not built yet (bunvex has no components yet, [STUDY-62](STUDY-62-components.md)) |

  None is "n/a": each could be built. (`POST /api/delete_scheduled_functions_table` was left out too until
  STUDY-113 built it; it is documented since, as in Convex's dashboard document.)
- **Wording and security** (DV-382): bunvex's titles ("bunvex Deployment API", …), descriptions, server
  description and default URL (`http://127.0.0.1:3210`), license (`Apache-2.0`), and fewer schema field
  descriptions. One security scheme, "Admin Key": `apiKey` in `Authorization`, `Bunvex <admin_key>`.
  - That is what the platform routes take: `callerOfRequest` reads `Bunvex <key>` (any case) as an admin
    (DV-97), and `?adminKey=` when there is no header. `Bearer <jwt>` is a user, whom every platform route
    refuses. bunvex has no deploy keys apart from admin keys, and no teams, team tokens or OAuth apps, so
    Convex's four schemes have nothing to name.
  - As Convex, the dashboard and public documents declare no security. The public document's description
    says a request may carry a user's token or an admin key, instead of Convex's "require no authentication".
- **Drift.** Restructuring the router around the table would mean rewriting `server.ts`'s regex dispatch,
  so the table sits next to the documents, and:
  - the router answers under `/api/v1/` only the paths the table documents (`isPlatformPath`); any other
    `/api/v1/` path is 404 `NotFound` before a handler runs, so a platform route cannot be served without being
    documented;
  - `openapi.test.ts` calls every documented route (below), so a route cannot be documented without being
    served;
  - every left-out route must answer 404.

  The gate costs 3–9 ns a request outside `/api/v1/` and about 30 ns inside it (a microbenchmark of the added
  checks).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| O1 (DV-381) | The documents list only the routes bunvex answers; Convex's `deployment_info`, `get_indexes` and `delete_component` are left out (`delete_scheduled_functions_table` too until STUDY-113 built it) | Not built yet; a document that lists a route the server 404s would mislead a generated client | owner, 2026-10-05 |
| O2 (DV-382) | bunvex's titles, descriptions, server and license; one "Admin Key" scheme, `Authorization: Bunvex <admin_key>`, instead of Convex's four `Convex <token>` schemes | Rule 5, and bunvex's actual auth: admin keys only (no team or OAuth tokens) | owner, 2026-10-05 |

The wire names inside the schemas (DV-278, DV-308) are earlier decisions, not new ones. A third reserved
number, DV-383, was not needed.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/server/test/openapi.test.ts`:

- **Valid OpenAPI 3.x:** a small checker (no new dependency): `openapi` 3.x.y, `info`, server variables,
  security schemes, unique operation ids, every `$ref` resolved, path parameters declared, required and in
  the template, responses with descriptions, security names defined. A test breaks a copy of a document four
  ways and checks the checker reports each.
- **Convex's shape:** the operation ids in Convex's order (minus the left-out ones), the `{*functionIdentifier}`
  path key, the admin key scheme on every platform operation, bunvex's wire names, no "convex" in the text.
- **JSON snapshot:** `test/fixtures/openapi/{platform,dashboard,public}.json`, the exact text served
  (`UPDATE_OPENAPI_SNAPSHOT=1` rewrites them; excluded from Biome's formatter, which would reflow them).
- **Served:** each URL answers 200 without a key (and with a bad one), `text/plain; charset=utf-8`, the
  text; HEAD has no body; POST is 405 `GET,HEAD`; CORS mirrors the origin.
- **Drift, documented → served:** every documented operation is called once on a server, with a body that
  its request schema accepts. The answer must be 200 and match its response schema, strictly: no field the
  schema does not name. The test checks that every operation in the table was called. The audit log is read
  last, so its `action` enum and actor are checked against real events of the calls before it.
- **Drift, served → documented:** each left-out route answers 404 "no route"; undocumented `/api/v1/` paths
  (`/api/v1/nope`, `/api/v1/list_log_streams/x`, …) are 404 through the gate.
- **The scheme is the server's:** `Bunvex <key>` (any case) is accepted on a platform route; no header and
  `Bearer` are not.

The documents were also diffed structurally (descriptions aside) against Convex's checked-in ones: the only
differences are the left-out routes and their schemas, and the DV-278 / DV-308 names.

Sabotage (each restored after):

| Sabotage | Failed |
|---|---|
| S1: the `/api/v1/` gate off | left-out / undocumented 404 (`/api/v1/list_log_streams/x` answered 200) |
| S2: a response schema field renamed (`bunvexSiteUrl` → `siteUrl`) | snapshot; every route as documented |
| S3: a documented path wrong (`/list_usage_limit`) | snapshot; every route as documented |
| S4: a documented method wrong (`get_canonical_urls` as POST) | snapshot; every route as documented |
| S5: the server answers an undocumented field (`list_environment_variables`) | every route as documented |
| S6: served as `application/json` | served at Convex's paths |
| S7: `RequestDestination` values changed | Convex's shape / wire names; snapshot; every route as documented |

## 6. Open questions

None.
