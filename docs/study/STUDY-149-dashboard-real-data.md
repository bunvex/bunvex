# STUDY-149 — The dashboard on real data: how Convex's dashboard reads a deployment

- **Status:** decided (owner, 2026-10-12); PR 1 built (`@bunvex/dashboard-source`, §5 "PR 1, as built"); PRs 2–5
  built (§5); PR 6 built (`apps/dashboard` on the real source, §5 "PR 6, as built"); PR 7 built (packaging: the
  dashboard's image, `dashboard.zip`, the local dashboard, `bunvex dashboard serve`, §5 "PR 7, as built"), and its follow-up, the server's frame and security headers (§5 "PR 7 follow-up", DV-488); PR 8 built
  (the CLI's dashboard links, DV-477, and the user docs, `docs/dashboard.md`, §5 "PR 8, as built") — **the plan is
  done**. Q1: option B, a
  separate service with its own image (DV-475); Q3: rename (DV-474); Q4: Convex's model plus a `Host` check
  (DV-476); Q5: local links only (DV-477, replaces DV-217); Q2, Q6, Q7 confirmed as planned; AD-32 not taken.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`npm-packages/dashboard-common`,
  `dashboard-self-hosted`, `dashboard`, `system-udfs/convex/_system/frontend`, `@convex-dev/platform`,
  `convex/src/cli`, `self-hosted/docker`, `crates/local_backend`, `crates/application`)
- **Related:** [STUDY-12](STUDY-12-dashboard.md) (the screens, built on the mock; D1 and D3 decided),
  [UI-01](../specs/UI-01-ui-and-dashboard.md) §5 (the `DashboardDataSource` contract, §5.7 the proposed HTTP
  source), [STUDY-34](STUDY-34-admin-keys.md) (admin keys), [STUDY-38](STUDY-38-docker.md) K3 (DV-189),
  [STUDY-39](STUDY-39-standalone-binary.md) B2 (DV-194), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md)
  L6 (DV-202), [STUDY-42](STUDY-42-import-export.md) X3 (DV-217), [STUDY-48](STUDY-48-audit-log.md) (audit
  log), [STUDY-58](STUDY-58-app-metrics.md) (app metrics), [STUDY-119](STUDY-119-run-inline-query.md)
  (`run_test_function`), [STUDY-146](STUDY-146-cli-network-test-docs-update-dashboard.md) (`bunvex dashboard`);
  [parity: platform §21](../parity/platform.md), roadmap item 12

STUDY-12 is about the **screens**: what each one shows and how bunvex drew it on the mock. This study is about
the **wire**: what Convex's dashboard calls on a deployment, how often, with which credentials, how it is
packaged and connected, and how bunvex's dashboard gets a real data source in place of the mock. It does not
repeat STUDY-12's screen descriptions.

In the citations, `dc/` is `npm-packages/dashboard-common/src/`, `sh/` is
`npm-packages/dashboard-self-hosted/src/`, `cl/` is `npm-packages/dashboard/src/`, `lb/` is
`crates/local_backend/src/`, and `udfs` is `api._system.frontend` (`dc/udfs.ts:1-6`), the functions in
`npm-packages/system-udfs/convex/_system/frontend/`.

## 1. How Convex does it

### 1.1 Two channels, one credential

Convex's dashboard talks to a deployment over exactly two channels, both with the admin key.

1. **The sync WebSocket, as an admin.**
   - `DeploymentApiProvider` builds a `ConvexReactClient(deploymentUrl)` and calls
     `client.setAdminAuth(adminKey)` before anything subscribes (`dc/lib/deploymentContext.tsx:524-531`).
   - A rotated key is pushed into the open socket without a new client (`:576-580`).
   - On the wire this is `{type: "Authenticate", tokenType: "Admin", value, impersonating}`
     (`npm-packages/convex/src/browser/sync/local_state.ts:220-241`), on `/api/{version}/sync`
     (`lb/router.rs:291`, `:402`).
   - Every `useQuery` / `usePaginatedQuery` of a `udfs.*` function is therefore a **reactive subscription**,
     and every `useMutation` a WebSocket mutation. `useSystemQuery` (`dc/lib/useSystemQuery.ts:20-41`) is a
     thin wrapper over the same hook.
   - The dashboard calls `_system/frontend/*` only; `_system/cli/*` is the CLI's.
2. **The HTTP admin API.**
   - `useDeploymentAuthHeader()` returns `` `Convex ${adminKey}` `` (`dc/lib/deploymentApi.ts:14-36`).
   - `deploymentFetch` sends `Authorization: Convex <adminKey>` and `Convex-Client: dashboard-0.0.0`
     (`dc/lib/fetching.ts:93-117`); SWR keys include the URL, path and header (`deploymentApi.ts:91-104`).
   - The `/api/v1/*` platform routes go through `createDeploymentClient(url, key)` with the same header
     (`npm-packages/@convex-dev/platform/src/client.ts:46-63`).
   - **One exception:** `POST /api/run_test_function` (the custom query) carries the admin key **in the JSON
     body** (`adminKey`), with no `Authorization` header (`dc/features/functionRunner/lib/client.ts:50-105`;
     the route is in `cli_routes`, `lb/router.rs:333`; the handler `lb/dashboard.rs:291-330`).

On the server, `extract_admin_key` strips a case-insensitive `convex ` prefix, and an optional
`:<base64 identity>` suffix means "an admin acting as a user" (`lb/authentication.rs:106-128`, `:168-205`).
Each system function and route then checks a named operation (`DeploymentOp`), e.g. the log stream needs
`ViewLogs` (`crates/application/src/lib.rs:1031-1033`).

A watchdog polls `client.connectionState()` every 2 500 ms (`dc/lib/deploymentContext.tsx:819-879`;
`sh/pages/_app.tsx:332`) and shows the disconnect overlay; for a `local-*` deployment it also fetches
`/instance_name` (`:796`).

`dc/lib/usePausedLiveData.ts` guards the busiest live lists (scheduled jobs, files): past 100 updates in 10 s
it **auto-pauses** the subscription and switches to one-shot `client.query()` calls on a second admin client
(`:9-11`, `:102-142`), until the user presses "Go live".

### 1.2 Per screen: mechanism, freshness and calls

"Live" = a reactive query over the WebSocket. "Poll N s" = SWR `refreshInterval`. "Long-poll" = an HTTP
request the server holds until there is data or 60 s pass. "Once" = fetched when the view opens or the user
acts.

| Screen / part | Mechanism | Function or route | Freshness | Call site |
|---|---|---|---|---|
| **Data** — table list | WS query | `getTableMapping` | live | `dc/lib/useTableMetadata.tsx:26` |
| Data — component switcher | WS query | `components.list` | live | `dc/lib/useNents.ts:32-35` |
| Data — documents | WS paginated query | `paginatedTableDocuments {table, filters, componentId}` | live; `"skip"` after 1 min idle | `dc/features/data/components/Table/utils/useQueryFilteredTable.ts:22,43,49-54` |
| Data — row count | WS query | `tableSize` | live | `DataContent.tsx:96` |
| Data — indexes | WS query | `indexes {tableName, tableNamespace}` | live | `DataContent.tsx:286`, `IndexList.tsx:25` (`/api/get_indexes` exists, `lb/dashboard.rs:216`, but is not called) |
| Data — schema | WS query | `getSchemas` | live | `DataView.tsx:67`, `TableSchema.tsx:78,260` |
| Data — inferred shapes | HTTP GET | `/api/shapes2[?component=]` | **poll 60 s** | `dc/lib/deploymentApi.ts:48-77` (`refreshInterval: 60000`, `:61`); `lb/dashboard.rs:89-97` |
| Data — id references | WS query | `getTableMapping`, `listById` | live | `DataCell.tsx:541,546`, `useIdDecorations.tsx:36,56` |
| Data — add / patch / replace / delete | WS mutation | `addDocument`, `patchDocumentsFields`, `replaceDocument`, `deleteDocuments` | once | `dc/features/data/lib/useDataToolbarActions.ts:44,63,66`; `useToolPopup.tsx:228` |
| Data — clear table | WS mutation, looped on a cursor | `clearTablePage {tableName, cursor}` (4 000 per call) | once | `ClearTableConfirmation.tsx:59`; `system-udfs/…/clearTablePage.ts:5` |
| Data — create table | WS mutation | `createTable` | once | `DataSidebar.tsx:105` |
| Data — delete tables | HTTP POST | `/api/delete_tables {tableNames, componentId}` | once | `dc/features/data/lib/api.ts:13-29` |
| Data — table metrics | HTTP GET | `/api/app_metrics/table_rate` | once (chart open) | `dc/lib/appMetrics.ts:758-785`; `BigChart.tsx:38-60` |
| **Schema** | WS query + HTTP | `getSchemas`, `getSchemas:schemaValidationProgress`; `/api/shapes2` | live; shapes poll 60 s | `dc/features/schema/components/SchemaView.tsx:46-54` |
| **Functions** — module tree | WS query | `modules:listForAllComponents` | live | `dc/lib/functions/useListModules.ts:23-26` |
| Functions — summary | WS query | `getVersion`, `convexSiteUrl`, `components.list` | live | `FunctionSummary.tsx:37`; `useHttpActionRoute.ts:24-28` |
| Functions — statistics | HTTP GET | `/api/app_metrics/{udf_rate, cache_hit_percentage, latency_percentiles}` | **once** per window (no interval) | `dc/lib/appMetrics.ts:649-753`; `SingleGraph.tsx:32-41` |
| Functions — invalidations (mutations) | HTTP GET | `/api/app_metrics/subscription_invalidations_top_k` | poll 8 s | `appMetrics.ts:513-559` (`:555`) |
| Functions — logs | long-poll | as Logs, filtered | long-poll | `FunctionLogs.tsx:140` |
| **Runner** — query | WS query on a second admin client (impersonation via `setAdminAuth(key, identity)`) | the function itself, `watchQuery` | live | `dc/features/functionRunner/lib/client.ts:14-48`; `QueryResult.tsx:94` |
| Runner — mutation / action | WS request | `mutationInternal` / `actionInternal` | once | `FunctionTester.tsx:583-608` |
| Runner — the run's log lines | long-poll | `/api/app_metrics/stream_function_logs?…&sessionId&clientRequestCounter` | long-poll | `dc/lib/useLogs.ts:318-354`; server filter `lb/logs.rs:85-127` |
| Runner — argument validator, paused banner | WS query | `modules:argsValidator`, `deploymentState:deploymentState` | live | `FunctionTester.tsx:188`; `FunctionRunnerWrapper.tsx:40` |
| **Custom query** | HTTP POST | `/api/run_test_function {bundle: {path, source}, adminKey, componentId, args, format: "convex_encoded_json"}`; types from `getSchemas` | once (Run) | `functionRunner/lib/client.ts:50-105`; `FunctionEditor.tsx:205,265-286` |
| **Logs** | long-poll | `GET /api/app_metrics/stream_function_logs?cursor=<ms>` | long-poll (60 s) | `dc/lib/appMetrics.ts:69-110`; loop `dc/lib/useLogs.ts:204-275` |
| Logs — deployment events | WS paginated query | `paginatedDeploymentEvents {filters: {minDate, actions}}` | live | `dc/lib/useDeploymentAuditLog.ts:105-125`; `Logs.tsx:127` |
| **Health** — function calls, failure rate, cache hit rate | HTTP GET | `/api/app_metrics/{function_call_count_top_k, failure_percentage_top_k, cache_hit_percentage_top_k}` | **poll 8 s** | `appMetrics.ts:192-228,324-366,414-441` |
| Health — concurrency | HTTP GET | `/api/app_metrics/function_concurrency` | poll 8 s | `appMetrics.ts:801-857` (`:829`); `ConcurrencyStatus.tsx:29` |
| Health — scheduler lag | HTTP GET | `/api/app_metrics/scheduled_job_lag` (1 h, 60 buckets) | **poll 60 s** | `appMetrics.ts:119-165` (`:143`) |
| Health — subscription invalidations | HTTP GET | `/api/app_metrics/subscription_invalidations_top_k?k=3` | poll 8 s | `SubscriptionInvalidations.tsx:6` |
| Health — deployment summary | WS query + npm | `lastPushEvent`, `convexCloudUrl`, `convexSiteUrl`, `getVersion`; `registry.npmjs.org/convex/latest` | live | `DeploymentSummary.tsx:51,140-165`; **cloud only** (`HealthView.tsx:60`) |
| Health — insights | Big Brain HTTP | `/api/dashboard/teams/{id}/usage/query` | poll 600 s | `cl/api/insights.ts:201-220`; **cloud only** |
| Every page — banners | WS query | `backendState:backendState` | live | `dc/layouts/DeploymentDashboardLayout.tsx:215` |
| **Schedules** — scheduled runs | WS paginated query + auto-pause | `paginatedScheduledJobs {udfPath, componentId}` | live (one-shot while paused) | `dc/features/schedules/lib/usePaginatedScheduledJobs.ts:24-45` |
| Schedules — a run's arguments | WS query | `scheduler:getArgs` | live | `ScheduledFunctionsListItem.tsx:181` |
| Schedules — cancel | HTTP POST | `/api/cancel_job`, `/api/cancel_all_jobs`, `/api/delete_scheduled_functions_table` | once | `dc/features/schedules/lib/api.tsx:21,69,97` |
| Schedules — crons | WS query | `listCronJobs`, `listCronJobRuns` (+ the module list) | live | `CronsProvider.tsx:37-44` |
| **Files** | WS paginated query + auto-pause; WS query | `fileStorageV2:fileMetadata`; `numFiles`, `getFile` | live | `usePaginatedFileMetadata.ts:38,56-60`; `FileStorageView.tsx:76-82` |
| Files — upload | WS mutation, then a raw POST | `fileStorageV2:generateUploadUrl`, then `POST <uploadUrl>` | once | `Uploader.tsx:48,72-79` |
| Files — delete | WS mutation | `fileStorageV2:deleteFiles` | once | `DeleteFileModal.tsx:14` |
| **Settings** — environment variables | WS query; HTTP POST | `listEnvironmentVariables`; `/api/update_environment_variables {changes}` | live read | `DeploymentEnvironmentVariables.tsx:34,205`; `settings/lib/api.ts:20-48` |
| Settings — pause | WS query; HTTP POST | `deploymentState`; `/api/v1/pause_deployment`, `/api/v1/unpause_deployment` | live read | `PauseDeployment.tsx:35`; `settings/lib/api.ts:74-106` |
| Settings — authentication | WS query | `listAuthProviders` | live | `AuthConfig.tsx:10` |
| Settings — components | WS query; HTTP POST | `components.list`; `/api/delete_component` | live | `settings/lib/api.ts:50-72` |
| Settings — integrations | WS query; HTTP POST | `listConfiguredSinks`; `/api/v1/{create,update,delete}_log_stream`, `rotate_webhook_secret` | live read | `IntegrationsView.tsx:29-30`; `dc/lib/integrationsApi.ts:44-125` |
| Settings — usage limits | HTTP GET / POST | `/api/v1/list_usage_limits` (revalidated after writes), `/api/v1/get_current_usage` (**poll 5 s**), `create/update/delete_usage_limit` | poll 5 s (usage) | `dc/features/settings/lib/api.ts:139-315` |
| Settings — general | — | self-hosted: the pause section only (`sh/pages/settings/index.tsx`); cloud adds the summary, deploy keys, delete | live | `cl/pages/t/[team]/[project]/[deploymentName]/settings/index.tsx:40-105` |
| **History** (audit log) | WS paginated query | `paginatedDeploymentEvents {filters}` (needs `ViewAuditLog`) | live | `dc/lib/useDeploymentAuditLog.ts:191`; `HistoryView.tsx:142` (`/api/v1/list_audit_log_events` exists, `lb/deployment_audit_log.rs:180`, but is not used) |
| **Snapshot export** | WS query; HTTP | `latestExport`; `GET /api/export/zip/{id}?adminKey=` or `POST …/token`; `POST /api/export/cancel/{id}`; import via `snapshotImport.list`, `/api/perform_import`, `/api/cancel_import` | live read | `cl/components/deploymentSettings/SnapshotExport.tsx:129`; `cl/hooks/deploymentApi.ts:29-105`; **cloud only** (the self-hosted sidebar always filters Snapshots out, `dc/layouts/SettingsSidebar.tsx:169`) |
| **Backups** | Big Brain HTTP | `/api/dashboard/deployments/{id}/list_cloud_backups` etc. | poll 5 s | `cl/api/backups.ts:25-160`; **cloud only** |

### 1.3 The log stream in detail

- **Client** (`dc/lib/useLogs.ts:204-315`): a loop that awaits `streamFunctionLogs(url, auth, cursor)`, takes
  `newCursor`, appends the entries, and repeats. The cursor starts at 0, so the first answer is whatever the
  server's ring buffer still holds. Errors back off from 500 ms, doubling, up to 16 s with jitter
  (`dc/lib/utils.ts:51-59`); after 5 failures a "disconnected" toast; a 403 stops the loop. At most
  `MAX_LOGS = 10 000` entries are kept (`:31`).
- **Server** (`lb/logs.rs:79-170`): `stream_parts(cursor)` races a 60 s sleep (`:163`); on timeout it answers
  `{entries: [], newCursor: cursor}`. Structured log lines go to `Dashboard` and `CLI` clients (`:96-115`).
  The dashboard uses `/api/app_metrics/stream_function_logs` (`lb/router.rs:508`); the CLI and MCP use
  `/api/stream_function_logs` (`:355`); `stream_udf_execution` (`:38-71`) is the legacy shape, unused by the
  dashboard.
- So **Logs is not a WebSocket subscription**: it is a long-poll, fresh within one round trip of an execution
  finishing.

### 1.4 The self-hosted dashboard and how it connects

**Credentials** (`sh/pages/_app.tsx`) can come four ways:

1. **The form** (`DeploymentCredentialsForm`), pre-filled from `NEXT_PUBLIC_DEPLOYMENT_URL` /
   `NEXT_PUBLIC_ADMIN_KEY` read on the server in `getInitialProps` (`:151-201`, `:506-510`).
2. **`GET /api/current_deployment`** on the dashboard's own origin → `{name, url, adminKey}`, only in a build
   with `NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API=true` (`:136-137`; `sh/lib/fetchCurrentDeployment.ts:18-33`).
   This is how the CLI's local dashboard signs in without a form.
3. **An iframe parent**: `{type: "dashboard-credentials-request"}` posted to `*`, any
   `{type: "dashboard-credentials", adminKey, deploymentUrl, deploymentName, visiblePages?}` accepted
   (`:573-629`); `visiblePages` trims the sidebar (`DeploymentDashboardLayout.tsx:114-147`).
4. **A legacy deployment list**: `?a=<port>&d=<name>` → `GET http://127.0.0.1:<port>` (`:448-481`).

**Check and storage**: `checkDeploymentInfo` → `GET <url>/api/check_admin_key` with `Authorization: Convex
<key>`, 3 tries 500 ms apart; a 404 means every operation (`sh/lib/checkDeploymentInfo.ts:17-58`).
On success the key, URL and name go to `sessionStorage` (`:356-364`, `:396-401`), `allowedOps` drives
`useIsOperationAllowed` (empty = all, `:437-441`), and "Log out" clears them (`:524-528`).

**What the self-hosted build strips** (`deploymentInfo`, `sh/pages/_app.tsx:206-334`):

- Stubbed: team and project (id 0), members (`[]`), entitlements (everything on, audit retention −1),
  `useCurrentDeployment` (a fake `local`/`dev` deployment), protected deployment (`false`), project admin
  (`true`), custom roles (`false`), project env vars (`[]`), deployment-event logging (no-op), every WorkOS
  operation (no-ops), `CloudImport`, `TeamMemberLink` ("An admin"), plan and usage state; analytics and the
  feedback form absent; `isSelfHosted: true`; WorkOS, S3 export and Fivetran progress off.
- Real: `useIsDeploymentPaused` (a live `deploymentState` query, `:264`).
- **Pages kept** (`sh/pages`): Health (without the summary and insights), Data, Schema, Functions, Files, Logs,
  History, Schedules (functions, crons), Settings (General = pause only, environment variables,
  authentication, components, integrations, usage limits).
- **Pages dropped**: settings/backups, settings/custom-domains (shown disabled), settings/snapshots (hidden),
  insights, the deployment summary, project settings and usage (disabled), team / billing / members, the
  command palette. A `*.convex.cloud` URL in the self-hosted dashboard links History, Backups, project
  settings and usage out to the cloud dashboard (`dc/lib/useIsCloudDeploymentInSelfHostedDashboard.ts`).

**The cloud dashboard**, for contrast, uses the WorkOS access token **as** the admin key for cloud deployments
(`Convex <accessToken>`) and asks Big Brain for a local deployment's key
(`cl/providers/DeploymentInfoProvider.tsx:205-260`; `cl/lib/deploymentAuth.ts:4-23`).

### 1.5 Packaging: docker, `dashboard.zip`, the CLI

- **Docker** (`self-hosted/docker/docker-compose.yml:54-66`): a `dashboard` service, its own image
  `ghcr.io/get-convex/convex-dashboard:latest` (Next.js, `next start -p 6791`), port `${DASHBOARD_PORT:-6791}`,
  `NEXT_PUBLIC_DEPLOYMENT_URL` defaulting to `http://127.0.0.1:${PORT:-3210}`, `depends_on` the backend being
  healthy (`curl -f /version`). **No admin key is passed**: the user pastes the one
  `generate_admin_key.sh` printed. The browser talks to the backend directly (another origin); the backend's
  CORS layer mirrors the origin.
- **`dashboard.zip`**: the static export (`build:export`, with `NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API=true`),
  attached to every GitHub release.
- **The local dashboard** (`npm-packages/convex/src/cli/lib/localDeployment/dashboard.ts:26-97`, started from
  `cli/lib/dev.ts:111`), **for anonymous local deployments only**: `ensureDashboardDownloaded(version)` fetches
  `dashboard.zip` from the release (`download.ts:327-355`), a Node server on the first free port from 6790
  (saved per deployment) serves the static files and `GET /api/current_deployment` → `{name, url, adminKey}`
  (`:66-77`).
- **`npx convex dashboard`** (`cli/dashboard.ts`): self-hosted → "`npx convex dashboard` is not supported for
  self-hosted deployments" (`:32-36`); anonymous → `http://127.0.0.1:<saved port>/`, after checking that its
  `/api/current_deployment` names this deployment (`:41-84`); otherwise `https://dashboard.convex.dev/d/<name>`.
- **Links in CLI output** (`cli/lib/dashboard.ts`): `deploymentDashboardUrl` (`/t/<team>/<project>/<name>`,
  in `announceDeploymentTarget.ts:199-212`) and `deploymentDashboardUrlPage` (`/d/<name><page>`, in export,
  import, insights, indexes, components, deploy). All point at `dashboard.convex.dev`; a FIXME (`:40-41`) says
  they are wrong for local and self-hosted deployments — a self-hosted export prints a cloud link.

## 2. What an app can observe

Nothing: apps never see the dashboard. What the **operator** observes, and bunvex keeps:

- the screens show the deployment's real data, and the parts that are live in Convex are live (§1.2);
- what is polled is about as fresh (Health 8 s, scheduler lag 60 s, usage 5 s, shapes 60 s), and Logs arrive
  within a round trip of an execution;
- what a credential may do follows `check_admin_key`'s `allowedOps`;
- edits made from the dashboard appear in History (`add_documents`, `update_documents`, `delete_documents`,
  `create_table`, `clear_tables`, …), with Convex's audit documents;
- `docker compose up` brings up a dashboard next to the backend; `bunvex dev` on a local deployment serves one,
  and `bunvex dashboard` opens it; a release carries `dashboard.zip`.

## 3. How bunvex does it

### 3.1 What exists (the server side)

The server already has most of what Convex's dashboard calls over HTTP, and about half its system functions.

**System functions** (`packages/server/src/system-functions.ts`; dispatched in `functions.ts:1273`,
`:1898-1945`, admin only over the WebSocket, `/api/query` and `/api/function`; `componentId` accepted and
ignored). *have* = defined under Convex's name, with the shape its parity row records; *partial* = the data is
there under another name or route; *missing* = not defined.

| `_system/frontend/…` (used by Convex's self-hosted dashboard) | bunvex | where / note |
|---|---|---|
| `getTableMapping` | have (PR 2) | `data-system-functions.ts` |
| `paginatedTableDocuments` | have (PR 2) | `data-system-functions.ts` |
| `listById`, `getById` (cloud palette) | have (PR 2) | `data-system-functions.ts` |
| `tableSize`, `tableSize:sizeOfAllTables` | have | `:445`, `:450` |
| `indexes` | have (PR 2) | `data-system-functions.ts`; `/api/get_indexes` too |
| `getSchemas`, `:schemaValidationProgress` | have | `:136`, `:428` (+ `stagedSchemaValidationProgress` `:437`) |
| `addDocument`, `patchDocumentsFields`, `replaceDocument`, `deleteDocuments`, `clearTablePage`, `createTable` | have (PR 3) | `data-system-mutations.ts`, with their audit events |
| `modules:listForAllComponents`, `modules:argsValidator` | have (PR 4) | `frontend-system-functions.ts` (`modules:list` too) |
| `components:list` | have (PR 4) | `frontend-system-functions.ts`; the root alone (DV-55) |
| `getVersion` | have (PR 4) | `frontend-system-functions.ts` |
| `convexCloudUrl`, `convexSiteUrl` | have (PR 4) as `cloudUrl`, `siteUrl` — **rule 5** (Q3, DV-474) | `frontend-system-functions.ts` |
| `backendState:backendState`, `deploymentState:deploymentState` | have | `:152`, `:158` |
| `deploymentEvents:lastPushEvent`, `paginatedDeploymentEvents`, `listDeploymentEventsFromTime` | have | `:394`, `:336`, `:380` |
| `paginatedScheduledJobs`, `scheduler:getArgs` | have | `:311`, `:330` |
| `listCronJobs`, `listCronJobRuns` | have | `:458`, `:536` |
| `fileStorageV2:{numFiles, fileMetadata, getFile, deleteFile, deleteFiles, generateUploadUrl}` | have | `:482–:559`; each write audited |
| `listEnvironmentVariables` | have (PR 4) | `frontend-system-functions.ts` |
| `listAuthProviders` | have | `:130` |
| `listConfiguredSinks` | have | `:115` |
| `latestExport`, `snapshotImport:list` (cloud only) | have (PR 4) | `frontend-system-functions.ts` |

**HTTP routes** (`packages/server/src/server.ts`; admin gate `:1588-1617`):

| route | bunvex |
|---|---|
| `GET /api/check_admin_key` | have (`:1193`) |
| `GET /api/shapes2` | have (`:1335`) |
| `POST /api/delete_tables`, `/api/delete_scheduled_functions_table` | have (`:1401`, `:1392`) |
| `POST /api/delete_component` | n/a until components (DV-55) |
| `POST /api/cancel_job`, `/api/cancel_all_jobs` | have (`:1372`, `:1376`) |
| `POST /api/(v1/)update_environment_variables` | have (`:1215`) |
| `POST /api/run_test_function` | have (`:1424`, STUDY-119) |
| `GET /api/app_metrics/stream_function_logs`, `/api/stream_function_logs` | have (`STREAM_ROUTE` `:411`, `:1331`); AD-27 `links` for a `dashboard-*` client |
| `GET /api/app_metrics/*` (all ten) | have (`app-metrics-routes.ts:33`) |
| `POST /api/v1/pause_deployment`, `/unpause_deployment` | have (`:549`, `:1170`) |
| `/api/v1/*usage_limit*`, `/api/v1/get_current_usage` | have (`usage-limits.ts:241`) |
| `/api/v1/*_log_stream*` | have (STUDY-59) |
| `/api/export/*`, `/api/perform_import`, `/api/cancel_import` | have (`:1908-1950`, `:2024-2065`) |
| `GET /instance_name`, `/version` | have (`health.ts:63-72`) |
| CORS on `/api/*` (origin mirrored, credentials, preflight) | have (`cors.ts`, wired at `:1789`) |
| WebSocket `Authenticate {tokenType: "Admin"}` | have (`sync.ts:1257-1269`) |
| `GET /api/current_deployment` | missing (it belongs to the local dashboard's server, not the backend) |

Auth on bunvex is `Authorization: Bunvex <key>` (DV-97; `Convex <key>` is a 400 `InvalidAdminKey`,
`server.ts:701-731`), `?adminKey=`, or the key in `run_test_function`'s body. The client header is
`Bunvex-Client: <client>-<semver>` (`client-version.ts:4,15`).

### 3.2 What does not exist (the dashboard side)

- `packages/dashboard` reads everything through `DashboardDataSource` (`data-source.ts:432-526` plus the
  `data-source-*.ts` feature interfaces); the screens get it from `<Dashboard dataSource>`
  (`dashboard.tsx:17,55,66`) and `useDataSource` (`context.tsx:5,13`). Its `watch*` methods are callback
  subscriptions (`(…, onX, onError) => Unsubscribe`, never synchronous); `watchTable` is a signal that makes
  the screen refetch its TanStack Query keys (`database/live.ts:9-18`; STUDY-12 D3, decided).
- `apps/dashboard/src/main.tsx:25-47,96` builds a `MockDataSource` and injects it; sign-in uses
  `mockVerifier()` (`login/credentials.ts:82-94`). `SERVER_OPS` already maps the server's operation names
  (`:43-63`). (As of the study; PR 6 replaced both, §5 "PR 6, as built".)
- `check-deps` allows `dashboard → ui` and `apps/dashboard → dashboard, ui` only (`scripts/check-deps.ts:62-66`).
- There is no `@bunvex/client/react`: `@bunvex/client` exports `"."` only; React is `@bunvex/react`
  (`BunvexReactClient`, `packages/react/src/client.ts:125`, `setAdminAuth(token)` `:184`, without
  impersonation). `BaseBunvexClient` (`packages/client/src/base-client.ts:100`) has `setAdminAuth(value,
  impersonating?)` `:347`, `subscribe` `:356`, `mutationInternal` `:445`, `actionInternal` `:505` — exactly what
  Convex's runner uses on its side.
- No `dashboard` service in `docker/docker-compose.yml`, no `dashboard.zip`, `bunvex dev` serves no dashboard,
  `bunvex dashboard` warns on a local deployment and refuses on a self-hosted one (STUDY-146).

### 3.3 The design

**A new package, `@bunvex/dashboard-source`** (`packages/dashboard-source`), exporting
`createServerDataSource({ url, adminKey, fetch? }): DashboardDataSource & Disposable` and
`createAdminKeyVerifier()`.

- Depends on `@bunvex/client` (browser-safe) and on `@bunvex/dashboard` for the contract's types only. The
  dashboard package keeps depending on `ui` alone (UI-01 §6), so the same screens still serve a future cloud
  host with another source. This replaces UI-01 §5.7's proposed `@bunvex/dashboard/http` over
  `@bunvex/protocol`: the admin API turned out to be Convex's system functions over the sync protocol, so the
  client, not raw protocol messages, is the right dependency. A UI-01 amendment and a `check-deps` rule
  (`dashboard-source → client, dashboard`; `apps/dashboard → dashboard-source`) come with PR 1.
- **Not React.** The contract is callback-based (D3), so the source holds one `BaseBunvexClient` with
  `setAdminAuth(adminKey)` and turns each `watch*` into a `subscribe` of the matching system query, calling
  back on every new result. `@bunvex/react` is not needed; the screens keep TanStack Query over the contract.
  The runner gets a second client (as Convex's `functionRunner/lib/client.ts`) for `watchFunction` with
  impersonation (`setAdminAuth(key, identity)`).
- **The mapping**, Convex's mechanism per method (§1.2), so freshness matches:

| contract | over |
|---|---|
| `listTables`, `getSchema` | `getTableMapping` + `tableSize` + `indexes` + `getSchemas` (WS query, one-shot) |
| `listDocuments`, `getDocument`, `tableOfId` | `paginatedTableDocuments` (bunvex's `FilterExpression` translated to Convex's `filters`), `listById`, `getTableMapping` |
| `watchTable` | a subscription to the loaded pages' `paginatedTableDocuments` and to `tableSize`; a change fires the signal (live, as Convex; D3's refetch stays inside the dashboard) |
| writes | `addDocument`, `patchDocumentsFields`, `replaceDocument`, `deleteDocuments`, `clearTablePage` (looped), `createTable` (WS mutations; audited server-side); `/api/delete_tables` |
| `inferDocumentType` | `/api/shapes2`, refreshed every 60 s while shown |
| `listFunctions` | `modules:listForAllComponents` + `modules:argsValidator` (subscribed) |
| `runFunction`, `watchFunction` | `mutationInternal` / `actionInternal` / `subscribe` on the runner client |
| custom query (new optional `runTestQuery(source, args)`) | `POST /api/run_test_function` (the key in the body, `format: "encoded_json"`, DV-307); the browser compiles TypeScript as Convex's does |
| `listLogs`, `watchLogs` | one long-poll loop on `/api/app_metrics/stream_function_logs` from cursor 0, Convex's back-off; `listLogs` returns what the ring holds, older pages `isDone` |
| metrics (Health, a function's and a table's statistics) | `/api/app_metrics/*`; the screen polls 8 s (top-k, concurrency, invalidations), 60 s (scheduler lag), once per window (a function's charts), as Convex |
| new optional `functionConcurrency`, `subscriptionInvalidations` | `/api/app_metrics/function_concurrency`, `…/subscription_invalidations_top_k` (platform:342) |
| schedules | `paginatedScheduledJobs` (subscribed, auto-paused past 100 updates / 10 s as Convex), `scheduler:getArgs`, `listCronJobs`, `listCronJobRuns`; `/api/cancel_job`, `/api/cancel_all_jobs` |
| files | `fileStorageV2:*` (subscribed, auto-pause); upload = `generateUploadUrl` then POST |
| environment variables | `listEnvironmentVariables` (subscribed); `/api/update_environment_variables` |
| deployment state, pause | `deploymentState`, `backendState` (subscribed); `/api/v1/(un)pause_deployment` |
| audit log | `paginatedDeploymentEvents` (subscribed) |
| auth providers, sinks | `listAuthProviders`, `listConfiguredSinks` |
| snapshots (bunvex's Settings addition) | `_system/cli/exports:getLatest` / `queryImport:list`, `/api/export/*`, `/api/import` |
| `getDeployment` | `getVersion`, the URL queries (Q3), `/instance_name` |
| `getStats` / `watchStats`, topology, subscriptions, system tables | `/stats`, `/api/debug/*`, `_system/debug/*` (bunvex additions, already server-side) |
| auth admin, clients, workflows, analytics, flags | not offered (`typeof` hides them) until their server sides exist |

- Requests send `Authorization: Bunvex <key>` and `Bunvex-Client: dashboard-<version>` (which also turns on
  the AD-27 log links).
- Errors map to the contract's codes: 401/403 → `unauthorized`, 404 → `not_found`, 400 → `invalid_request`,
  network / 5xx / socket loss → `unavailable`. A connection watcher feeds the dashboard's disconnect state.

**Swapping out the mock** (`apps/dashboard/src/main.tsx`): sign-in calls the real verifier (`GET
<url>/api/check_admin_key` with `Bunvex <key>`, Convex's 3 tries and 404 rule), then
`createServerDataSource({url, adminKey})` replaces `mockSource(session)`. "Use the demo data" (LG1, `?demo=1`)
keeps the mock, so the e2e tests and design work are unchanged. The credentials also come from
`/api/current_deployment` when the build is the local one (`VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1`, as
Convex's `NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API`), and from the allow-listed parent (DV-319).

**The server functions to add** (each under Convex's path and shape, checked against Convex's local backend
with an oracle as STUDY-34 did for the system identity): `getTableMapping`, `paginatedTableDocuments`,
`listById`, `getById`, `indexes`, the six data mutations (with the `add_documents`, `update_documents`,
`delete_documents`, `create_table` and `clear_tables` audit events), `modules:listForAllComponents`,
`modules:argsValidator`, `components:list` (the root only), `getVersion`, `cloudUrl` and `siteUrl` (DV-474),
`listEnvironmentVariables`, `latestExport`, `snapshotImport:list`, and `/api/get_indexes` for the CLI's sake.

**Packaging** (closing DV-189, DV-194, DV-202, DV-217):

- `apps/dashboard` builds a static bundle (Vite already does). A tiny Bun server, `bunvex dashboard serve`
  (internal), serves it and, for a local deployment, `GET /api/current_deployment` (only for a `Host` of `127.0.0.1` or
  `localhost`, DV-476).
- **Docker**: a `dashboard` service on `${DASHBOARD_PORT:-6791}` with `BUNVEX_DEPLOYMENT_URL` defaulting to
  `http://127.0.0.1:${PORT:-3210}`, after the backend is healthy, no admin key passed — as Convex's, from its
  **own image** (`ghcr.io/bunvex/bunvex-dashboard`; Q1 option B, DV-475).
- **`dashboard.zip`** in every release (`scripts/build-binary.ts`), from the same build with the
  current-deployment flag.
- **`bunvex dev`** on a local deployment downloads (or finds in the cache) the release's `dashboard.zip` and
  serves it on the first free port from 6790, saved per deployment; **`bunvex dashboard`** opens it after
  checking `/api/current_deployment`, as Convex's. A self-hosted deployment keeps Convex's "not supported"
  (Q5, decided).
- **CLI links**: export and import link to the local dashboard when `dev` serves one, otherwise print none
  (DV-477, replacing DV-217).

**Security**: Convex's model (the key typed in, kept in memory only, DV-210; sent over the WebSocket and in
`Authorization`; CORS as Convex's), plus the local server's `Host` check (DV-476).

## 4. Divergences

Decided by the owner on 2026-10-12 (§6), recorded in [divergences.md](../parity/divergences.md).

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-474 (Q3) | `_system/frontend/convexCloudUrl` and `convexSiteUrl` exist under bunvex names (`cloudUrl`, `siteUrl`) | rule 5 has no exceptions, wire names included (DV-307/308/312) | owner, 2026-10-12: rename |
| DV-475 (Q1) | the `dashboard` service's own image (6791; locally 6790, as Convex) holds a static Vite build served by Bun, not a Next.js server; topology and image split match Convex | bunvex's dashboard is a static app (STUDY-12 D1) | owner, 2026-10-12: B, its own image |
| DV-476 (Q4) | the local dashboard's `/api/current_deployment` answers only a `Host` of `127.0.0.1` / `localhost:<port>` | it hands out the admin key; Convex's Node server answers any `Host` (DNS rebinding) | owner, 2026-10-12: add the check |
| DV-477 (Q5) | export / import print a link to the dashboard bunvex is serving locally, or none on self-hosted; never a cloud link | Convex prints `dashboard.convex.dev` even when that is wrong (its FIXME); bunvex has no cloud and rule 5 forbids the link | owner, 2026-10-12: as proposed; replaces DV-217 |
| DV-488 (PR 7 follow-up) | with embedding parents allowed (DV-319), the image's server sends `frame-ancestors 'self' <parents>` and Convex's CORP / COEP, no `X-Frame-Options`; Convex's embedding build sends no frame policy at all | an admin key is handed to the frame: only the parents the operator listed may frame it | owner, 2026-10-14: match Convex, with the allow-list in `frame-ancestors` |

Already decided and kept: D1 (bunvex's own screens), D3 (`watchTable` as a signal; now fed by a real
subscription), DV-97 (`Bunvex` scheme), DV-210 (the key never stored), DV-307 (`encoded_json`), DV-319
(embedding allow-list).

## 4b. Additions (beyond Convex)

| # | Addition | Why | Decision |
|---|---|---|---|
| AD-32 (Q1 option C) | the backend can also serve the dashboard itself, same-origin, at `/dashboard` (opt-in) | one container, one port, no CORS | **not taken** (owner, 2026-10-12: Q1 option B); not recorded in additions.md |

## 5. Tests

- **Contract suite against a live server**: `describeDataSourceContract` (`@bunvex/dashboard/contract`), today
  run on the mock, runs on `createServerDataSource` over an in-process bunvex server (pagination and cursors,
  every filter operator, watchers, writes on a scratch table, errors).
- **System functions against Convex**: each new `_system/frontend` function and its audit event checked against
  Convex's local backend binary with the same inputs (the oracle STUDY-34 and STUDY-48 used), shapes compared
  field by field.
- **Freshness**: a write shows up in a `watchTable`, `watchScheduledFunctions` and `watchFiles` callback without
  a refetch timer; a log line reaches `watchLogs` within one long-poll; a 403 stops the loop; back-off doubles.
- **Sign-in**: the real verifier against `check_admin_key` (good key, read-only key, wrong key, 404).
- **e2e** (`apps/dashboard/e2e`): the existing scenarios once on the mock and once against `bunvex dev`'s local
  dashboard, with axe.
- **Packaging**: `docker/smoke.sh` brings up the `dashboard` service and fetches `/`; `smoke-binary.sh` checks
  `dashboard.zip`; a CLI test for `bunvex dashboard` on a local deployment and `/api/current_deployment`'s Host
  check.
- **Sabotage** per PR (a watcher that never fires, a cursor not passed through, a wrong auth scheme, a missing
  audit event, a Host check removed), each watched to fail.

### PR plan (ordered)

| # | PR | Size |
|---|---|---|
| 1 | `@bunvex/dashboard-source` skeleton: the client wiring, auth, errors, the connection watcher, the real `check_admin_key` verifier, the contract suite on a live server for what exists today (deployment state, schemas, sizes, logs long-poll, metrics); UI-01 amendment and the `check-deps` rule | M (~800 lines) |
| 2 | Server: data reads — `getTableMapping`, `paginatedTableDocuments` (Convex's filter shape), `listById`, `getById`, `indexes`, `/api/get_indexes`; the source's `listTables`, `listDocuments`, `watchTable` | L (~1 200) |
| 3 | Server: data writes — the six mutations with their audit events (closes platform:62 and :252); the source's writes | M–L (~900) |
| 4 | Server: `modules:listForAllComponents`, `modules:argsValidator`, `components:list`, `getVersion`, `cloudUrl` and `siteUrl` (DV-474), `listEnvironmentVariables`, `latestExport`, `snapshotImport:list`; the source's Functions, runner (second client, impersonation), custom query (`runTestQuery` + the runner's editor), env vars, settings | L (~1 100) |
| 5 | The source for schedules, files (auto-pause), history, Health's concurrency and invalidations (new optional contract methods, platform:342) | M (~600) |
| 6 | `apps/dashboard` on the real source by default, the mock behind "Use the demo data"; e2e against a live deployment | S–M (~400) |
| 7 | Packaging: `bunvex dashboard serve`; a **second docker image** (`docker/dashboard.Dockerfile`, published beside the backend's) and the `dashboard` service on 6791 in docker-compose; `dashboard.zip` in releases; the local dashboard in `bunvex dev` (6790, with the `Host` check); `bunvex dashboard` for local; closes DV-189, DV-194, DV-202 | M–L (~900) |
| 8 | CLI links (DV-477, closes DV-217) and the docs (self-hosting guide, parity rows) | S (~200) |

PRs 2–5 can run in parallel once PR 1 is in; 6 needs 2–4; 7 needs 6.

### PR 1, as built

`packages/dashboard-source` (UI-01 §34):

- `admin-http.ts`: the admin routes with `Bunvex <key>` and `Bunvex-Client: dashboard-0.0.0` (the private
  package's version), and the error codes of §3.3.
- `credentials.ts`: `createAdminKeyVerifier`, as `checkDeploymentInfo.ts:17-58` — `Content-Type`,
  `Authorization` and the client header on a GET; a 2xx gives `allowedOps ?? []` and `isReadOnly ?? false` (not
  JSON: everything allowed); a 404 allows everything; anything else, a network error included, sleeps 500 ms
  and tries again, 3 tries in all (so a refused key answers after about 1.5 s, as Convex's). `SERVER_OPS` and
  `capabilitiesOf` moved here from `apps/dashboard`, which re-exports them.
- `sync.ts`: one `BaseBunvexClient` with `setAdminAuth` before any subscription; per-query callbacks shared by
  token, one-shot reads, `mutationInternal` / `actionInternal`; a failure saying "permission" is
  `unauthorized`. The connection watcher is Convex's rule (`deploymentContext.tsx`
  `handleConnectionStateChange`): unknown without a fresh previous observation, disconnected at two in a row.
- `logs.ts`: the long poll of §1.3 and Convex's `processLogs` (each line, then an outcome line carrying the
  execution; quoted string messages unquoted as `messagesToString`; an HTTP action fails by its status).
  `listLogs` pages what the loop holds; since the server holds an empty log's first request up to 60 s, an
  answer within 1 s is the history (listed, not delivered to `watchLogs`), and the log reads as empty until
  one arrives.
- `metrics.ts`: `functionRate` (`udf_rate` is per second, so it is multiplied by the bucket's width, as
  Convex's charts do with their `timeMultiplier`), `cacheHitPercentage`, `latencyPercentiles` (seconds → ms,
  the order asked), `topFunctions` (display paths), `scheduledJobLag`; a window with no bucket is refused
  before it is sent (the server's answer would be a 500).
- `server-source.ts`: `getDeployment` (`/instance_name`, `/version`, the persistence label from `/stats`),
  `getCapabilities` (`check_admin_key`), `getStats` / `watchStats` (`/stats`, which now also reports
  `subscriptions`, the field UI-01 §5.2 maps), `getSchema` (`getSchemas` and its validation progress over the
  socket), `getDeploymentState` (`deploymentState`), pause and resume (the routes; resume skips a running
  deployment, since the contract's resume is idempotent and Convex's route refuses it). `listTables`,
  `listDocuments`, `getDocument`, `watchTable` and `listFunctions` answer `unavailable`.

Two items of the PR plan moved: the table sizes are a field of `listTables`, and a table's rates need the
table mapping to answer `not_found` for an unknown table (the server answers zeros), so both come with PR 2.
The contract's metrics part picks its functions with `listFunctions`, so it runs from PR 4; until then the
metrics are checked by tests of their own against the live server.

**Tests.** `packages/dashboard-source/test` (no server): the verifier's request, tries, delay and 404 rule;
the error codes; the log mapping, the loop's cursor, back-off, reporting, 403 stop (a 401 backs off, as
Convex's) and history rule; the
metric units; the watcher's rule; the schema mapping. `packages/sync-e2e/dashboard/server-source.test.ts`: a
server in the process with a schema and functions pushed over deploy2, then `describeDataSourceContract` with
`only: ["deployment", "logs", "state"]` (pause toggled), and the verifier (full, read-only and wrong keys, a
404 server), the deployment's fields, the counters with a live subscription, `watchStats`' interval, the
schema, the logs' history and live tail, the metrics, and the methods not built yet.

**Sabotage** (each restored after; every one turned a test red):

| Sabotage | Failing tests |
|---|---|
| `Bearer` instead of `Bunvex` in `Authorization` | 18 (unit and live) |
| the verifier tries 2 times | 4 |
| the 404 rule removed | 2 |
| no delay between tries | 1 |
| the log loop does not pass `newCursor` on | 2 |
| the history delivered to `watchLogs` | 2 |
| a 403 does not stop the loop | 1 |
| a 401 (a refused key) stops it too | 1 |
| failures reported at the first one | 1 |
| `watchStats`' unsubscribe does nothing | 1 |
| `udf_rate` left per second | 2 |
| latencies left in seconds | 2 |
| quoted messages kept quoted | 5 |
| `v.any()` shown as a document type | 1 |
| the contract's `only` ignored | 17 |
| `/stats` without `subscriptions` | 1 |

**Measurements.** No hot path changes (the server only adds a counter read per `/stats` call). The app's
entry chunk grows by 521 bytes (the verifier's module, re-exported through `apps/dashboard`); the source itself
is not in the app's bundle until PR 6.

**PR 2 starts from** `server-source.ts`'s `listTables`, `listDocuments`, `getDocument` and `watchTable` stubs,
the `"tables"` and `"documents"` areas of the live suite, `AdminSync.watch` / `query` for the new system
functions (`getTableMapping`, `paginatedTableDocuments`, …), and `Metrics` for `tableRate`.

### PR 2, as built

The Data screen's reads. In the citations, `fe/` is `npm-packages/system-udfs/convex/_system/frontend/` and
`sst` is `npm-packages/system-udfs/convex/_system/secretSystemTables.ts`.

**Server** (`packages/server/src/data-system-functions.ts`, spread into `SYSTEM_QUERIES` by one line; admin only,
ViewData, `componentId` accepted and ignored as the other system functions do, DV-55). Each was compared with
Convex's local backend binary for the same documents (Tests, below).

- `getTableMapping` (`fe/getTableMapping.ts:9-24`; the op is `crates/isolate/src/ops/database.rs:8-11`, which
  takes the table mapping dependency, `crates/database/src/transaction.rs:260-263`): every active table's number
  and name, keeping the user tables and `_scheduled_jobs` and `_file_storage`, the first 1 000 by number. It reads
  `_tables`, so a subscription to it gets a table a push or a write creates.
- `paginatedTableDocuments` (`fe/paginatedTableDocuments.ts:40-209`, `fe/lib/filters.ts`): `filters` is base64
  (standard or URL-safe, padded or not, as js-base64's `decode`) of Convex's `FilterExpression`. As Convex's:
  - the expression's shape is checked (`FilterExpressionSchema`, `filters.ts:131-174`), then each clause's value
    (`findErrorsInFilters`, `:258-276`); a value that is not a JSON value answers the page `[{filter: i, error:
    "Invalid value: …."}]`, `isDone`, cursor `""`;
  - an index filter is checked against the **active schema's** indexes plus `by_creation_time` and `by_id`
    (`getAvailableIndexes`, `:577-594`; a staged index is not there), with Convex's messages and `filter: -1`
    (`validateIndexFilter`, `:397-451`; `validateSearchIndexFilter`, `:462-518`); a search index runs as
    `withSearchIndex` with its filter fields;
  - one `_id eq` clause and no index filter is a `db.get` (`paginatedTableDocuments.ts:153-185`);
  - the field clauses are one `filter` (`applyBuiltinFilters`, `:218-270`), the type clauses are applied to the
    page read (`applyTypeFilters`, `filters.ts:226-247`), so a page can hold fewer than `numItems`;
  - Convex's quirks are kept: `anyOf` / `noneOf` compare their elements as sent, not decoded, so an encoded int64
    or bytes in the list fails with Convex's "Field name $integer starts with a '$', which is reserved."
    (`:238-256`); `anyOf` of nothing filters nothing; a type clause reads a top-level field only
    (`doc[filter.field]`, `filters.ts:236`); an unset field is below every value, so `lt` / `lte` match it;
  - the undefined placeholder is `__BUNVEX_PLACEHOLDER_undefined_…` (`fe/lib/values.ts:3-4` renamed, rule 5:
    **DV-478**).
- `indexes` (`fe/indexes.ts:7-190`): the table's `_tables` row (active, root namespace), its `_index` rows but
  `by_id` and `by_creation_time`, each `{name, staged, fields, backfill: {state[, stats]}}` with the stored
  fields (`_creationTime` last), a search index's `{searchField, filterFields}`, a vector index's
  `{vectorField, filterFields, dimensions}`, and a running backfill's `_index_backfills` counts. bunvex stores
  Convex's `_index` rows (STUDY-134), so the reading is Convex's.
- `listById` and `getById` (`fe/listById.ts:6-47`, `fe/getById.ts:5-17`): as `queryGeneric`'s masks (`sst:70-91`,
  `:179-205`), a system table is reached only through its public virtual table (`_file_storage` → `_storage`,
  `_scheduled_jobs` → `_scheduled_functions`), any other id or table is `null`; `getById("nope")` is `null`.
- `GET /api/get_indexes?component_id=` (`crates/local_backend/src/dashboard.rs:216-233`, the response
  `schema.rs:82-185`, `IndexModel::get_application_indexes`, `crates/database/src/bootstrap_model/index.rs:994-1024`):
  every declared index of the user tables, `{table, name, fields, backfill: {state: "in_progress" | "done"},
  staged}`, sorted by table and name; ViewData; documented in the dashboard OpenAPI document, so DV-381 now
  leaves out two routes (`deployment_info`, `delete_component`).

**Source** (`packages/dashboard-source/src/tables.ts`, wired in `server-source.ts`):

- The table mapping stays **subscribed** for the source's life (Convex's sidebar keeps `getTableMapping`
  subscribed, `dc/lib/useTableMetadata.tsx:26-40`); the table list is its names without `_` (`lib/utils.ts:28`),
  sorted. An unknown table is `not_found` for `listDocuments`, `getDocument`, `watchTable`, `inferDocumentType`
  and `tableRate` (the server answers an empty page and zeros for any name).
- `listTables`: per table `indexes` and `tableSize`, and `getSchemas` for `declared`. The declared indexes are
  listed by name, with their declared fields (the stored `_creationTime` dropped, as the schema's own); a backfill
  is `backfilling` with its counts, `backfilled` is not yet queryable; search, vector and staged indexes are not
  listed (`IndexInfo` has no place for them; Convex's index list shows them — a gap for the contract).
- `listDocuments`: the contract's expression is checked with the dashboard's own `validateFilter` (exported as
  `@bunvex/dashboard/filters`), then translated: the enabled index equalities and the range as one
  `indexRange` clause; the type `int64` is Convex's `bigint`; the clauses otherwise pass as they are, as the
  contract's rules are now Convex's (below, DV-479). A refused clause is named by the contract clause it came from
  (`filter: -1` is the index). A cursor the server refuses, or a malformed expression, is `invalid_request`.
  Documents come with int64 and bytes in their JSON encodings (`toJsonValue`, so `@bunvex/dashboard-source` may
  now import `@bunvex/values`, as Convex's dashboard imports `convex/values`; `check-deps` and UI-01 §34.3).
- `getDocument`: `listById` with the table; `tableOfId`: the id's table number in the mapping
  (`getReferencedTableName`, `dc/lib/utils.ts:61-81`), user tables only (a system table's id is not a page of
  the Database screen).
- `inferDocumentType`: the table's `/api/shapes2` shape as a document type, as Convex's `displaySchemaFromShape`
  (`dc/lib/format.ts:56-150`): system fields dropped at the root, `Never` an empty table (null) or, nested,
  `v.any()`. One answer serves every call for 2 s (SWR's default deduping, the hook `dc/lib/deploymentApi.ts:48-77`),
  and the dashboard's query asks again every 60 s while shown (`refetchInterval`, Convex's `refreshInterval:
  60000`, `:61`; `packages/dashboard/src/data/queries.ts`).
- `watchTable` (STUDY-12 D3, now over real subscriptions): while a table is watched, its `tableSize` and every
  page the source served for it stay subscribed — Convex's grid keeps its loaded pages subscribed
  (`useQueryFilteredTable.ts:36-55`) and the size (`DataContent.tsx:96`). A new result of any of them is one
  change, coalesced per transition, with the size as `count`. A first page starts a generation; pages of the two
  latest generations of the latest filter are kept (at most 200), so the pages a refetch asks again keep their
  subscription; the documents read by id (the open one) are kept too (the newest 50). A write to a document no
  page or panel holds is not reported, as on Convex.
- `tableRate`: `/api/app_metrics/table_rate?name=&metric=&window=`, per second like `udf_rate`, so multiplied by
  the bucket's width (Convex's `timeMultiplier`, `dc/features/data/components/TableMetrics.tsx:21-44`).

**Tests.**

- **Oracle** (`packages/differential/test/dashboard-data.test.ts`): Convex's pinned local backend and bunvex's,
  the same documents (mixed types, a missing field, int64, bytes, a nested object), every call compared (ids by
  first appearance, `_creationTime` by rank, cursors opaque; lists in id order sorted, as ids are random):
  `getTableMapping`, `tableSize`, `indexes` (six argument shapes), `get_indexes` (and without a key), 37 field
  filters, 19 index filters (search-index misuse, every refusal), refused values, the shape's refusals (both
  fail), the cursors (next page, another query's, not a cursor, `numItems: 0`), `listById` (system and unknown
  tables) and `getById`. Three differences of every function, not of these, are rewritten in the test and left
  to a follow-up (below).
- **Server** (`packages/server/test/data-system-functions.test.ts`): the mapping's two system tables; staged,
  search and vector indexes' shapes; the search-index path (filter fields, disabled ones, field filters after,
  each refusal); the placeholder (Convex's is an ordinary string here); base64 forms.
- **Source** (`packages/dashboard-source/test/tables.test.ts`): the translation, the index listing, the shapes.
- **Live** (`packages/sync-e2e/dashboard/server-source.test.ts`): the contract suite's `tables` and `documents`
  areas now run (with deployment, logs and state; the suite's field filters now include `lt` / `lte` / `gte` on a
  field some documents lack, an empty `anyOf` and a type clause on a dotted name); plus the table list's sizes,
  indexes and `declared`; int64 and bytes; the type filter; an unset field and `lt`; `anyOf` of nothing; a type
  clause on a dotted name; a refused value's clause; `watchTable`
  (an unloaded document's write not reported, a loaded one's and the open document's reported, an insert's
  count, nothing after the stop, its subscriptions ended); `tableRate`; `inferDocumentType` and its 2 s sharing;
  `tableOfId`; the table list live across a push that adds a table.

**Sabotage** (each restored after, `git diff` clean; every one turned a test red):

| Sabotage | Failing test |
|---|---|
| `getTableMapping` drops `_scheduled_jobs` and `_file_storage` | oracle; server |
| `indexes` lists `by_id` and `by_creation_time` | oracle |
| `get_indexes` says `ready` for `done` | oracle |
| `anyOf` decodes its elements | oracle |
| type clauses follow dotted paths | oracle |
| no `_id` shortcut | oracle |
| `getById` without the public-system mask | oracle |
| the placeholder not read as `undefined` | oracle |
| the source reads the mapping once (not live) | live (a push's new table) |
| `int64` not mapped to `bigint` | unit; live |
| a refused clause named by its server position | live |
| (after DV-479) the contract's `lt` excludes an unset field | dashboard unit; live contract |
| (after DV-479) the contract's empty `anyOf` matches nothing | dashboard unit; live contract |
| (after DV-479) the contract's type clause follows dots | dashboard unit; live contract |
| (after DV-479) the source adds an "is set" clause after `lt` | live; live contract |
| (after DV-479) the source answers an empty page for an empty `anyOf` | live; live contract |
| `watchTable` does not subscribe the loaded pages | live |
| a size change not reported | live |
| `watchTable`'s stop leaves the size subscribed | live (subscriptions count) |
| `watchTable` on an unknown table not refused | contract |
| a cursor error left `unavailable` | contract |
| shapes fetched on every call | live |
| the document type keeps `_id` / `_creationTime` | unit; contract; live |
| declared indexes keep `_creationTime` | unit; live |
| `tableRate` answers zeros for an unknown table | live |
| `table_rate` left per second | live |

**Measurements.** No hot path changes: the server adds system functions and one route comparison in the admin
routes' chain. A watched table costs one subscription for its size plus one per loaded page; a write to it
re-runs those (the size from the table summaries). The app's bundle grows by 26 bytes (the inferred type's
refetch interval); the source is not in it until PR 6.

**Found on the way, outside PR 2** (differences of every function, rewritten in the oracle test and left to a
follow-up that matches Convex):

1. A cursor that does not parse fails with "InvalidCursor: Failed to parse cursor"; Convex's says "Failed to
   parse cursor" (`crates/keybroker/src/broker.rs:911`; the code is not in the message). Likewise "Key is invalid
   for instance" and "Missing position field" (`:1312-1326`). Core's `cursor.ts:120-148`.
2. `paginate({numItems: 0})` fails with "`options.numItems` must be a positive number. Received `0`."; Convex's
   JavaScript only refuses a negative number (`npm-packages/convex/src/server/impl/query_impl.ts:284-288`) and
   its backend says "Must request at least 1 document while paginating". Core's `tx.ts` `paginate`.
3. A system function's argument error is "ArgumentValidationError: …"; Convex's system functions check their
   arguments in JavaScript ("Uncaught Error: …"). `functions.ts` `systemArgs`.

**DV-479 (owner, 2026-10-12: follow Convex).** The dashboard contract (UI-01 §12.4) was written for the mock
before Convex's server was studied, and differed from it: an unset field matched only `neq`, `noneOf` and
`type: unset`, an empty `anyOf` matched nothing, a type clause followed dots. The owner chose Convex's rules and
set a standing rule: where the contract conflicts with Convex, the contract changes. So `filters.ts` (the mock and
the contract suite's oracle) now follows Convex's `paginatedTableDocuments` — an unset field below every value
(it passes `lt` / `lte`), an empty `anyOf` filters nothing, type clauses read the top-level field by its name — and
the source sends the clauses as they are (its first draft added an "is set" clause after `lt` / `lte` and
answered an empty page for an empty `anyOf`). The suite run against the live server now checks those rules too.
Only the wording of a malformed expression's error stays a divergence (DV-479): bunvex's one line, not zod's
issue list (asked as: Convex / bunvex / same: no, words only / why: reproducing zod's dump brings nothing, only
a hand-made URL sends one / app impact: none / decided: keep bunvex's words).

**Notes for PR 3** (the data mutations):

- The registry for the writes is `DATA_SYSTEM_QUERIES`' module; add a `DATA_SYSTEM_MUTATIONS` beside it and
  one spread into `SYSTEM_MUTATIONS`, as here.
- The writes need no change to `watchTable`: an insert or delete changes the size, a patch or replace changes a
  loaded page or the open document. The contract's `writes` area expects a write to reach `watchTable`; it
  will, through those subscriptions.
- `clearTablePage` loops on a cursor of `paginate` (4 000 per call); `createTable` inserts and deletes a
  document, so the mapping subscription gets the table.
- `getById` / `listById` already follow `queryGeneric`'s masks; Convex's mutations use `mutationGeneric`'s
  equivalents (`sst`).

**Notes for PR 6** (the app on the source): the tables query is refreshed only by a watched table's change
(D3); Convex's sidebar is live on the mapping — a `watchTables` (or refetching the list on the mapping's change)
would match it. Search, vector and staged indexes are not in `IndexInfo`. `tableOfId` answers user tables only.

### PR 5, as built

The Schedules, Files and History screens and Health's concurrency and invalidations, on the server source. Convex's
side re-read for it (citations under `dc/` as above; `su/` is `npm-packages/system-udfs/convex/_system/`):

- **Live lists and their auto-pause.** Schedules and Files are `usePaginatedQuery`s (one subscription per loaded
  page) wrapped in `usePausedLiveData` (`dc/lib/usePausedLiveData.ts`): each change of the results counts in a
  window that starts at mount and restarts at the first update more than 10 s after it (`:9-11`, `:16-46`); the
  101st update in a window pauses the list, keeps what it showed and toasts "There are too many updates to show
  live…" (`:84-94`); while paused the list is skipped (`usePaginatedScheduledJobs.ts:24-31`,
  `usePaginatedFileMetadata.ts:38-45`) and read with one-shot `client.query` calls on a second admin client
  (`usePausedLiveData.ts:102-161`); "Go live" toggles it back (`:220-225`). The pause is kept per deployment in
  local storage (`pauseLiveScheduledJobs`, `pauseLiveFileStorage`). Not paused: the crons (`listCronJobs`,
  `listCronJobRuns`, `dc/features/schedules/lib/CronsProvider.tsx:37-44`), the file count and the open file
  (`numFiles`, `getFile`, `FileStorageView.tsx:76-82`), History (`paginatedDeploymentEvents`,
  `dc/lib/useDeploymentAuditLog.ts:180-197`). Pages: 50 scheduled runs, 20 files.
- **Schedules.** `paginatedScheduledJobs` matches `udfPath` exactly (`su/frontend/paginatedScheduledJobs.ts:26-31`);
  the dashboard passes a function's identifier, `module.js:name`. A run's arguments come from
  `scheduler:getArgs` and are the bytes of a JSON array (`ScheduledFunctionsListItem.tsx:181`, `:200-203`).
  `/api/cancel_job {id, componentId}` and `/api/cancel_all_jobs {udfPath, componentPath, componentId}` answer 200
  with no body (`dc/features/schedules/lib/api.tsx:14-23`, `:62-70`); `cancel_all_jobs` canonicalizes its path,
  `cancel_job` refuses an id that is not a `_scheduled_jobs` one with a 400 `InvalidId`, "Invalid ID for table
  _scheduled_jobs" (`crates/local_backend/src/scheduling.rs:133-163`, `parse.rs:31-50`).
- **Files.** `fileStorageV2` reads `_storage` through `queryGeneric`, whose `db.system` is masked
  (`su/secretSystemTables.ts:70-97`): `get` reads an id of `_storage` or `_scheduled_functions` only and answers
  null for anything else, a malformed id or a user table's included; `getFile` then builds the URL, so a scheduled
  function's id fails there with "Invalid storage ID. Storage ID cannot be an ID on any table other than
  '_storage'." (`crates/model/src/file_storage/mod.rs:257-291`).
- **History.** Events with an action the dashboard does not know are dropped; a null `member_id` is named
  "Convex", any other one the team member's name, or "Unknown member" (`useDeploymentAuditLog.ts:20-91`); the
  self-hosted dashboard has no team, so an admin key's events are "Unknown member".
- **Health.** `function_concurrency` and `subscription_invalidations_top_k?k=3` over the last hour in 60 buckets,
  every 8 s, like the top functions (`dc/lib/appMetrics.ts:513-559`, `:801-857`); the scheduler lag every 60 s
  (`:119-165`). The concurrency gauges `outstanding_functions:<env>:<udfType>:<state>` are charted for isolate
  queries, mutations, actions and HTTP actions and Node actions only (`mapFunctionTypeToDisplayName`, `:789-799`).
  The invalidations are named `<mutation>:<table>`, or `<table>` for one mutation, and count every subscription the
  subscription manager holds (`crates/application/src/function_log.rs:1302-1320`) — including the ones its
  scheduler and cron executor wait on (`scheduled_jobs/mod.rs:331`, `:1219`; `cron_jobs/mod.rs:211`).

**What was built** (`packages/dashboard-source`, the contract in `packages/dashboard`):

- `live.ts`, `LiveGroup`: a screen's reads, remembered by list (a query and its filter); while someone watches,
  each one is a subscription and a new result (compared without the page's cursors) is a change. A list's first
  page drops the list's older pages; at most 8 lists are followed. `UpdateCounter` is Convex's window: past 100
  updates the paged lists stop being followed and the watchers hear `{paused: true}`; what Convex keeps live goes on
  being followed, its changes also delivered with `paused: true`; reads go on answering, one-shot. A new
  `watch` resumes (Convex's "Go live") and starts the count afresh. The contract's `watchScheduledFunctions` and
  `watchFiles` take an optional `LiveChange` (`{paused}`); the mock passes nothing.
- `deployment.ts`: `listScheduledFunctions` (`paginatedScheduledJobs` with the canonical path, each run's
  arguments by `scheduler:getArgs`, times in ms), `cancelScheduledFunction` and `cancelAllScheduledFunctions` (the
  routes; Convex's route answers no count, so the source counts the runs it lists just before), `listCronJobs`
  and `listCronRuns` (Convex's documents: int64 fields as numbers, `err` a failure, `canceled` skipped runs);
  `listFiles`, `countFiles`, `getFile`, `uploadFile` (`generateUploadUrl`, then a POST with the blob's type),
  `deleteFiles` (Convex's validator message is `invalid_request`, "not found" `not_found`); `listAuditEvents`
  (`paginatedDeploymentEvents`, `minDate` 0 by default; metadata in the contract's encoding; no member is
  `system` (DV-481), any member unknown, as Convex's self-hosted "Unknown member"). Every action is kept: the
  screen words what it knows. `fileStats` is not offered (Convex has no size or kind filter), so `listFiles`
  ignores `kind` and the sizes, as the contract allows.
- `metrics.ts`: the new optional contract methods `functionConcurrency` (Convex's gauges per kind, in Convex's
  kinds; a state with no gauge is all null) and `subscriptionInvalidations(window, k, {function?})` (pairs split
  at the last colon, display paths; one mutation's asked as Convex's, `udfPath` and `udfType: Mutation`). The mock
  has both too (from its log: overlapping executions; a mutation re-running up to three queries of its table).
- `wire.ts`: the client's values (bigint, ArrayBuffer) in the contract's encoding, ns → ms, arguments from their
  bytes, the canonical path.
- Health's top functions now refresh every 8 s (`HEALTH_REFRESH_MS`); the scheduler lag stays at a minute. The
  concurrency and invalidation charts are not drawn yet (the screens are PR 6's).

**The executors' own invalidations (DV-480, owner 2026-10-12: match Convex).** `packages/server/src/
executor-invalidations.ts` counts, on the committer, what the subscriptions of Convex's scheduler and cron
executor would count, into the same `subscription_invalidations:` counters as the clients' subscriptions:

- Each executor's read is its queue's `by_next_ts` index from the first pending key up to, but not including, its
  first run that is not due yet (Convex's `stream_jobs_to_run` stops there; open when there is none). It is read
  again after every commit that touches the queue or `_backend_state`, and when that run falls due; until then a
  run that has fallen due is inside.
- A commit with a write into a read counts one for that executor, under its source and the queue's table
  (`_scheduled_jobs`, `_cron_next_run`). A scheduled mutation's run counts once more (`jobRan`). Paused, the
  executors read only `_backend_state`, and nothing counts.
- Sources: a function by its canonical path; the executors' system commits under Convex's names
  (`scheduled_job_gc`, `scheduled_job_progress`, `scheduled_job_complete_action`, `scheduled_job_system_error`,
  `cron_in_progress`, `cron_complete_action`, `cron_save_mutation_error`, `cancel_job`, `cancel_all_jobs`); the
  scheduler's commits now carry those names (an action's start and end, a job whose function is gone
  `scheduled_job_bad_udf`, one cut short `scheduled_job_action_error`), and a failed mutation's result is saved
  under the function's name, as Convex's `WriteSource::mutation`. Other system commits (a push) count nothing.
- Measured on the binary, step by step (the oracle below): a run scheduled on an empty queue counts 1; one after
  the first future run 0; cancelling that first future run, or every run, 0; a nearer run 1, and its run 2; a cron
  run 1. The rule above reproduces each. Why a mutation's run counts twice is not explained by the source read
  (two subscriptions over the running job, one taken before it fell due, is the likeliest); it is kept as observed.
- Under load the binary counts less, never more: its executors drop their subscription as soon as a run they
  started reports back (`select_biased!` on `job_finished_rx` first, `application/src/scheduled_jobs/mod.rs:339`,
  `cron_jobs/mod.rs:212`), and the subscription worker removes a closed subscription before it reads the log
  further (`database/src/subscription.rs:321-346`), so a run whose report beats the worker to its commit goes
  uncounted. bunvex counts what the unhurried binary does. The step-by-step oracle measures each step on its own
  (the counts it adds, once the due runs have run and the counts stopped moving) and runs the sequence again on
  fresh backends, up to three times, while the binary counted less than bunvex; bunvex counting less fails at once
  (the deploy's cron run went missing on the binary in about 1 run in 10 at a load average of 20).

**The server, matched to Convex's binary where the oracle found it apart** (`packages/server`):
`/api/cancel_job` with an id not of `_scheduled_jobs` was a 500 (an uncaught error) and is Convex's 400
`InvalidId`; `fileStorageV2:getFile` threw for a malformed id and refused a user table's ("User tables cannot be
accessed with db.system.") and now masks as Convex's `queryGeneric` (null, and a scheduled function's id fails at
its URL); `paginatedScheduledJobs` canonicalized its `udfPath` ("by either spelling") and now matches it exactly.
The contract's `getFile` says null for an id that is not a storage id on a deployment; the mock's
`invalid_request` stays allowed, so the Files screen's "is not a storage ID" message only shows on the mock (PR 6).

**Divergences.**

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-480 | Health's invalidations counted client subscriptions only; Convex's also count its scheduler's and cron executor's own | bunvex's scheduler and crons are woken by the committer, not by subscriptions | owner, 2026-10-12: **match Convex**; built (below), resolved |
| DV-481 | An event with no member is by `system`, where Convex's dashboard says "Convex" | rule 5 | rule 5 |

Not divergences (the screens are PR 6's): Convex keeps the pause in local storage per deployment, and after an
auto-pause and "Go live" it never pauses that view again until it is mounted again; here a new `watch` resumes and
counts afresh, and keeping the pause is the screen's. While the schedules are paused, a cron's change still
signals the watcher (Convex re-renders only the crons; the screen may refetch only them on `paused: true`).
Convex's paused scheduled list shows its first page only (`Exhausted`); the contract's pages stay readable.

**Tests.**

- `packages/sync-e2e/dashboard/server-source-ops.test.ts` (a server in the process, an app with two scheduled
  functions, two crons and files; `live-server.ts` the shared helper): the contract suite's `deploymentFeatures`
  area against the live server with cancelling and uploading enabled (`only: ["deploymentFeatures"]`; the
  history opt-in needs PR 3's writes), then a run's mapping (display path, arguments with an int64, times), the
  filter, the crons and their first run, cancel-all's count, a file's metadata and URL, the audit log (the
  dashboard's own writes, the push, the authors), the watchers (a new nearest run is heard and an unrelated write
  is not; a change on a later loaded page is heard; uploads reach `watchFiles` and `watchAuditEvents`; nothing
  after the last watcher leaves), the auto-pause on 100+ quick schedules (paused at the 101st or later, nothing
  heard after, reads still answer, a new watcher resumes), and Health's concurrency (kinds, buckets, a query
  running), invalidations (an app subscription re-run by `messages:send` on `messages`, overall and for that
  mutation) and their errors. The metrics contract area stays off until PR 4 (its setup lists functions).
- `packages/server/test/executor-invalidations.test.ts`: the executor's read (an empty queue counts, a later
  run and the first future run do not, cancels do not), a nearer run and its two counts, a failed run under its
  function's name, nothing while paused.
- `packages/dashboard-source/test/live.test.ts` (a fake connection): the window (100 pass, the 101st pauses, the
  window restarts after 10 s), the fingerprint, following and unfollowing, a change between the read and the
  watch, the list and page bookkeeping, pausing (paged lists unfollowed, the rest live, resumed by a new
  watcher), errors. `deployment-mapping.test.ts`: the documents and answers in Convex's shapes.
- The contract (`packages/dashboard/src/contract-metrics.ts`): concurrency (each kind once, in order, a bucket per
  window bucket) and invalidations (at most k pairs and the rest, ranked, one mutation's tables); they run on the
  mock. `contract-deployment.ts`: an upload's type is the blob's (Bun adds a charset to `text/plain`); `getFile`
  of a non-id is null or `invalid_request`.
- **Oracle** (`packages/differential/test/dashboard-ops.test.ts`, the app in `dashboard-app/`, against
  `precompiled-2026-10-07-d8bdde0`): the same requests on both backends, answers compared with ids, times and
  cursors named by order: `paginatedScheduledJobs` (all, one function's, a display path matching nothing),
  `scheduler:getArgs`, `listCronJobs`, `listCronJobRuns`, `cancel_job` (a bogus id, one run, twice),
  `cancel_all_jobs`, the cancel and file audit events (action, member, metadata), uploads, `fileMetadata` both
  ways, `numFiles`, `getFile` (a file, a malformed id, a scheduled function's id), `deleteFiles` (a bad id, a
  deleted file), `function_concurrency`'s gauges, and `subscription_invalidations_top_k` after a client
  subscription (the same pairs on both, the executors' included), and a scheduling app step by step: after
  each of the deploy's cron run, a run on an empty queue, cancelling it, another, a later one, a nearer one that
  runs, two that run, and cancelling everything, every `subscription_invalidations_top_k` pair and count is equal. One wording is
  rewritten, not fixed here: bunvex wraps the other-table storage id error as ``Invalid argument `storageId` for
  `storage.getUrl`: …``, where Convex's model raises it bare (`file_storage/mod.rs:257-291`); it reaches
  `ctx.storage.getUrl` in apps too, so it is reported for its own PR (STUDY-32 says both are wrapped).

**Sabotage** (each restored after, `git diff` clean; unit / live / server / oracle tests):

| Sabotage | Failing tests |
|---|---|
| the pause at the 100th update, not the 101st | 5 |
| a paused list keeps its subscriptions | 2 |
| the window never restarts | 2 |
| a read made while watched is not followed | 5 |
| a list's first page keeps its older pages | 1 |
| a page's cursors count as a change | 2 |
| the last watcher leaves its subscriptions | 1 |
| an unchanged result counts as a change | 4 |
| a new watcher does not resume a paused list | 2 |
| display paths sent to `paginatedScheduledJobs` | 3 |
| times divided by 10³, not 10⁶ | 5 |
| arguments as the whole array | 4 |
| int64 encoded big-endian | 2 |
| Node actions left out of concurrency | 2 |
| invalidations split at the first colon | 2 |
| a cron's skipped runs as failures | 1 |
| the system as an unknown author | 1 |
| cancel-all counts nothing | 2 |
| `watchFiles` never fires | 2 |
| server: `getFile` not masked | 2 (server, oracle) |
| server: `cancel_job`'s `InvalidId` left a 500 | 2 (server, oracle) |
| server: the job filter canonicalizes again | 2 (server, oracle) |
| DV-480: the first future run inside the read | 8 (server, oracle) |
| DV-480: the read never moves (always open) | 9 (server, oracle) |
| DV-480: a scheduled mutation's run counted once | 4 (server, oracle) |
| DV-480: pause ignored | 1 (server) |
| DV-480: a failed run saved under a system name | 1 (server) |
| DV-480: cron runs not counted | 9 (oracle) |
| DV-480: completed jobs' keys inside the read | 8 (server, oracle) |
| one mutation's invalidations asked without `udfType` | 0: both servers default it to a query, which names the same function |

The Health intervals (8 s, 60 s) are constants with no test of their own.

**Measurements.** The committer gains one listener (DV-480): 114 ns per commit for a user commit with six
index writes, 88 ns for one that schedules a job (Bun, M-series, the reads' refresh stubbed); a commit that touches
a queue then reads its first future run once, off the commit path, coalesced. `getFile` adds two id checks,
`cancel_job` an error branch. In the
source, each new result of a followed read is fingerprinted: 58 µs for a 50-run page (Bun, M-series), so at
Convex's pause rate (10 updates/s) under 1 ms/s.

**A fix found in CI** (`sync.ts`, PR 1's `AdminSync.watch`): a read could answer `null`. A subscription that sees
a local result delivers it on the next tick; when that result was kept from a subscription just dropped, a server
transition answering the older query set can clear it before the tick, and the read answered `null` (a cron run
list, under load). Convex's `listCronJobRuns` always returns an array (`collect()`); its dashboard's `useQuery` is
`undefined` only while loading, never null. So the read now waits for its own result when the local one is gone,
rather than handling a null. Tests: `test/sync.test.ts` (a result cleared before the tick is not delivered, one
still held is) and 150 back-to-back cron reads on the live server; with the fix removed both fail (the live loop
reproduces it without load).

**Found, not fixed here** (each its own concern): a cron job with an int64 argument makes `start_push` answer 500
(`JSON.stringify` of a BigInt in the push's answer, `server.ts` `pushRoute`); the storage id wording above.

#### PR 5 Q1 — The scheduler's and crons' own subscriptions in Health's invalidations (DV-480)

- *Convex*: Health's "Subscription Cache Invalidations" counts every subscription its subscription manager
  invalidates, the ones its scheduler and cron executor wait on included. A mutation that schedules shows as
  `<mutation>:_scheduled_jobs`, and each cron run as `<function>:_cron_next_run`, beside the app's real pairs
  (checked against the binary).
- *bunvex*: counts the subscriptions of clients (apps, and the dashboard's own) only. Its scheduler and crons are
  woken by the committer's `onCommit`, not by subscriptions, so nothing invalidates for them.
- *Same?* No: on a scheduler-heavy app, Convex's top 3 often holds `_scheduled_jobs` pairs; bunvex's shows only the
  app's queries.
- *Why*: "Ainda não fizemos" — the committer could count one invalidation per commit that writes `_scheduled_jobs`
  or `_cron_next_run` (and `_backend_state`, which both executors also watch), as if they subscribed.
- *App impact*: none (the dashboard only).
- *Recommendation (then)*: keep bunvex's count (accept DV-480). The chart's tooltip says it shows "the mutation and table
  pairs that caused the most queries to be re-run"; the scheduler's wake-ups are not queries, and counting them
  would need synthetic events that mirror Convex's executor design rather than anything bunvex runs.
- **Decision (owner, 2026-10-12): match Convex** — built as above; DV-480 is resolved to match Convex.

### PR 3, as built

The Data screen's writes. Convex's side re-read for it (`fe/` and `dc/` as above; `ad/` is
`npm-packages/system-udfs/convex/_system/`):

- **Six mutations** (`fe/addDocument.ts`, `patchDocumentsFields.ts`, `replaceDocument.ts`, `deleteDocuments.ts`,
  `clearTablePage.ts`, `createTable.ts`), each `mutationGeneric("WriteData")` (`ad/server.ts:160-189`): the key must
  allow `WriteData` (`requireOperation`, `:125`), the arguments are checked inside the function (`validateArgs`,
  `:126-133`, "Uncaught Error: …"), a non-null `componentId` re-runs the function in that component (`:177-183`).
  The database is an app's (`mutationGeneric`, not `queryPrivateSystem`): `_`-tables are read-only, the schema is
  enforced, an insert into a table that does not exist creates it.
  - `addDocument {table, documents}`: past 4 096 (`MAX_IMPORT_COUNT`, half a transaction's user writes) it answers
    `{success: false, error: "Can’t import more than 4096 documents at once."}` (a typographic apostrophe); each
    document inserted in order; an insert's error rewrapped as `ConvexError(e.message)` (`:42`, "it could be a
    schema validation error"), so the dashboard shows the data alone (`useDataToolbarActions.ts:47-60`). It answers
    `{success: true}` — **no ids**.
  - `patchDocumentsFields {table, fields, ids?}`: the documents of `ids` (`db.get` each, outside the rewrap: an id
    that does not decode fails as `db.get` does), or every document of `table` without `ids` (the dashboard's
    "edit all"); `fields` walked with `for…in`, the undefined placeholder removing a field (`:29`); each patch
    inside the rewrap — so a document that is gone fails with V8's "Cannot read properties of null (reading
    '_id')" as a `ConvexError`. `_id` and `_creationTime` may be patched to their own values only (the engine's
    check). The event names `table` as given and the ids patched (`:39`).
  - `replaceDocument {id, document}`: a document that is gone answers `{success: false, error: "Document does not
    exist."}`; the replace rewrapped; the event names the id's table by the table mapping (`:33`).
  - `deleteDocuments {toDelete: [{id, tableName}]}`: past 4 096 `{success: false, error: "You can't delete more
    than 4096. Try selecting fewer documents instead.."}`; each `db.delete` unwrapped (a gone id: "Delete on
    nonexistent document ID …", the whole call fails); one event per `tableName` given, in first-named order.
  - `clearTablePage {tableName, cursor}`: the oldest 4 000 (`MAX_CLEAR_ROWS`) by `by_creation_time` ascending
    ("to avoid repeatedly invalidating the query run by the data page"), at most 3 000 000 bytes read (so a page and
    its deletes stay under 8 MiB, `:36-42`), each deleted, one `delete_documents` event when any was (`:47`);
    `{deleted, continueCursor, hasMore}`. The dashboard calls it again with `continueCursor` while `hasMore`,
    showing the progress, and stops if the dialog closes (`ClearTableConfirmation.tsx:58-81`). A table that does
    not exist fails ("Index nope.by_creation_time not found.").
  - `createTable {table}`: `db.insert(table, {})` then `db.delete` (`:10-13`), unwrapped. A taken name is no error
    (the form refuses it, `DataSidebar.tsx:105-160`), unless the table's declared type refuses `{}`; a bad name fails
    with `db.insert`'s identifier error.
- **Deleting tables** is the HTTP route (`dc/features/data/lib/api.ts:13-29`, `POST /api/delete_tables {tableNames,
  componentId}`), already built (STUDY-42); the menu disables it for a table the schema declares
  (`DataOverflowMenu.tsx:96-125`).
- **The events.** `writeAuditLog(action, metadata)` is the `1.0/writeDeploymentAuditLog` syscall, system functions
  only; it adds `component_id` and `component` to the metadata (`crates/isolate/src/environment/udf/async_syscall.rs`
  `write_deployment_audit_log`) and stores Convex's `DeploymentAuditLogEvent` (`crates/model/src/deployment_audit_log/
  types.rs:254-280`, serialized `:579-640`): `add_documents`, `update_documents`, `delete_documents` `{component_id,
  component, table, document_ids}`, `create_table` `{component_id, component, table}`, in the write's transaction.
  History lists them (`useDeploymentAuditLog.ts:42-79`) and words them "added N documents to T", "updated N documents
  in T", "deleted N documents from T", "created table T" (`DeploymentEventContent.tsx:485-559`), N being the ids'
  count. Clearing a table records `delete_documents` per page, not `clear_tables` (that one is streaming import's).

**What was built.**

- Server (`packages/server/src/data-system-mutations.ts`, spread into `SYSTEM_MUTATIONS` by one line; the four events
  in `audit-log.ts`): the six mutations as above, `componentId` accepted and ignored (DV-55), the rewrap as a
  `BunvexError` (DV-03), bunvex's placeholder (DV-478). In a transaction of an app's (the `db` system functions get),
  so the refusals are the engine's own.
- Source (`packages/dashboard-source/src/writes.ts`, spread into the server source): each contract write is the
  mutation over the socket with `componentId: null` (values decoded from the contract's JSON encoding; `{$unset:
  true}` the placeholder); `clearTable` loops `clearTablePage` on its cursor, checks the abort between pages, and
  answers `not_found` for a table the mapping does not have (the server would answer zeros); `deleteTables` posts the
  route, then waits (at most 5 s) for the subscribed table mapping to drop the tables, since the route answers ahead
  of the socket. A failure's code: an application error's data is the message (as Convex's dashboard shows it) and is
  `invalid_request`, as is any other error the function raised (`Uncaught …`, frames dropped); a document that is gone
  (`Delete on nonexistent document ID`, the null `_id`, "Document does not exist.") `not_found`; a permission refusal
  `unauthorized`; anything else `unavailable`. `watchTable` needed nothing: the writes reach it through the size and
  page subscriptions of PR 2.
- **The contract follows Convex** (DV-479's standing rule; `data-source.ts`, UI-01 §5): `insertDocuments` answers
  nothing (Convex's mutation answers no ids; the screen counts what it sent, as Convex's `onDocumentsAdded`), at most
  4 096, and creates a missing table; `patchDocuments` and `replaceDocument` say `not_found` for a document that is
  gone; `deleteDocuments` fails for one (it ignored them), at most 4 096; `clearTable` pages and may stop on an abort;
  `createTable` accepts a taken name; a new optional `deleteTables(names)` (Convex's route, a missing name skipped, a
  declared table `invalid_request`). The mock follows (its events now carry Convex's metadata: the documents' ids and
  the root component; a clear records a `delete_documents` per 4 000), and the contract suite checks each rule. The
  History screen counts a data event's `document_ids` (and a `delete_files`' `storage_ids`), and words
  `delete_tables`. The Data screen's menu gained "Delete table…" (its name typed to confirm, as Clear; disabled and
  saying why for a declared table, as Convex's menu); after it the screen opens the first table left.
- The contract's history opt-in now reads the first page before the write, as the History screen does: a live
  source hears what changes the pages it served while watched (`watchAuditEvents`' wording says so).

**Tests.**

- **Oracle** (`packages/differential/test/dashboard-writes.test.ts`, the app in `dashboard-writes-app/`): the six
  mutations on Convex's pinned binary and on bunvex with the same calls, every answer (values, errors and their data),
  the documents left and the events recorded compared, ids by first appearance: inserts (none, a bad field, another
  document's `_id`, a new table, the schema, `_storage` and `_foo`, 4 097, a missing argument, `componentId: null`),
  patches (set, remove, own and other `_id`, an id that does not decode, every document, `fields` not an object, no
  ids, one gone, another table's name, the schema), replaces (with its own system fields, another `_id`, not an id,
  gone, the schema), deletes (two tables' events, gone, not an id, 4 097, a wrong table name, a missing `tableName`),
  clears (4 106 documents: 4 000 oldest then 106, an empty table, `_storage`, a bad cursor, a missing one) and
  `createTable` (new, taken, 64 characters, `_x`, a declared `v.any()` table), and the six without a key.
- **Server** (`packages/server/test/data-system-mutations.test.ts`): bunvex's placeholder (Convex's an ordinary
  string), a refused insert leaving no document and no event, the events' metadata in order, a clear's page cut by
  the 3 MB bound and oldest first.
- **Source** (`packages/dashboard-source/test/writes.test.ts`): what each write sends, the clear's loop and abort,
  `success: false`, the error codes, `deleteTables`' wait.
- **Live** (`packages/sync-e2e/dashboard/server-source-writes.test.ts`): the contract's `writes` area and history
  opt-in on a live server, then int64 and bytes written, a field removed, the events with their ids, the schema's,
  a system table's and the limit's refusals with the deployment's words, a gone document's `not_found` for patch,
  replace and delete, a clear of 8 192 documents in three pages with three events, `createTable` / `deleteTables`
  and their events (a missing name skipped, a declared table refused), `watchTable` hearing an insert's count, and a
  read-only key refused with nothing written.
- **Dashboard**: the mock's writes under the new contract (`mock.test.ts`'s suite), "Delete table" on the screen
  (typed name, gone after, disabled for a declared table), History's words from `document_ids`.

**Sabotage** (each restored after, `git diff` clean; counts are failing tests per suite):

| Sabotage | Failing tests |
|---|---|
| server: no 4 096 limit on `addDocument` | oracle 1 |
| server: an insert's error not rewrapped | oracle 1, server 1 |
| server: the placeholder not read as `undefined` | server 1, live 2 |
| server: a gone document left to the engine's `TypeError` (JSC's words) | oracle 1, live 2 |
| server: `deleteDocuments` one event for every table | oracle 1 |
| server: the clear from the newest | oracle 1, server 1 |
| server: the clear without the 3 MB bound | server 1 |
| server: an empty clear page records an event | oracle 1 |
| server: `createTable` leaves its document | oracle 1 |
| server: the replace's event without its table | oracle 1 |
| source: the clear's cursor not passed on | unit 1 |
| source: `$unset` sent as a value | unit 1, live 2 |
| source: a gone document `invalid_request` | unit 2, live 2 |
| source: `componentId` not sent | unit 1 |
| source: `deleteTables` does not wait for the mapping | unit 1 (first passed everything: the live race was not reliable; the unit fake now lags the mapping) |
| mock: a gone id ignored by `deleteDocuments` | dashboard 1 (the contract on the mock) |
| mock: `createTable` refuses a taken name | dashboard 1 |
| screen: "Delete table" enabled for a declared table | dashboard 1 |
| History: data events counted from `count` | dashboard 2 |

**Measurements.** No hot path changes: six system functions and four audit events; the route is unchanged. The source adds
nothing to a read. A clear of 8 192 documents on the in-process server takes three mutations.

**Divergences.** None new (DV-482 to DV-485 unused). What differs is already decided: the application error's name
(DV-03), the placeholder (DV-478), `componentId` ignored (DV-55). The contract's changes are DV-479's rule, not
divergences; the delete dialog's typed name is bunvex's screen (STUDY-12 D1).

**Found on the way, outside PR 3** (differences of the engine every function shares, left out of the oracle with a
note and left to their own PRs):

1. `db.insert` into a name that is not an identifier: bunvex's `Invalid table name "9lives": use at most 64 ASCII
   letters, …`; Convex's ``Invalid argument `table` for `db.insert`: `` then the identifier's own error ("Invalid first
   character '9' in 9lives: Identifiers must start with an alphabetic character or underscore", "Identifier cannot be
   empty", "Identifier is too long (65 > maximum 64)", "Identifier a-b has invalid character '-': …").
2. `db.insert` of a value that is not an object: bunvex's ``Uncaught TypeError: … expected an object``; Convex's
   ``Uncaught Error: Invalid argument `value` for `db.insert`: Value must be an Object``.
3. A missing required field's schema error displays the document and validator with the system fields on bunvex
   (`Object: {_creationTime: …, _id: …}`, `Validator: v.object({_creationTime: v.float64(), _id: v.id(…), …})`);
   Convex's without them (`Object: {}`). A wrong type's error matches.
4. `db.patch` with another `_creationTime`: bunvex shows the patch as JSON (`{"_creationTime":1}`), Convex the merged
   document in its display (`{_creationTime: 1.0, _id: "…", k: 1.0}`); and bunvex's error carries the server's own
   frames (`at checkSystemFieldValues (…/packages/core/src/tx.ts:…)`) to the client, where Convex shows the app's.
5. `withIndex("by_creation_time")` on a table that does not exist: Convex fails ("Index nope.by_creation_time not
   found."), bunvex answers an empty result.
6. A `$` field name inside a system function's `v.any()` argument is refused before the function on bunvex
   ("Invalid arguments for …: Field name $x starts with '$', which is reserved."); Convex's function refuses it
   ("Uncaught Error: Field name $x starts with a '$', which is reserved.").
7. A push creates the schema's new tables in declaration order on bunvex, in name order on Convex (table numbers
   10001, 10002 differ for the same schema).

**Notes for PR 6** (the app on the source): Convex's bulk edit (`patchDocumentsFields` without `ids`, every document of
the table) has no contract method yet; the History screen words the other actions from their counts (`cancel_all_…`
has no count on Convex).

### PR 4, as built

The Functions screen, the function runner (with its custom test query) and the Settings screens, on the server
source. Convex's side re-read for it (citations under `dc/` and `fe/` as above; `fr/` is
`dc/features/functionRunner/`):

- **The module list.** `fe/modules.ts`: `listForAllComponents` answers `[componentId | null, [path, module][]][]`,
  the root's modules first, then each child component's (it calls itself in each, `currentSystemUdfInComponent`).
  A module is listed when it has an analysis (`listHandler`), as `{functions, sourcePackageId, cronSpecs?}`; each
  function is `{name, lineno, udfType, visibility}` (`processFunction`: the line from `pos.start_lineno`, none for
  0; `visibility` public when absent), and the module's HTTP routes are appended as functions named
  `<METHOD> <path>` with `udfType: "HttpAction"` (`processHttpRoute`). `sourcePackageId` is there so a push
  re-renders every subscriber ("By returning sourcePackageId…", `fe/common.ts`). The dashboard keeps it subscribed
  for its whole life (`dc/lib/functions/useListModules.ts:20-49`, `FunctionsProvider.tsx`), so a push reaches the
  tree. The tree (`dc/lib/functions/generateFileTree.ts:96-180`) skips a module with no function, puts folders
  before files by name, and sorts a file's functions by `lineno` (`-1` when absent); the runner offers queries,
  mutations and actions only (`SUPPORTED_FUNCTION_TYPES`).
- **Arguments.** `modules:argsValidator({function})` splits the display name at `:` (two parts), reads the
  `_modules` row at `<path>.js` by `by_path` (`unique`), and answers the function's stored `args` text, Convex's
  `DEFAULT_ARGS_VALIDATOR` (`{ "type": "any" }`) when it has none, or null (`fe/modules.ts:48-80`). The runner
  subscribes it for the open function (`fr/components/FunctionTester.tsx:188`). The returns validator is not shown
  anywhere in Convex's dashboard.
- **The runner** (`fr/lib/client.ts:14-48`, `FunctionTester.tsx:520-610`, `QueryResult.tsx`): a second
  `ConvexReactClient` signed in with `setAdminAuth(adminKey, identity)`; a new identity re-authenticates it. A query
  is `watchQuery` on it: live, its log lines from `localQueryLogs`, a failure as its error text. A mutation or an
  action is `mutationInternal` / `actionInternal` on its `BaseConvexClient`, the result with its `logLines`; the
  request's session id and counter filter the log stream for the run's lines. Internal functions need
  `RunInternal*`, acting as a user `ActAsUser`.
- **Custom test query** (`fr/components/FunctionEditor.tsx:71-73`, `:165-300`; `fr/lib/client.ts:50-105`): Monaco
  holds the TypeScript (with the schema's generated types for completion), its TypeScript worker compiles it
  (`getEmitOutput`), the preamble `import { query, internalQuery } from "convex:/_system/repl/wrappers.js"` is put
  first, and `POST /api/run_test_function {bundle: {path: "testQuery.js", source}, adminKey, componentId, args: {},
  format}` runs it, the key in the body and no `Authorization`. 200: `{status: "success", value, logLines}` or
  `{status: "error", errorMessage, errorData, logLines}`; a 4xx shows the body's `message` as the run's error; a 5xx a
  generic one. Gated on `RunTestQuery` (read-only keys have it). The default code is a query reading `take(10)` of
  the table the Data screen shows (`YOUR_TABLE_NAME` otherwise).
- **Settings.** `listEnvironmentVariables` (`fe/listEnvironmentVariables.ts`, `ViewEnvironmentVariables`): the
  `_environment_variables` documents by name, subscribed (`DeploymentEnvironmentVariables.tsx:34`); changes go to
  `POST /api/update_environment_variables {changes}` (`features/settings/lib/api.ts:20-48`), whose 400 names the
  variable. `latestExport` (`fe/latestExport.ts`, `ViewBackups`): the newest `_exports` row of the `snapshotExport`
  requestor; `snapshotImport:list` (`fe/snapshotImport.ts`): the 20 newest `_snapshot_imports`. `getVersion`
  (`noPermissionRequired`): `_udf_config.serverVersion || null`. `components:list`: each `_components` row with its
  path from its parents (`""` for the root), `args` as an object, `state` (default `active`), `httpPrefix`.
  `convexCloudUrl` / `convexSiteUrl` (`ViewData`): `CONVEX_CLOUD_URL` / `CONVEX_SITE_URL`.

**Server** (`packages/server/src/frontend-system-functions.ts`, spread into `SYSTEM_QUERIES` by one line):
`modules:listForAllComponents`, `modules:list`, `modules:argsValidator`, `components:list`, `getVersion`,
`cloudUrl` and `siteUrl` (DV-474: Convex's `convexCloudUrl` / `convexSiteUrl`; the canonical URL when set, as
`_system/cli/deploymentUrl:cloudUrl`), `listEnvironmentVariables`, `latestExport`, `snapshotImport:list`; each
under Convex's permission. They read the rows bunvex stores as Convex's (`_modules` with its
`SerializedAnalyzedModule`, `_components`, `_udf_config`; STUDY-134), so the code is Convex's reading of them.

**Source** (`packages/dashboard-source`, `functions.ts` and `settings.ts`, wired in `server-source.ts`):

- `listFunctions`: `listForAllComponents`, the root's queries, mutations and actions at `module:name` with their
  visibility and `line`; the validators come from `_system/cli/modules:apiSpec` in the same call — the contract
  carries the arguments and returns validators in the list, and one query serves every function where
  `argsValidator` would take one each and never gives the returns one. `v.any()` (what a function declared without
  arguments exports) is no validator, as the contract's "none declared".
- `watchFunctions` (new optional contract method): the module list kept subscribed while watched (`LiveGroup`, PR 5);
  a push is a new result. The Functions screen and the runner list the functions again on it (`useLiveFunctions`).
- `runFunction`, `watchFunction`: a runner client per identity (none: the admin), as Convex's second client, signed
  in with `setAdminAuth(key, identity)`; at most 4 kept, the least recently used idle one closed. A query is
  subscribed (once for `runFunction`), a mutation or an action is `mutationInternal` / `actionInternal`; the result's
  log lines (`[LEVEL] message`, Convex's `entryLogLines`) come with it, values in the contract's encoding, the
  duration measured as Convex's runner measures it (client side). What the function throws is the run's error. Before
  a run the source checks what the contract asks (`not_found`, `unauthorized` for a credential without
  `runFunctions`, a read-only one running a mutation or an action, or one without `actAsUser` acting as a user), so a
  server refusal is never mistaken for the function's own error.
- `runTestQuery(code)` (new optional contract method): Convex's request, with bunvex's preamble specifier
  (`bunvex:/_system/repl/wrappers.js`, DV-390) and format (`encoded_json`, DV-307); a 400 is the run's error (a
  module that does not load), a refused key `unauthorized`, a 5xx `unavailable`.
- Settings: `listEnvironmentVariables` subscribed while watched, with the new optional
  `watchEnvironmentVariables`; `updateEnvironmentVariables` posts the batch as it is (the server checks it whole);
  `listAuthProviders` (the `_auth` documents, a custom JWT's stored algorithm unquoted); the snapshots —
  `getLatestSnapshotExport` (`latestExport`), `requestSnapshotExport` (`/api/export/request/zip`, then the latest),
  `downloadSnapshotExport` (`/api/export/zip/{id}` with the key in `Authorization`), `startSnapshotImport` (the CLI's
  `start_upload`, 8 MiB `upload_part`s, `finish_upload`, then read until the deployment has parsed it; what changes
  per table from the row's checkpoints), `confirmSnapshotImport` (`/api/perform_import`), `cancelSnapshotImport`
  (`/api/cancel_import`), `getSnapshotImport` (`_system/cli/queryImport`). An export or an import is read over
  `/api/query`, fresh: a socket result kept for a query just dropped could be older than the request that started it.
- `getDeployment`: `url` from `cloudUrl` (the server's URL when the credential cannot read it), `httpActionsUrl` from
  `siteUrl` when set.

**The contract, moved to Convex** (the owner's standing rule, DV-479): `FunctionInfo.line` (Convex's `lineno`) and
the tree ordered by it; `SnapshotExportState` gains Convex's `canceled`; the new optional `watchFunctions`,
`runTestQuery` and `watchEnvironmentVariables`. The contract suite checks `line`, `runTestQuery` (a value with its
log lines; a throw and a module that does not load are runs) and that an environment variable watcher hears a change.
Its invalidations test now picks a deployed mutation's pair (an admin route's write, such as an environment
variable's, is a pair whose source no mutation filter names — the first live run of the metrics area found it).

**The screens** (`packages/dashboard`): the runner's picker starts with "Custom test query" when the source has
`runTestQuery`: a TypeScript editor (Monaco's TypeScript language, syntax checked; no type checking, since the app's
types are not in the browser — Convex's editor has its schema's generated types, a gap), Convex's starting code on the
first table, compiled by Monaco's TypeScript worker (`transpileTypeScript` in `@bunvex/ui`, Convex's
`getEmitOutput`), run once, its result and logs beside it. The Functions screen and the runner follow a push; the
environment variables follow changes made elsewhere, but not over edits waiting to be saved (saving reloads them);
a canceled export says so.

**Found and fixed on the way** (the oracle): an import's `_snapshot_imports.member_id` was always null; Convex's
records the admin key's member (`identity.member_id()`, 0 for a key issued without one). `start` and the one-shot
import now take the caller's member (`imports.ts`, `server.ts`; storage parity).

**Found, not fixed here** (each its own concern): a function declared with a `returns` validator has its analyzed
line two lines before Convex's (`messages:secret`: 37 against 39; the push's `pos`, STUDY-65 M5), masked in the
oracle; bunvex's `_system/cli/modules:apiSpec` reads the loaded code rather than the `_modules` rows (not reactive,
validators `JSON.parse`d rather than `jsonToConvex`), which answers the same today.

**Not built here**: HTTP actions in the Functions tree (Convex lists them under `http.js`; the contract's
`FunctionKind` has no HTTP action — a contract change with the Logs screen's kinds, for PR 6), the custom query's
type checking and completions, `latestExport:latestCloudExport` and `canExportFileStorage` (cloud backups, cloud only),
child components (DV-55).

**Tests.**

- **Oracle** (`packages/differential/test/dashboard-functions.test.ts`, the app in `functions-app/` with a nested
  module, HTTP routes, a cron, an internal query with an int64 `returns`, a function without a validator, a default
  export): `listForAllComponents` and `modules:list` (by path; Convex's CLI also pushes `convex.config.js`), eleven
  `argsValidator` names (compared as JSON), `components:list`, `getVersion`, the URLs, `listEnvironmentVariables`
  before and after a change, `latestExport` before and after an export, `snapshotImport:list` before and after an
  upload waiting for confirmation (the confirmation's CLI name rewritten, rule 5), the runner over the socket (a query
  as the admin and acting as a user, an internal query with an int64, a mutation, an action, a misfit) and two custom
  test queries (a value with its log line, a throw; a module that does not load is a 400 on both).
- **Server** (`packages/server/test/frontend-system-functions.test.ts`): a module without an analysis, a function
  without a position, a route on line 0, crons; `argsValidator`'s misses; a child component's path; an empty
  version; the canonical site URL; the 20 newest imports without bunvex's own fields; each function's permission.
  `imports.test.ts`: an import's member.
- **Source** (`packages/dashboard-source/test/functions-settings.test.ts`): the list's mapping, validators, log
  lines, values and errors, the test query's request and each answer, the export, import and provider documents.
- **Live** (`packages/sync-e2e/dashboard/server-source-functions.test.ts`): the contract suite's `functions`, `run`
  (with a misfit), `metrics`, `snapshot` (an export and an import), `auth` and `deploymentFeatures` (environment
  variables changed) areas; the list's mapping; a push heard by `watchFunctions`; runs of each kind, an int64, a
  throw, acting as a user (two identities at once), a read-only key; a watched query following its data and
  stopping; `not_found` and a watched mutation's `invalid_request`; test queries (a read-only key, a write refused, a
  wrong key); a variable changed by the CLI's route heard; the URLs.
- **Screens** (`packages/dashboard/test`): the tree's order by line; a push relisting the functions; the custom test
  query (first in the picker, Convex's starting code, run, its result, axe) and its absence without `runTestQuery`;
  the variables reloaded on a change but not over edits; a canceled export. `transpileTypeScript` was run in a
  browser against Monaco's worker (types and a type-only import erased).

**Sabotage** (each restored after, `git diff` clean; every one turned a test red):

| Sabotage | Failing tests |
|---|---|
| server: `argsValidator` reads the path without `.js` | server |
| server: a module without an analysis listed | server |
| server: HTTP routes not listed | server |
| server: `listEnvironmentVariables` under `ViewData` | server |
| server: `getVersion` answers an empty version | server |
| server: `siteUrl` ignores the canonical URL | server |
| server: an import's member left null | server; oracle |
| source: `v.any()` listed as a validator | unit; live |
| source: the runner does not act as the user | live (2) |
| source: one runner client for every identity | live (2) |
| source: the test query's key in `Authorization` | unit |
| source: a 4xx test query rejects | unit; live (2) |
| source: `watchFunctions` never follows the list | live |
| source: the variables' watcher never fires | live (2) |
| source: an import's add and delete swapped | unit; live |
| source: export times left in ns | unit |
| source: a run's `LOG` lines as debug | unit (2); live (2) |
| source: `getDeployment` ignores `cloudUrl` | live |
| source: a test query's value dropped | live (2) |
| screens: the tree ignores lines | dashboard |
| screens: the Functions screen not live | dashboard |
| screens: the variables reloaded over edits | dashboard |
| screens: no custom test query in the picker | dashboard |

**Measurements.** No hot path changes: the server adds system queries (read when the dashboard asks) and passes the
caller's member to an import. The dashboard's entry chunk grows by 193 bytes; the value editor's Monaco now loads as
`code-editor-monaco` (574 KB) plus `editor.api` (2.74 MB), 33 KB more than the one 3.28 MB chunk before (the
TypeScript language's registration). Monaco's TypeScript mode (674 KB) and worker (6.9 MB) load only when a
TypeScript editor opens (the custom test query), as Convex's. The source is not in the app's bundle until PR 6.

**Notes for PR 6.** Mount the runner's custom test query on the real source (the app's mock has no `runTestQuery`);
HTTP actions in the tree need a contract kind (`httpAction`) shared with the Logs screen; `watchEnvironmentVariables`
and `watchFunctions` are already wired in the screens.

### PR 6, as built

`apps/dashboard` on the real source. Convex's side re-read for it (`dc/`, `sh/` as above):

- **Signing in** (`sh/pages/_app.tsx:375-430`, `sh/lib/checkDeploymentInfo.ts`, `sh/lib/fetchCurrentDeployment.ts`): the
  form, the environment's prefill, the embedding parent and, in a build for the CLI's local dashboard,
  `GET /api/current_deployment` on the dashboard's own origin (`{name, url, adminKey}`; anything else, a 404
  included, falls back to the form, and nothing is shown while the answer is awaited, `:405-430`, `:483-490`).
- **The connection** (`dc/lib/deploymentContext.tsx:759-911`): the client's state polled every 2.5 s, `Disconnected`
  at two checks in a row, `Unknown` otherwise until it is up; only `Disconnected` shows the overlay
  (`dc/features/disconnectOverlay/DisconnectOverlay.tsx`: "Connection Issue", below the header, with a blur;
  `SelfHostedDisconnectOverlay.tsx`: "Check that your Convex server is running and accessible at <the URL signed in
  to>. If you continue to have issues, try restarting your Convex server."). While disconnected the HTTP polls pass
  SWR a null key (`dc/lib/deploymentApi.ts:54-57` for `/api/shapes2`, `dc/lib/appMetrics.ts:121,199,334,416,522,806`
  for every app metric); when the key comes back SWR asks at once. The socket's subscriptions resume by themselves.
- **The table list** is the subscribed table mapping (`dc/lib/useTableMetadata.tsx:26-40`): a table created or
  deleted anywhere shows in the sidebar without a reload.
- **HTTP actions** (`system-udfs/convex/_system/frontend/modules.ts:130-146` `processHttpRoute`;
  `dc/lib/functions/generateFileTree.ts:197-230`): each route is listed in `http.js` as a public function named
  `"<METHOD> <path>"`, `udfType: "HttpAction"`, with its line; that name is its identifier (in the URL, the logs'
  filter, the metrics, which add `udfType=HttpAction`). The summary labels it "HTTP" (`FunctionSummary.tsx:227`) and
  shows its URL (the site URL, the component's `httpPrefix`, the path; `useHttpActionRoute.ts:17-50`); there is no
  Run button (`:180-185`) and the runner offers queries, mutations and actions only (`SUPPORTED_FUNCTION_TYPES`,
  `FunctionTester.tsx:128`); its statistics are calls, errors and execution time (`PerformanceGraphs.tsx:180-220`).
  The Logs screen says "HTTP Action" (`LogMetadata.tsx:541`) and judges one by its status (`useLogs.ts:80`).
- **Health** (`dc/features/health/components/HealthView.tsx:76-145`): a Functions section (calls, failure rate, cache
  hit rate) and a Concurrency section — the scheduler's status (lag, 60 s), Running and Queued functions per kind
  (`useFunctionConcurrency`, `appMetrics.ts:801-915`, 8 s, kinds named by `mapFunctionTypeToDisplayName`, `:789-799`)
  and Subscription Cache Invalidations, top 3 (`SubscriptionInvalidations.tsx`, `appMetrics.ts:513-559`, 8 s); the
  issues summary (`ConcurrencyStatus.tsx:30-140`). A mutation's statistics add its invalidations, top 5, 8 s
  (`PerformanceGraphs.tsx:211-247`).
- **The paused lists** (`dc/lib/usePausedLiveData.ts`; `ScheduledFunctionsListHeader.tsx:42-84`,
  `FileStorageListHeader.tsx:94-135`): Pause / Go Live on both lists, Refresh while paused; on an auto-pause a
  warning, the toast "There are too many updates to show live. Updates have automatically been paused." and the
  toggle disabled for the visit; the pause kept per deployment in local storage (`pauseLiveScheduledJobs`,
  `pauseLiveFileStorage`).
- **The custom test query's types** (`dc/features/functionRunner/components/FunctionEditor.tsx:60-170`): Monaco gets
  the whole `convex/server` declaration set (`convexServerTypes`) and a `dataModel.d.ts` generated from the schema.

**What was built.**

- **The host** (`apps/dashboard/src/main.tsx`): sign-in checks the key with `createAdminKeyVerifier` (Convex's
  `check_admin_key`, 3 tries 500 ms apart, the 404 rule; the mock verifier is gone), then the screens run on
  `createServerDataSource({url, adminKey})`, closed at sign-out. `@bunvex/dashboard-source` (and the sync client
  under it) is its own chunk, fetched once signed in: the sign-in page and the demo do not load it. "Use the demo
  data" (and `?demo=1`, and the mock's knobs) keeps the mock. A build with `VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1`
  first asks `/api/current_deployment` (`login/current-deployment.ts`, Convex's shape and fallbacks; the server side
  is PR 7's). Requests carry `Authorization: Bunvex <key>` and `Bunvex-Client: dashboard-<version>` (PR 1).
- **The contract** (DV-479's rule; `data-source.ts`, UI-01 §34.5): `watchConnection` (moved from the server source's
  own surface into the contract, optional: a source without it is always connected), `watchTables` (optional),
  `FunctionKind` gains `httpAction` and `FunctionInfo` an optional `module` (an HTTP action's path is its route,
  `"GET /hello"`, in `http`). The suite checks an HTTP action's shape and that running one is `invalid_request`.
- **The connection** (`packages/dashboard/src/shell/connection.tsx`): the source's status in a context; while
  `disconnected`, "Connection issue" covers the screens below the header with Convex's self-hosted words (the URL
  the host signed in to, `<Dashboard deploymentUrl>`, else the deployment's own), and the polled HTTP reads (every
  app metric, the inferred types) are disabled; on the way back the polled reads are asked again at once and every
  query that failed meanwhile is fetched again (one-shot reads made over HTTP while away); the socket's
  subscriptions resume by themselves.
- **The table list** follows `watchTables` (`database/live.ts`): the Database screen lists the tables again on a
  change, and the empty-database screen opens the first table that appears. The source tells it from the table
  mapping it keeps subscribed (`tables.ts`), only when the user tables change; the mock when one is created or
  deleted.
- **HTTP actions** (`dashboard-source/src/functions.ts`, `logs.ts`, `metrics.ts`; the Functions, runner, Logs and
  palette screens; the mock): listed as above; the source refuses to run one (`invalid_request`, "… is an HTTP
  action: call it at its URL") before any permission check; the log stream's `HttpAction` is the `httpAction` kind
  (it was "action"), its route kept whole (`displayPath` would strip a `.js` from `GET /app.js`); the metrics add
  `udfType=HttpAction` for a route's name (before, the server read `"GET /hello"` as a `module:name` and failed).
  The tree shows "H", the page says "HTTP action in http" with its URL (the deployment's HTTP actions URL and the
  path) and no Run; its statistics are calls, errors and latency; the runner's picker leaves routes out (opened on
  one, it falls back to the first runnable function); the Logs screen letters it "H", titles it "HTTP action" and
  filters by it. The mock has two routes and some HTTP action executions in its log.
- **Health** (`metrics/health.tsx`): "Functions, last hour" (the three top charts) and "Concurrency, last hour" —
  the scheduler lag (60 s), Running functions and Queued functions per kind under Convex's names (8 s),
  Subscription invalidations top 3 as "mutation → table" (8 s) — with Convex's issues as a list under the heading
  (bunvex's sections do not collapse). A mutation's Statistics tab adds its invalidations, top 5, by table, 8 s.
- **The paused lists** (`shell/live-pause.tsx`; Schedules and Files): Pause / Go live, Refresh while paused, the
  auto-pause's warning and Convex's words, Go live disabled after an auto-pause for the visit; kept per deployment in
  local storage (`bunvex:<deployment>/pauseLiveScheduledJobs`, `…/pauseLiveFileStorage`). While paused, only what
  Convex keeps live refreshes (the crons; the file count and the open file); Go live subscribes again, which
  resumes the source (PR 5).
- **Per screen, the freshness is now Convex's on a deployment**: the Data screen's documents, sizes, the table list,
  the functions, the runner's query, the environment variables, the audit log, the schedules and files (with the
  auto-pause) live; Health's top functions, concurrency and invalidations every 8 s, the scheduler lag every 60 s,
  a function's charts once per window, the inferred types every 60 s; Logs over the long poll. The features only a
  deployment has light up by themselves (the screens test for the source's methods): the custom test query, Delete
  table, the live Functions list, the live environment variables, Health's concurrency and invalidations.

**Not built here** (gaps, each "Ainda não fizemos", none a divergence):

- The custom test query's type checking and completions: Convex ships the whole `convex/server` declaration set in
  its bundle and generates the data model from the schema; for bunvex that means shipping `@bunvex/server`'s
  declarations to the browser. Not cheap; left out.
- Convex's bulk edit (`patchDocumentsFields` without `ids`, PR 3's note) has no contract method yet.
- Search, vector and staged indexes in `IndexInfo`; `tableOfId` for system tables (PR 2's notes).
- Packaging (`bunvex dashboard serve`, the image, `dashboard.zip`, `/api/current_deployment`'s server): PR 7.

**Found on the way.**

1. *Fixed* (above): the source asked a route's metrics without `udfType`, which the server refused.
2. *Not fixed here* (`packages/server/src/functions.ts`, another change's file): an HTTP action's executions are
   logged under the request's path (`GET /files/abc`), where Convex logs the route that matched (`GET /files/*` for
   a prefix route; `router.ts` `lookup`, `crates/isolate/src/environment/action/mod.rs:474-500`,
   `application/src/function_log.rs:1149-1200`). Exact routes agree; a prefix route's Logs tab misses its lines.
   *Fixed since* (STUDY-31 §7, `fix/http-action-log-route`): the outcome, its event and its metrics by the route, as
   Convex's. Convex's own lines stay under the request (`GET /files/abc`), so on both a prefix route's Logs tab lists
   its outcome rows, and its lines show on the Logs screen under the request; `server-source-functions.test.ts`
   checks it live (`watchLogs({ function: "GET /files/*" })`).

**Divergences.** None new (DV-486 to DV-489 unused). The overlay's words name bunvex (rule 5); the key stays in memory
(DV-210); the contract's changes are DV-479's rule.

**Tests.**

- **The app in Chromium on a live deployment** (`packages/sync-e2e/dashboard/app.e2e.ts`, run by `bun run e2e` and CI's
  "e2e · dashboard in Chromium"): the built app, a bunvex server in the process and an HTTP and WebSocket proxy the
  test takes down. Sign-in (a wrong key refused; the key's requests carry `Bunvex <key>` and
  `Bunvex-Client: dashboard-x.y.z`; the header names the deployment; sign out, and a reload asks again); a read-only
  key; Data (the documents, an app's insert shown live, a cell edited and a document added reaching the server, a
  table a push creates appearing in the sidebar); Functions (the HTTP route listed with no Run) and the runner (a
  query subscribed and following the data, a mutation with typed arguments, the custom test query and its log line);
  Logs (a mutation's and an action's lines arriving live); Settings (a variable saved reaching the server, one set
  by the CLI's route appearing); the connection (down: "Connection issue" naming the URL, axe clean; a write while
  away; up: the overlay gone, the write shown, live again).
- **Screens** (`packages/dashboard/test`): `connection.test.tsx` (the overlay's states and words, the host URL and
  the fallback, the polls gated while away and asked at once on return, a failed read read again, the sidebar
  following `watchTables`, the empty database opening a new table); `functions.test.tsx`, `runner.test.tsx`,
  `logs-redesign.test.tsx` (HTTP actions); `metrics.test.tsx` (the Concurrency section, its issues, a mutation's
  invalidations); `schedules.test.tsx`, `files.test.tsx` (the auto-pause, a manual pause, a stored pause).
- **Source and live**: `functions-settings.test.ts`, `logs.test.ts`, `metrics-and-connection.test.ts` (routes, kinds,
  `udfType`); `server-source.test.ts` (`watchTables` hears a push's table, not a write); `server-source-functions.test.ts`
  (a real `GET /http/hello` reaches `watchLogs({function: "GET /hello"})` as `httpAction`, its rates and latencies,
  running it refused, and the contract's two new checks).
- `apps/dashboard`: `/api/current_deployment`'s parsing and fallbacks; the mock-only sign-in tests became a refusal
  by an address where nothing listens (the real verifier's three tries).

**Sabotage** (each restored after, `git diff` checked; counts are failing tests):

| Sabotage | Failing tests |
|---|---|
| the overlay never shown | screens 3 |
| the metrics not gated while disconnected | screens 1 |
| a read that failed while away not read again | screens 1 |
| the polled reads not asked again on return | screens 1 |
| the Database screen does not follow `watchTables` | screens 1 |
| the mock never tells the table list | screens 2 |
| the source's `watchTables` never told | live 1 |
| the app signed in, still on the mock | browser 7 |
| the host's URL not passed to the overlay | browser 1 |
| routes not listed (source) | unit 1, live 2 |
| a route's log kind left "action" | unit 1, live 1 |
| a route's metrics without `udfType` | unit 1, live 1 |
| the source runs routes | live contract 1, live 1 |
| the tree ignores `module` | screens 2 |
| the runner offers routes | screens 1 |
| letter "A" for an HTTP action | screens 1 |
| the mock runs routes | the mock's contract 1 |
| Run shown on a route | screens 1 |
| scheduler critical above 0 minutes, not 1 | screens 1 |
| the invalidations chart for every kind | screens 2 |
| a mutation's chart labelled "mutation → table" | screens 1 |
| the schedules list refreshed while paused | screens 2 |
| a source's pause not flagged | screens 2 |
| Go live does not subscribe again | screens 2 |
| the file count not refreshed while paused | screens 1 |
| the pause not stored | screens 3 |
| the source tells `watchTables` on every mapping result | none: the mapping has a new result only when the tables change, so the check is a guard |

**Measurements.** No hot path changes: the server is untouched; the source adds a comparison per table-mapping result
and one parameter on a route's metrics. The app's entry chunk grows by 2 795 bytes (861 gzipped: the connection
overlay, the live table list, the Health section, the pause controls, the host's source loader), and the verifier's
module is a 3 551-byte chunk loaded with it (it was 521 bytes inside the entry); `@bunvex/dashboard-source` with the
sync client is an 87 331-byte chunk (27 477 gzipped) fetched only after signing in to a deployment.

### PR 7, as built

Packaging. Convex's side re-read for it (`cli/` is `npm-packages/convex/src/cli/`, `ld/` is
`cli/lib/localDeployment/`):

- **The image** (`self-hosted/docker-build/Dockerfile.dashboard`): `dashboard-self-hosted` built with Next.js's
  `standalone` output on Ubuntu with Node, run as a non-root user by `node ./server.js` with `PORT=6791` and
  `HOSTNAME=0.0.0.0` (`:68-75`); published as `ghcr.io/get-convex/convex-dashboard` for amd64 and arm64
  (`.github/workflows/release_local_dashboard.yml`, `release_self_hosted_images.yml`). Its server reads
  `NEXT_PUBLIC_DEPLOYMENT_URL` (normalized, a trailing slash dropped) and `NEXT_PUBLIC_ADMIN_KEY` on each request
  and hands them to the sign-in form (`sh/pages/_app.tsx:150-182`); `NEXT_PUBLIC_LOAD_MONACO_INTERNALLY` and
  `NEXT_PUBLIC_HIDE_HEADER` are client-side, so fixed at build. It has no `/api/current_deployment` (no
  `pages/api`): the client's fetch gets a 404 and shows the form. The standalone server sends
  `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` unless built with `EMBEDDED_CORS_HEADERS`
  (`next.config.js:1-60`).
- **Compose** (`self-hosted/docker/docker-compose.yml:54-66`): the `dashboard` service, `${DASHBOARD_PORT:-6791}:6791`,
  `NEXT_PUBLIC_DEPLOYMENT_URL=${NEXT_PUBLIC_DEPLOYMENT_URL:-http://127.0.0.1:${PORT:-3210}}`, no key, after the
  backend is healthy; no healthcheck of its own.
- **`dashboard.zip`** (`.github/workflows/precompile.yml:65-83`): `build:export` (`output: "export"`, with
  `NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API=true` and the legacy list's port 6791), zipped from `out/` with the files
  at the root, uploaded to the `precompiled-*` release; `promote_local_backend.yml:36` requires it.
- **The local dashboard** (`ld/dashboard.ts:26-128`, from `cli/lib/dev.ts:88-122`): only for an anonymous
  deployment and a long-running `dev` (not `--once`, not `--until-success`). The version is
  `--local-backend-version`'s, else the latest release's (`ensureBackendBinaryDownloaded`, which crashes when the
  latest cannot be found); `ensureDashboardDownloaded` (`ld/download.ts:328-355`) keeps one copy in
  `~/.cache/convex/dashboard/out`, `dashboard/config.json` naming its version, and replaces it for another
  (`ld/filePaths.ts:305-372`); a failed download crashes `dev` ("File not found at <url>."). The port is the first
  free from 6790 (`choosePorts`), saved per deployment as `dashboard.json` next to its `config.json`
  (`:380-418`). The server (`ld/serve.ts:17-73`) listens on 127.0.0.1 only, with no CORS headers (`cors: false`),
  answers `/api/current_deployment` with `{ name, url, adminKey }` to any request (`ld/dashboard.ts:66-77`), and
  serves the export with `serve-handler` otherwise; the first other request reports a telemetry event.
- **`npx convex dashboard`** (`cli/dashboard.ts:24-84`): self-hosted → the "not supported" message; anonymous → the
  saved port's `http://127.0.0.1:<port>/`, after `GET /api/current_deployment` answered 200 with this
  deployment's `name` (the port may since be another session's), else "You are not currently running the
  dashboard locally…"; `--no-open` prints the URL on stdout, otherwise "Opening <url> in the default browser..."
  and, when that fails, "⚠️ Could not open dashboard in the default browser.\nPlease visit: <url>". `dev` prints no
  dashboard link of its own (the links are PR 8's).

**What was built.**

- **The server** (`packages/cli/src/dashboard-server.ts`): the built app served by `Bun.serve` — each file of the
  build (hashed `/assets/` cached for good, the rest `no-cache`), index.html for any other page the browser opens
  (`Accept: text/html`; the app routes on the history, where Convex's export has one HTML file per page), a 404 for
  a missing script, nothing outside the build (the decoded path is resolved and must stay under it), GET and HEAD
  only. index.html carries the prefill as `<meta name="bunvex-deployment-url">` / `<meta name="bunvex-admin-key">`
  (normalized and escaped; nothing written for an unset value). `/api/current_deployment` answers Convex's
  `{ name, url, adminKey }` (`Cache-Control: no-store`, no CORS) when the server was started for a deployment,
  listens on a loopback address, and the request's `Host` is `127.0.0.1:<port>` or `localhost:<port>`; another
  `Host` is a 403 (DV-476); without a deployment, a 404 as Convex's image.
- **The app** (`apps/dashboard/src/login/prefill.ts`): the sign-in page's prefill is the serving server's `<meta>`
  tags, else the build's `VITE_BUNVEX_DEPLOYMENT_URL` / `VITE_BUNVEX_ADMIN_KEY` — so one static build serves any
  deployment, as Convex's image reads its environment at request time. Monaco is bundled in the app (as Convex's
  `NEXT_PUBLIC_LOAD_MONACO_INTERNALLY=true`), so the image needs no CDN.
- **`bunvex dashboard serve`** (`dashboard-serve.ts`; Convex's CLI has no such command): `--dir` (else the
  release's `dashboard.zip`, downloaded and cached as `dev` does; `--version`), `--port` (6790), `--hostname`
  (127.0.0.1), `--deployment-url` / `--admin-key` (else `BUNVEX_DEPLOYMENT_URL` / `BUNVEX_ADMIN_KEY`); in a project
  whose deployment is local, on a loopback address, it hands that deployment out at `/api/current_deployment`.
  SIGINT / SIGTERM stop it. `packages/cli/bin/bunvex-dashboard.ts` is the command alone, which the image compiles.
- **The image** (`docker/dashboard.Dockerfile`, DV-475): built on `oven/bun:1.4.2-slim` (the app's Vite build and
  `bun build --compile` of `bunvex-dashboard`), run on `gcr.io/distroless/cc-debian12:nonroot` (a non-root user,
  as Convex's), `--hostname 0.0.0.0 --port 6791`, `EXPOSE 6791`, `STOPSIGNAL SIGINT`. The compose file's
  `dashboard` service (DV-189 closed): Convex's ports, stop signal, `depends_on` and no key, with
  `BUNVEX_DEPLOYMENT_URL=${BUNVEX_DEPLOYMENT_URL:-http://127.0.0.1:${PORT:-3210}}`; built from the repository
  until a published image exists (`BUNVEX_DASHBOARD_IMAGE`, as the backend's `BUNVEX_IMAGE`). `docker.yml`
  smoke-tests it (`docker/smoke-dashboard.sh`) and publishes it beside the backend's as
  `ghcr.io/bunvex/bunvex-dashboard` (both behind `PUBLISH_IMAGE`, off). `docker/smoke.sh` now brings up the
  backend alone.
- **`dashboard.zip`** (`scripts/build-dashboard.ts`, DV-194 closed): the app built with
  `VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1` (and `NODE_ENV=production`), zipped with its files at the root, into
  `dist/bin/` where `release-binaries.yml` picks every zip up; `promote-binaries.yml` requires it.
- **The local dashboard** (`local-dashboard.ts`, from `dev.ts`; DV-202 closed): Convex's flow for a local deployment
  (bunvex's local deployments are Convex's anonymous ones, DV-199): only with a long-running `dev`; the version
  `--local-backend-version`'s, else the latest release's; `~/.cache/bunvex/dashboard/{config.json,out/}`, unzipped
  into a temporary directory and renamed into place (an entry outside it fails the whole archive); the first free
  port from 6790 (the deployment's two ports avoided), saved as `.bunvex/local/default/dashboard.json`
  (`{ port }`); stopped with `dev`. Where Convex's `dev` crashes, a version that cannot be resolved or downloaded
  (offline, the release service failing, no `dashboard.zip` in the release) is a warning (DV-486): the dashboard
  already in the cache is served (a failed download leaves the cache as it was), or, with none, `dev` runs without
  a dashboard and `dashboard.json` holds `{ unavailable: <why> }` until `dev` stops. A dashboard that cannot be
  served (no free port) still stops `dev`, as Convex's.
- **`bunvex dashboard`** (`dashboard.ts`): for a local deployment, Convex's behaviour above, with `--no-open`, the
  opening line and the headless warning; while `dev` runs without the dashboard, "`bunvex dev` is running without
  the local dashboard: it could not be downloaded (<why>). Restart `bunvex dev` once it can be." (DV-486).
  `bunvex dashboard serve` is its subcommand (its usage lists it; AD-40).

**Not built here** (gaps, "Ainda não fizemos", none a divergence; the frame and security headers, first listed
here, are built in the follow-up below):

- Convex's telemetry event on the first request (`self_host_dashboard_connected`): bunvex reports nothing.
- `NEXT_PUBLIC_DEFAULT_LIST_DEPLOYMENTS_API_PORT` and the legacy deployment list (`?a=<port>&d=<name>`): kept by
  Convex for old CLIs, not built (CLAUDE.md: nothing kept only for older clients).
- `NEXT_PUBLIC_HIDE_HEADER`: a build-time switch for Convex's embedding; bunvex's host has no such switch.
- The CLI's dashboard links (DV-477) are PR 8's; `dev` prints no dashboard line, as Convex's. (*Corrected by PR 8*:
  Convex's `dev` does print one, "View the Convex dashboard at …", when it writes `.env.local`.)

**Found on the way.**

1. *Decided (DV-486)*: Convex's `dev` crashes when the local dashboard cannot be had, even when the backend runs
   from an already-downloaded version because the latest could not be found (offline). Matching it would have
   stopped an offline `bunvex dev`, which ran before this PR; the owner chose a warning instead.
2. *Test pitfall*: `bun test` sets `NODE_ENV=test`, and a Vite build started from a test inherits it and makes a
   development build (React's StrictMode then runs effects twice: two `/api/current_deployment` requests). The
   browser test and `build-dashboard.ts` set `NODE_ENV=production`.
3. *Fixed after PR 7* (`fix/local-dashboard-port-race`): the first free port from 6790 was probed, then bound; a
   process binding it in between (two `bunvex dev` starting at once, parallel tests: the full suite once failed
   with "Failed to start server. Is port 6790 in use?") stopped `dev`. Convex has the same gap: `choosePorts`
   probes with `detect-port` (`ld/utils.ts:6-51`), then `startServer`'s `listen` only logs the `EADDRINUSE` and its
   promise never resolves (`ld/serve.ts:64-71`), so its `dev` hangs before the first push. bunvex now binds and, on
   `EADDRINUSE` only, moves to the next free port (up to 20 times; `serveOnFirstFreePort`, `local-dashboard.ts`),
   so both get a dashboard, each port saved for its own project. Not a divergence: where Convex's `dev` works,
   both pick the same port; they differ only where Convex's hangs. The backend's own ports (`choosePort` for
   3210/3211, bound by the executable) keep the probe-then-bind gap, as Convex's. Tests (`dashboard-serve.test.ts`):
   two servers started together from one base serve on two ports; a port taken between the probe and the bind
   gives the next one, and another start error is not retried; two `startLocalDashboard` together save their own
   ports. Sabotage: no retry (3 tests fail), a retry on any error (1), retrying the same port (3), `dev`'s dashboard
   not using the retry (1).

**Divergences and additions.** One new divergence, DV-486 (owner, 2026-10-14: warn and keep going; above);
DV-487 and DV-489 unused (DV-488 is the follow-up's, below). One addition, AD-40, `bunvex dashboard serve` (owner, 2026-10-14; planned in §3.3). DV-475 and DV-476 are built as decided; DV-475's row now names the
image's variables (`BUNVEX_DEPLOYMENT_URL` / `BUNVEX_ADMIN_KEY` for Convex's `NEXT_PUBLIC_*`, which name a Next.js
mechanism a static app does not have; the naming of the plan's §3.3, which the owner approved). DV-476's check also requires the server's own port and a loopback listening
address (on any other address `/api/current_deployment` is never offered: a LAN client could send any `Host`).
DV-189, DV-194 and DV-202 are closed (resolved to match Convex).

**Tests.**

- **The server and the CLI** (`packages/cli/test/dashboard-serve.test.ts`): the app's files, index.html for a page,
  a missing asset a 404, three spellings of a path out of the build refused, POST a 405, no current deployment a
  404; the prefill from the environment and from the flags, escaped, absent when unset or not a URL; argument and
  start errors (a directory with no index.html, a port in use); `/api/current_deployment` for a local project to
  `127.0.0.1:<port>`, `localhost:<port>` and `LOCALHOST:<port>`, refused (403, no key in the body) for a rebound
  name, another port, no port, a name ending in `.evil.example`; never on `0.0.0.0`; never for a self-hosted
  project; `dashboard.zip` downloaded from a release server once per version, cached, replaced for a newer latest,
  `--version`, a missing release's "File not found at …"; an archive entry outside the directory fails; `bunvex dev`
  on a local deployment (the backend a shim of the real executable) serves the release's app from 6790, saves the
  port, hands out the deployment's real key (checked against `check_admin_key`), refuses a foreign `Host`;
  `bunvex dashboard --no-open` prints the URL, without `--no-open` opens it, a failing browser gets Convex's
  warning, another deployment's name and a stopped `dev` get Convex's warning; `--once` serves none. DV-486:
  offline (nothing listening at the release URL) with a dashboard in the cache, it is served with the warnings and
  `bunvex dashboard` opens it; offline with none, `dev` pushes and runs without one, `bunvex dashboard` says why and,
  once `dev` stops, gives Convex's warning; the latest version not resolved (a 500) and a release without
  `dashboard.zip` (the cached one served, the cache left as it was).
- **The app** (`apps/dashboard/test/prefill.test.ts`): the server's `<meta>` tags over the build's values; unset ones.
- **In Chromium** (`packages/sync-e2e/dashboard/local-dashboard.e2e.ts`, in `bun run e2e`): the app built as
  `dashboard.zip` is, served by the real `bunvex dashboard serve` in a project whose local deployment is a live
  bunvex server: at `127.0.0.1` and at `localhost` it signs in by itself (the Overview, "Signed in: <name>", one 200
  from `/api/current_deployment`); at a name the browser resolves to 127.0.0.1 (`--host-resolver-rules`, a DNS
  rebinding page) the route answers 403, the sign-in page is shown, and the page's own script cannot read the key.
- **The image** (`docker/smoke-dashboard.sh`, CI's "dashboard image smoke test"): compose up of the backend and the
  dashboard image; the page has the root element and the backend's URL in its `<meta>`; an app page served, a
  missing asset a 404, `/api/current_deployment` a 404; then, in Chromium (`apps/dashboard/e2e/sign-in-smoke.ts`),
  the sign-in form prefilled with the backend's URL, the key from `generate_admin_key.sh` pasted, the Data screen
  of a table a function wrote showing its document. `docker/smoke.sh` (the backend) passes unchanged.

**Sabotage** (each restored after, checked; counts are failing tests):

| Sabotage | Failing tests |
|---|---|
| the `Host` check removed | CLI 2, Chromium 1 |
| any port, or no port, accepted in `Host` | CLI 1 |
| `/api/current_deployment` offered on a non-loopback address | CLI 1 |
| the path guard removed | CLI 1 |
| no index.html for the app's pages | CLI 1 |
| index.html for every missing path | CLI 2 |
| no prefill written | CLI 1; the image smoke ("the backend's URL is not filled in") |
| the prefill not escaped | CLI 1 |
| the app ignores the server's prefill | app 1; the image smoke ("the deployment URL is "", not http://127.0.0.1:13220") |
| the app never asks `/api/current_deployment` | Chromium 3 |
| `dev` serves no dashboard | CLI 1 |
| `dev --once` serves one too | CLI 1 |
| `dashboard.zip` never cached | CLI 1 |
| the cache ignores the version | CLI 1 |
| the archive's path guard removed | CLI 1 |
| `bunvex dashboard` opens without checking the deployment's name | CLI 1 |
| the dashboard's port not saved | CLI 1 |
| DV-486: `dev` stops when the dashboard cannot be had (Convex's) | CLI 3 |
| DV-486: the cached dashboard never used | CLI 2 |
| DV-486: no `unavailable` note saved | CLI 2 |
| DV-486: the note left after `dev` stops | CLI 1 |
| DV-486: `bunvex dashboard` ignores the note | CLI 1 |
| DV-486: a failed download empties the cache | CLI 1 |

**Owner decisions (2026-10-14)** on the questions this PR raised: offline `dev` diverges (DV-486, built here);
`bunvex dashboard serve` is an addition (AD-40); the image's frame and security headers match Convex in a follow-up
PR (built: "PR 7 follow-up" below, DV-488).

**Measurements.** No hot path changes (the backend is untouched). The dashboard image is 131.6 MB (arm64, built
locally; the backend's is 198.0 MB); `dashboard.zip` is 4.07 MB (145 files, 16.0 MB unpacked). The app's entry
chunk grows by 306 bytes (80 gzipped: the prefill reader). The image builds in about 24 s from a warm cache; the
image smoke runs in about 35 s locally.

### PR 7 follow-up: the frame and security headers, as built

The owner's decision on PR 7 (2026-10-14): "match Convex in a follow-up, with the embedding allow-list, DV-319, in
`frame-ancestors`". Convex's side re-read for it (`sh/` is `npm-packages/dashboard-self-hosted/`, commit
`4577b9031`):

- **The image's headers** (`sh/next.config.js:1-65`): `headers()` returns one rule, `source: "/:path*"` (every
  path: pages, `/_next/static` files, 404s), with `securityHeaders` (`:5-22`): `X-DNS-Prefetch-Control: on`,
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-XSS-Protection: 1; mode=block`,
  `Referrer-Policy: origin-when-cross-origin`; then, unless `EMBEDDED_CORS_HEADERS` is set (`:40-60`),
  `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` (`:1-3`, whitespace
  collapsed). No `X-Content-Type-Options`, no other CSP directive. HSTS is sent whatever the scheme; browsers ignore
  it over plain HTTP (RFC 6797 §8.1), so it binds only behind an HTTPS proxy.
- **The embedding mode**: with `EMBEDDED_CORS_HEADERS` set, the two frame headers are replaced by
  `Cross-Origin-Resource-Policy: cross-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`:41-50`): any
  page may frame the dashboard, and a cross-origin-isolated parent may load it. It is a build-time switch:
  `headers()` is evaluated by `next build` into the standalone server's routes manifest, and `turbo.json:7` lists
  it among the build's inputs; `Dockerfile.dashboard` does not set it, so the published image frames same-origin
  only. `NEXT_PUBLIC_HIDE_HEADER` goes with it (a build-time UI switch; not built, PR 7's gap list).
- **The local dashboard** (6790): `build:export` (`sh/package.json:9`) sets `BUILD_TYPE=export`, which takes
  `optionsForExport` (`next.config.js:24-29,74`): a static export, where Next.js applies no `headers()`. The CLI
  serves it with `serve-handler` and no header options (`ld/dashboard.ts:87-89`), on a server that adds headers only
  for `cors: true` (`ld/serve.ts:33-38`; the dashboard passes `cors: false`, `:55`). So the local dashboard sends
  none of these headers.

**What was built.**

- **The server** (`packages/cli/src/dashboard-server.ts`): with `securityHeaders` on, every response (each file,
  index.html for a page, a 404, a 405, `/api/current_deployment`'s 200 and 403, HEAD as GET) carries Convex's four
  common headers and, by default, `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors
  'self'`. When the build allows embedding parents (DV-319's `<meta name="bunvex-embed-origins">` in index.html,
  read at start with the app's own rules: origins separated by commas or spaces, reduced to scheme, host and port,
  anything not an http(s) URL dropped, `*` included), it sends Convex's embedding headers instead: no
  `X-Frame-Options` (it cannot name an origin: `ALLOW-FROM` is obsolete), `Cross-Origin-Resource-Policy:
  cross-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `Content-Security-Policy: frame-ancestors 'self'
  <origins>` where Convex sends no CSP (DV-488). The answers' own headers (`Cache-Control`, `Allow`) are kept.
- **`bunvex dashboard serve`** (`dashboard-serve.ts`) turns them on: it is the image's server. The local dashboard
  `bunvex dev` serves (`local-dashboard.ts`, not changed) leaves them off, as Convex's.
- **HSTS**: sent as Convex sends it, over plain HTTP too. Browsers ignore it there, so the image on
  `http://127.0.0.1:6791` and `bunvex dashboard serve` on `http://127.0.0.1:6790` are unaffected; the local
  dashboard sends none. Behind an HTTPS proxy it binds the proxy's host and its subdomains for two years, as
  Convex's image does.
- **One switch, the list**: Convex has two build-time switches (`EMBEDDED_CORS_HEADERS` for the headers, and the
  app accepting credentials from any parent); bunvex has DV-319's list for both, so the frame policy and the app's
  check of the parent never disagree, and an empty list is same-origin framing. Like Convex's switch, it is fixed
  at build: `VITE_BUNVEX_EMBED_ORIGINS` (a `--build-arg` of `docker/dashboard.Dockerfile`, which now declares it),
  or the tag edited in a built `index.html` before the server starts. No runtime variable is added.

**Divergence.** DV-488 (owner, 2026-10-14, the decision above): in the embedding mode `frame-ancestors` lists
`'self'` and the allowed parents, where Convex's embedding build lets any page frame it; and the mode follows
DV-319's list rather than a separate switch. In a browser, `frame-ancestors` overrides `X-Frame-Options` (CSP
Level 3), so dropping `X-Frame-Options` changes nothing for the listed parents in current browsers; it matters for
ones that only know `X-Frame-Options`, which would otherwise refuse every parent.

**Tests.**

- **The server and the CLI** (`packages/cli/test/dashboard-serve.test.ts`, "frame and security headers"): ten
  answers of `bunvex dashboard serve` in a local project (index.html, HEAD, a hashed asset, another file, an app
  page, a missing asset, a path out of the build, a POST, `/api/current_deployment` 200 and 403) each carry exactly
  Convex's six headers, and keep their own; a build listing parents (with a path, a duplicate, `*`, `ftp:` and a
  non-URL in the list) gets the embedding set on all ten, with `frame-ancestors 'self' https://admin.example.com
  http://localhost:3000`, and still carries the tag; the list's parsing (an empty tag, only junk, commas and
  spaces, upper case, duplicates, the first tag only, attributes in either order); the local dashboard's server
  sends none on all ten, and `bunvex dev`'s local dashboard none.
- **In Chromium** (`packages/sync-e2e/dashboard/local-dashboard.e2e.ts`): the local-project dashboard still signs
  in by itself at 127.0.0.1 and localhost, its page carrying `X-Frame-Options`, `frame-ancestors 'self'` and HSTS;
  a page at another origin framing it is refused (the frame's document fails `ERR_BLOCKED_BY_RESPONSE`, the console
  names `frame-ancestors 'self'`, none of the app's scripts is fetched); the same build with
  `http://localhost:<port>` in its tag, framed by a page there, loads and signs in from the parent's
  `dashboard-credentials` answer (the Overview, "Signed in: <name>", no page error; with COEP `require-corp`), while
  the same parent page at `127.0.0.1` is refused by `frame-ancestors 'self' http://localhost:<port>`.
- **The image** (`docker/smoke-dashboard.sh`): the page and a missing asset carry the six headers; the Chromium
  sign-in runs as before.

**Sabotage** (each restored after, checked with `git diff`; counts are failing tests):

| Sabotage | Failing tests |
|---|---|
| no `X-Frame-Options` by default | CLI 2 |
| `X-Frame-Options` kept with embedding parents | CLI 1 (Chromium 0: `frame-ancestors` overrides it) |
| the parents not in `frame-ancestors` | CLI 1 |
| `frame-ancestors *` with embedding parents (Convex's any-parent) | Chromium 1 |
| the headers on `/` only | CLI 2 |
| no HSTS | CLI 3 |
| the local dashboard sends them too | CLI 2 |
| `dashboard serve` does not turn them on | CLI 2; the image smoke ("the page lacks Convex's frame and security headers") |
| the list's entries not limited to http(s) | CLI 2 |

**Measurements.** No hot path changes (the backend is untouched); the dashboard server sets six headers on each
response from a list built once at start.

### PR 8, as built
The CLI's dashboard links (DV-477) and the user documentation. Convex's side re-read for it (`cli/` is
`npm-packages/convex/src/cli/`):
- **Where Convex's CLI links its dashboard.** Every link goes through `cli/lib/dashboard.ts`:
  `deploymentDashboardUrlPage(name, page)` is `https://dashboard.convex.dev/d/<name><page>`, or the bare host plus
  `<page>` when there is no deployment name (`:42-50`, with the FIXME "this doesn't work correctly in
  local-dev/self-hosted", `:40-41`); `getDashboardUrl` gives an anonymous (local) deployment its local dashboard,
  `http://127.0.0.1:<the port saved in dashboard.json>/`, or `null` with none saved (`:9-37`,
  `lib/localDeployment/dashboard.ts:130-137`). The call sites:
  - `dev`'s opening lines: `announceDeploymentTarget` adds "(dashboard)" only for a cloud or cloud-linked `local`
    deployment, never for an anonymous one or a self-hosted one (`lib/announceDeploymentTarget.ts:107-137,200-214`);
    but `finalizeConfiguration`, when the configuration changed (`.env.local` or `.gitignore` written), ends with
    "View the Convex dashboard at <getDashboardUrl>" (`lib/init.ts:59-72`). For an anonymous deployment that runs
    before `handleDashboard` (`lib/dev.ts:88-122`), so it reads the port the *previous* session saved: `null` on a
    first run, a stale port otherwise. So PR 7's note ("`dev` prints no dashboard line, as Convex's") was wrong.
  - `export`: "Export is available at …/settings/snapshots" after the export is created, and "Check its progress
    at …" after the export-in-progress refusal (`convexExport.ts:47-50`; `lib/convexExport.ts:60-64,181-186`).
  - `import`: "There is already a snapshot import in progress. You can view its progress at ….", and
    "WARNING: Import is continuing to run on the server. Visit … to monitor its progress." when its subscription
    ends early (`convexImport.ts:55-60`; `lib/convexImport.ts:198-206,248-254`).
  - a push: each staged index gets "See progress: …/data?table=<t>&showIndexes=true" (`lib/components.ts:723-732`,
    dry runs too); waiting on the schema, three lines — backfill and check, backfill only, check only — and past
    10 s "see progress here" to the first new index's table or, for the check, "See progress here:
    …/schema?showSchema=true" (`lib/deploy2.ts:240-307`, `lib/indexes.ts:34-46`); an auth config's missing
    variable sends to "…/settings/environment-variables?var=<name>", or, with no deployment name, "Go set it in the
    dashboard or using `npx convex env set`" (`lib/config.ts:966-985`).
  - the MCP `status` tool's `dashboardUrl`, when there is a deployment name (`lib/mcp/tools/status.ts:89-95,128`).
  - cloud only, not applicable: login, `project create`, `configure`, preview deploy keys (`deploy.ts:200-203`),
    usage warnings, the region tip, insights, WorkOS; `convex dashboard` itself (PR 7).
  - nothing in `logs`, `env`, `data`, `run` or function errors.
- **Self-hosted.** Convex's CLI has no setting for where a self-hosted dashboard is (`CONVEX_SELF_HOSTED_URL` and
  `CONVEX_SELF_HOSTED_ADMIN_KEY` name the backend only): a self-hosted export prints
  `https://dashboard.convex.dev/settings/snapshots`, the auth-config hint has no link, and `convex dashboard`
  refuses.
- **The pages** in Convex's dashboard: `?var=` fills the add form with the named variables
  (`dashboard-common/…/DeploymentEnvironmentVariables.tsx:231-250`); `showSchema` opens the schema panel
  (`SchemaView.tsx:87-95`); `showIndexes` the indexes panel.
**What was built** (DV-477 as decided: the local dashboard while `bunvex dev` serves it, else no link).
- **The links** (`packages/cli/src/dashboard-links.ts`): a command's link is resolved once, at the first message
  that needs it — never for a deployment given by `--url` or `BUNVEX_SELF_HOSTED_*`; for a local deployment, the
  port in `dashboard.json`, once its `/api/current_deployment` names this deployment (the check `bunvex dashboard`
  makes, so a stopped `dev` or another session's port links nothing). `dev` passes its own dashboard to its pushes.
  Convex's pages map to bunvex's routes: `settings/snapshots` (the same), `database/<table>?panel=indexes`
  (`data?table=<table>&showIndexes=true`), `schema` (`schema?showSchema=true`), `settings/environment-variables`
  (without `?var=`, which bunvex's screen does not read: a gap).
- **`dev`** (`dev.ts`, `local-deployment.ts`): `writeEnvLocal` says whether `.env.local` or `.gitignore` changed;
  then, once the local dashboard serves, "View the bunvex dashboard at http://127.0.0.1:<port>/" — the URL it is
  serving, not the previous session's; none without a dashboard (`--once`, DV-486's offline case, self-hosted).
- **export, import** (`export.ts`, `import.ts`): Convex's lines with the Snapshots link appended, or without it.
- **a push** (`deploy.ts`, `index-checks.ts`): "See progress:" under each staged index; Convex's three waiting
  lines (bunvex printed the first one for all three) with their links past 10 s; the auth config's variable,
  Convex's "Go to: … to set it up." with the link, its no-link words without one.
- **MCP `status`** (`mcp-tools.ts`): `dashboardUrl` for a local deployment while its dashboard serves.
- **Docs**: `docs/dashboard.md`, the user documentation — running it (`bunvex dev` / `bunvex dashboard`, the image
  and compose, `bunvex dashboard serve`), signing in, the settings (`BUNVEX_DEPLOYMENT_URL`, `BUNVEX_ADMIN_KEY`,
  6790 and 6791, the `Host` check), the offline behaviour (DV-486), the links, what is live and what is polled, the
  known gaps; linked from the README, the docker README, the CLI's README, `apps/dashboard`'s README and
  ARCHITECTURE.md. The docker README already covered the dashboard service (PR 7).
**Not built here** (gaps, "Ainda não fizemos", none a divergence):
- `?var=` on the environment variables screen (Convex prefills the add form with the variable its CLI names).
- The rest of Convex's `finalizeConfiguration` block ("Write your Convex functions in …", the feedback line) and its
  condition for the configuration lines: bunvex prints its "Started running a deployment locally …" line on every
  start (STUDY-40's), and only the dashboard line follows Convex's condition.
- Import's "WARNING: Import is continuing to run on the server": bunvex follows the import by polling, which never
  stops early, so the case does not arise.
**Divergences.** None new: DV-477 is built as decided, its row now listing every link; DV-487 to DV-489 unused; no
addition (AD-41 unused). Printing the URL the dashboard is serving where Convex prints the previous session's port
(or `null`) is DV-477's "the local dashboard bunvex serves".
- `packages/cli/test/dashboard-links.test.ts`: which dashboard a command links (the local one serving this
  deployment, asked once; none with nothing saved, a stopped `dev`, another deployment's dashboard; never, and
  nothing asked, for a self-hosted deployment or `--url`); a staged index's link and none without a dashboard; the
  three waiting lines with and without their links; `bunvex deploy` to a local deployment linking the staged index
  and the auth config's variable, and Convex's no-link words on the same deployment as self-hosted; export's and
  import's in-progress links (a deployment that answers as busy); a completed export's link, none on self-hosted.
- `dashboard-serve.test.ts`: `bunvex dev` with the real local dashboard prints "View the bunvex dashboard at" its
  URL, and `bunvex export` from another terminal links its Snapshots page; once `dev` stops, no link; offline
  with no dashboard (DV-486), no line.
- `mcp.test.ts`: `status` has no `dashboardUrl` without a local dashboard, and the local one's with it.
- In Chromium (`local-dashboard.e2e.ts`): each page the CLI links (`settings/snapshots`,
  `settings/environment-variables`, `schema`, `database/notes?panel=indexes`) opens on its screen after the local
  dashboard signs in by itself.
**Sabotage** (each restored after, `git diff` checked; counts are failing tests):
| the link not checked against `/api/current_deployment` | 1 |
| a self-hosted deployment linked | 1 |
| no "See progress" under a staged index | 2 |
| no link past 10 s on the schema check | 1 |
| one waiting line for every state (bunvex's before) | 1 |
| export's "Export is available at" dropped | 1 |
| export's "Check its progress at" dropped | 1 |
| import's link dropped | 1 |
| the auth config's link dropped | 1 |
| the environment variables page wrong | 1 |
| MCP `dashboardUrl` dropped | 1 |
| `dev`'s line never printed | 1 |
| `dev`'s line printed without a dashboard | 1 |
| `dev` gives its pushes no link (the line follows the same link) | 1 |
**Measurements.** No hot path: CLI messages only. A command asks the local dashboard at most once (one loopback
request, 2 s timeout), only when a message needs the link and a port is saved; a self-hosted deployment asks
nothing.
### Follow-up: the dashboard from its own origin (2026-10-14)

On every real install the dashboard and its deployment are two origins, and `getDeployment` read `/version` (outside
Convex's CORS layer) and `/stats` (outside bunvex's), so the header showed "Deployment unavailable". It now reads
`/instance_version`, and `/stats` is behind the layer; the Overview's calls indicator asks Convex's largest top-k (25,
not 50). Studied, tested against Convex's binary and in Chromium with the dashboard on `bunvex dashboard serve` and
the server on another port (`cross-origin.e2e.ts`): [STUDY-67 §9](STUDY-67-http-function-api.md#9-the-dashboards-routes-from-another-origin-2026-10-14).
No new divergence.

## 6. Open questions

Every question below is in the decision format the owner asked for (what Convex does / what bunvex would do /
same or not / why / app impact / recommendation), followed by the owner's decision (2026-10-12).

### Q1 — A separate service, or served by the backend? (DV-475, AD-32)

- *Convex*: a separate app. Docker runs `ghcr.io/get-convex/convex-dashboard` (Next.js) on 6791; the CLI serves
  `dashboard.zip` on 6790 for a local deployment; the backend never serves the dashboard.
- *bunvex (proposed)*: also separate — a static Vite build served by `bunvex dashboard serve`, on the same
  ports. For docker, option **A**: the same `bunvex` image with the `dashboard serve` command; option **B**: a
  second image `ghcr.io/bunvex/bunvex-dashboard`. Separately, option **C** (AD-32): the backend can also serve
  it same-origin at `/dashboard`.
- *Same?* The topology is the same; the image name (A) or the server under it is not.
- *Why*: "Ainda não fizemos" for all three; nothing stops matching exactly except that bunvex's dashboard is
  not Next.js (D1).
- *App impact*: none; operators see one more compose service, as with Convex.
- *Recommendation*: a separate service (match Convex), docker option **A** (one image to build, sign and pull;
  the image name is the only difference), and **no** C for now — serving it from the backend makes the admin
  UI reachable wherever the API is, which Convex avoids.
- **Decision (owner, 2026-10-12): option B** — a separate service with its **own** image, as Convex (a second
  image on 6791; the local dashboard on 6790). Not A, and no C: AD-32 is not taken. The topology and the image
  split now match Convex; DV-475 records only what is inside the image (a static Vite build served by Bun, not
  a Next.js server).

### Q2 — Port Convex's dashboard UI, or keep bunvex's and match the data behaviour?

- *Convex*: its own Next.js dashboard, FSL-1.1-Apache-2.0.
- *bunvex*: keeps its own screens (STUDY-12 **D1, already decided**) and matches what they read and how fresh
  it is (§3.3).
- *Same?* The screens differ (decided); the data and its freshness would match.
- *Why*: "Não dá pra fazer" as a straight port — the licence and the Next.js / cloud coupling (D1), and rule 5
  plus DV-97 mean Convex's dashboard could not talk to bunvex unchanged anyway (`Convex <key>` is a 400).
- *App impact*: none.
- *Recommendation*: confirm D1 and close STUDY-12 §6.2: the admin API mirrors Convex's function paths and shapes
  (for the oracle tests), **not** so Convex's dashboard can run against bunvex.
- **Decision (owner, 2026-10-12): confirmed** as planned (D1 kept; STUDY-12 §6.2 closed this way).

### Q3 — Rule 5 and the dashboard's function names (DV-474)

- *Convex*: the dashboard calls `_system/frontend/convexCloudUrl` and `convexSiteUrl`, sends
  `Authorization: Convex <key>`, `Convex-Client: dashboard-0.0.0`, and `format: "convex_encoded_json"` to
  `run_test_function`.
- *bunvex*: `Bunvex <key>` (DV-97), `Bunvex-Client: dashboard-<version>`, `encoded_json` (DV-307) are already
  bunvex's; the two functions would be `_system/frontend/cloudUrl` and `siteUrl` (as
  `_system/cli/deploymentUrl:cloudUrl` already is). Every other path (`paginatedTableDocuments`, …) keeps
  Convex's name.
- *Same?* No, two function paths differ.
- *Why*: "Não dá pra fazer" — rule 5 has no exceptions for wire names (DV-307/308/312, the 2026-10-03 exception
  revoked).
- *App impact*: none (only the dashboard calls them); a script calling `_system/frontend/convexCloudUrl` gets
  "Could not find function".
- *Recommendation*: rename them as proposed.
- **Decision (owner, 2026-10-12): rename** to `cloudUrl` and `siteUrl` (DV-474).

### Q4 — The admin key in the browser (DV-476)

- *Convex*: the operator pastes the key into the dashboard (another origin); it goes over the WebSocket and in
  an `Authorization` header (in the body for `run_test_function`); the backend's CORS mirrors any origin. The
  local dashboard's Node server hands `{name, url, adminKey}` to any `GET /api/current_deployment` on
  127.0.0.1, without checking `Host`; the iframe handshake accepts any parent (bunvex already restricts it,
  DV-319).
- *bunvex*: the same model — key in memory only (DV-210), CORS as Convex (`cors.ts`), no key in the docker
  service. One hardening: the local server answers `/api/current_deployment` only when `Host` is
  `127.0.0.1:<port>` or `localhost:<port>`, so a DNS-rebinding page cannot read the key.
- *Same?* Yes, except the Host check.
- *Why*: "Ainda não fizemos" — nothing forces it; it is a choice to close a hole Convex leaves.
- *App impact*: none; a user who opens the local dashboard by a LAN name gets the sign-in form instead of
  being signed in.
- *Recommendation*: match Convex everywhere else, add the Host check. Same-origin serving (Q1 C) would remove
  CORS from the picture but is not needed for safety: the key, not the origin, is the credential.
- **Decision (owner, 2026-10-12):** Convex's model plus the `Host` check (`127.0.0.1` / `localhost`) against
  DNS rebinding (DV-476).

### Q5 — `bunvex dashboard` on self-hosted, and the CLI's dashboard links (DV-477, closes DV-217)

- *Convex*: `npx convex dashboard` refuses for self-hosted, opens the local dashboard for an anonymous local
  deployment; export / import print a `https://dashboard.convex.dev/d/<name>/settings/snapshots` link, wrong
  for self-hosted (its own FIXME).
- *bunvex*: `bunvex dashboard` the same (refuse on self-hosted, open the local one); export / import print a
  link to the local dashboard when `dev` is serving one, and nothing on self-hosted.
- *Same?* The command yes; the links no.
- *Why*: "Não dá pra fazer" — the only link Convex prints is to its cloud (rule 5, and bunvex has none).
- *App impact*: none (CLI text).
- *Recommendation*: as proposed. Opening the docker dashboard from `bunvex dashboard` on self-hosted would be an
  addition (it needs the dashboard's URL in the CLI's config); not now.
- **Decision (owner, 2026-10-12): as proposed** — a link to the local dashboard when `dev` serves one,
  otherwise none; `bunvex dashboard` refuses on self-hosted, as Convex (DV-477, which replaces DV-217).

### Q6 — Cloud-only screens to skip
 (not a divergence: the self-hosted Convex dashboard lacks them too)
- *Convex self-hosted*: no insights, deployment summary, backups, custom domains, snapshots page, team /
  billing / members / usage; deploy keys are cloud.
- *bunvex*: skip insights (Big Brain), backups and custom domains (cloud), team / billing. Keep bunvex's
  existing additions: the Overview's summary (built from `getVersion`, the URL queries and `lastPushEvent`, all
  deployment-local) and Snapshots in Settings (B1, decided) over `/api/export/*` and `/api/import`.
- *Same?* Yes for what is skipped; the summary and Snapshots are already-decided additions.
- *Why*: "Não dá pra fazer" for the cloud ones (no cloud).
- *App impact*: none.
- *Recommendation*: as proposed.
- **Decision (owner, 2026-10-12): confirmed** as planned.

### Q7 — Package layout (internal, not a divergence)

- *Proposed*: `@bunvex/dashboard-source` depending on `@bunvex/client` and the dashboard's types, instead of
  UI-01 §5.7's `@bunvex/dashboard/http` over `@bunvex/protocol`.
- *Why*: Convex's admin API is system functions over the sync protocol; the client already speaks it.
- *Recommendation*: accept; PR 1 amends UI-01 §5.7 and §6.
- **Decision (owner, 2026-10-12): confirmed** as planned.
