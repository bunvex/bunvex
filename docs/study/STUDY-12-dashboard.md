# STUDY-12 — The dashboard (Data browser first)

- **Status:** draft — divergences in §4 await the owner (the ones marked *decided* were decided during the
  work, 29 Sep 2026)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`npm-packages/dashboard`,
  `dashboard-common`, `dashboard-self-hosted`, `@convex-dev/design-system`, `system-udfs`,
  `crates/local_backend`)
- **Related:** [UI-01](../specs/UI-01-ui-and-dashboard.md) (the design record; §12 follows this study),
  [parity: platform §21](../parity/platform.md)
- **Licence:** the Convex repository is **FSL-1.1-Apache-2.0** (each release becomes Apache-2.0 two years
  after it); the dashboard packages declare no licence of their own. Nothing below was copied: it records
  design only.

## 1. How Convex does it

### 1.1 Packages

| package | what it is |
|---|---|
| `dashboard-common` | every screen of ONE deployment (data, schema, functions, function runner, files, schedules, logs, health, history, settings, disconnect overlay), the layout shell and sidebar, shared elements, the context seam. No routes. |
| `dashboard-self-hosted` | a thin Next.js app: `_app.tsx`, ~20 one-line pages that re-export shared screens (`export default DataView`), a login form. |
| `dashboard` | the cloud app: WorkOS auth, teams / projects / billing, the same screens under `/t/{team}/{project}/{deployment}/…`, cloud-only settings, analytics, Sentry. |
| `@convex-dev/design-system` | a published component package (Button, Combobox, Menu, Modal, Sheet, Tooltip…) with semantic CSS-variable tokens, a `.dark` variant, and a `UIProvider Link={…}` so it never imports `next/link`. |
| `system-udfs` | the server functions the dashboard calls (`_system/frontend/*`), deployed into every backend. |

Shared code is consumed as raw source through tsconfig path aliases (`@common/*`, `@ui/*`), which every tool
(Next, jest, Storybook, vitest) must re-declare; the shared CSS even `@source`s the cloud app. The boundary is
not enforced.

### 1.2 The seam between shared screens and hosts

One context object, `DeploymentInfo` (`dashboard-common/src/lib/deploymentContext.tsx`), ~60 members:

- **Connection**: `{ ok: true, deploymentUrl, adminKey } | { ok: false, errorCode, errorMessage }`.
- **Hooks as values**: `useCurrentDeployment`, `useIsOperationAllowed(op)`, `useIsProtectedDeployment`,
  `useIsDeploymentPaused`, team / project / member / entitlement / billing hooks, ~16 WorkOS hooks.
- **Components**: `Link`, `ErrorBoundary`, `DisconnectOverlay`, `CloudImport`, `TeamMemberLink`.
- **URL prefixes**: `deploymentsURI` is `""` self-hosted (routes `/data`, `/logs`) and
  `/t/{team}/{project}/{deployment}` in the cloud.
- **Flags and optional callbacks**: `isSelfHosted`, integrations, `captureEvent?`, `openFeedbackForm?`.

Self-hosted fills most of it with stubs (team id 0, everything entitled). A full `mockDeploymentInfo`
serves stories and tests.

The connection is layered: credentials (`DeploymentInfo`) → a connected `ConvexReactClient` with
`setAdminAuth(adminKey)` (`DeploymentApiProvider`) → a render gate (`WaitForDeploymentApi`: 404, error with
retry, loading, or the app) → a connection watcher that polls the socket state and shows the host's
disconnect overlay. A rotated key is pushed into the open socket without rebuilding the client.

Self-hosted gets credentials from env vars, a same-origin `GET /api/current_deployment` (the CLI-served
build), an iframe `postMessage` handshake (which can also restrict the visible pages), or a login form; it
verifies them with `GET /api/check_admin_key` and keeps them in sessionStorage.

**Permissions** are named operations (`ViewData`, `WriteData`, `ViewLogs`, `ViewMetrics`,
`RunInternalMutations`, `ActAsUser`, … ~20). Self-hosted takes the list from `check_admin_key`
(`allowedOps`); the cloud from custom roles. Every write button is gated, and a disabled one says which
permission is missing.

**Worth copying**: one typed seam; a mock of it; layered connection; permissions as named operations
returned by the backend; host differences as prop slots (e.g. `HealthView` header/wrappers, a cloud-only
section rendered only when its props are passed); analytics as injected callbacks.
**Worth avoiding**: path-alias consumption; a shared package that knows its hosts (`@source` of the cloud
app, hard-coded cloud URLs, 22 `isSelfHosted` branches, a `/login` redirect in shared fetch code); a
60-member seam full of cloud concepts self-hosted must stub; hooks passed as context values.

### 1.3 Navigation and screens

Sidebar (`layouts/DeploymentDashboardLayout.tsx`): **Health, Data, Schema, Functions, Files, Schedules,
Logs**, then **History** (audit log) and **Settings** (environment variables, authentication, components,
integrations, usage limits, pause; the cloud adds backups, custom domains, snapshots). A global function
runner is docked beside every screen.

- **Health**: top-k heatmaps of function calls, failure rate and cache hit rate; scheduler lag; running and
  queued functions; subscription invalidations — all from `/api/app_metrics/*`, refreshed every ~60 s, with
  deployment events (pushes) overlaid on the charts.
- **Functions**: a file tree of modules (`modules.listForAllComponents`); per function, calls / errors,
  latency percentiles, cache hit rate, invalidations, and its logs; a "run" button into the runner.
- **Logs**: long-poll stream, client-side filters (function, status, level, text) saved per deployment,
  pause-and-buffer, audit events interleaved, a call tree rebuilt from `parentExecutionId`.

### 1.4 The Data screen

Live-change highlighting, read after the first pass (`dashboard-common/src/features/data/components/Table/`):
a cell compares its value with the previous render's (`DataCell/utils/useTrackCellChanges.ts`) and flashes
`animate-highlight` (1 s, yellow `--background-highlight`) unless the row at that position changed; a row
flashes when its `_creationTime` is less than 1 s before `Date.now()` (`DataRow.tsx`); when rows arrive above
a scrolled view, the header's bottom edge flashes (`Table.tsx`, `utils/useMaintainScrollPositionOnChange.ts`).
Grid navigation and editing are per cell (`DataCell/utils/cellActions.ts`: arrows, Enter to edit, Shift+Enter
for the document, Space to view, Cmd+C to copy, …).


One screen, `/data?table=…&filters=…&component=…`:

```
DataView                       permission gate, skeletons, resizable sidebar | content
├─ DataSidebar                 component switcher, table search, one link per table ("*" if not in the
│                              schema), create table
└─ DataContent  key=table      the orchestrator: filters, paginated query, count, selection, columns,
   │                           the single side panel
   ├─ DataToolbar              table name, Add / Edit (n) / Delete (n), menu: custom query, schema,
   │                           indexes, metrics, clear table, delete table
   ├─ IndexFilterBar           index selector + index clauses, field ("scan") filters, order, column
   │                           picker, "N documents"
   ├─ Table                    virtualized rows, sortable/resizable/hideable columns, checkboxes, a
   │                           collapsible document viewer for the selection, context menu
   └─ side panel (one at a time)   add documents · edit document · bulk edit fields · schema · indexes ·
                                   metrics · confirmations
```

**State.** The table, the component and ONE opaque `filters` param live in the URL (shallow replace), so a
link to a filtered view — or to one document, `filters = {_id eq id}` — is shareable and back/forward
work. The last filters of each table are remembered in memory when switching tables. Column order, hidden
columns, widths, date display per field and page size are in localStorage per deployment + table. Selection
is not persisted; "select all" is a pseudo-selection until every row is loaded.

**Filters** — one serializable expression, validated on both sides and passed to the server verbatim:

```
FilterExpression = { clauses: FieldFilter[], order?: asc|desc, index?: IndexFilter | SearchFilter }
FieldFilter      = { id, field, enabled, op, value }   op: eq neq gt gte lt lte · anyOf noneOf · type notype
IndexFilter      = { name, clauses: [eq…, optional trailing range {lower gt|gte, upper lt|lte}] }
SearchFilter     = { name, search, clauses: [eq on filter fields] }
```

Rules (a pure model module offers only valid next moves): index clauses are a prefix of the index's
fields; only the last may be a range; the order follows the index; field filters apply on top of the
index range. Structural edits apply at once, typed values after 400 ms, nothing applies while a clause is
invalid. Values are encoded so ids, 64-bit integers and bytes survive; "unset" is distinct from `null`.

**Server side** (`system-udfs/convex/_system/frontend/paginatedTableDocuments.ts`): decode and validate;
invalid clauses come back as error rows (the paginated hook keeps working, chips show the error); index
clauses become an index range, comparisons a filter checked while scanning, type filters are applied to
the page after pagination (pages can be short); `_id eq` alone becomes a point lookup; each page reads at
most 10 000 rows / 5 MB. Default order `desc`.

**Data flow.** Everything is a reactive subscription over the WebSocket: table mapping, schemas,
indexes (with backfill state), components, the paginated documents (page size 25, paused after a minute
of user idleness; the previous results stay visible while a new filter's first page loads) and the count
(`tableSize`, a maintained count, not a scan). Unfiltered, the count sizes the virtual list; filtered, the
list grows by pages ("N documents loaded").

**The table.** Headless TanStack Table (v8) + react-window with a fixed row height. Columns: the union of
schema fields and observed keys, `_id` first, `_creationTime` last, at most 25 visible at first, new fields
appended to the saved order. Sorting a column is only possible through an index (the header explains why
not otherwise). Cells: dates detected (`_creationTime`, or numbers in a plausible ms range), references to
other tables bold with a hover preview, strings quoted and truncated, `unset` in italics, everything else
as a JS literal; a cell flashes when a live value changes. Keyboard: arrows move between cells; copy, view,
edit value / document, go to reference, context menu — each with a shortcut. Inline edit (double-click or
Enter) with an optimistic update; "filter by this value" from the context menu.

**Safety.** Permission gates with explanations; unmounted components read-only; on a protected (production)
deployment, edits unlock once per session after a confirmation; destructive production actions ask for
typed confirmation; a table cannot be deleted while the schema or a reference uses it; a timeout halves
the page size and retries.

### 1.5 What the server exposes to the dashboard

**Auth**: `Authorization: Convex <adminKey>` over HTTP (or `?adminKey=`); `{ tokenType: "Admin" }` on the
WebSocket. `_system/*` functions require an admin; each also checks a named operation. The query cache key
includes the caller's allowed operations. `GET /api/check_admin_key` → `{ success, allowedOps, isReadOnly }`.

**System functions** (`_system/frontend/*`, reactive over the WebSocket), by use:

| use | functions |
|---|---|
| browse | `getTableMapping`, `tableSize`, `sizeOfAllTables`, `paginatedTableDocuments(table, filters, paginationOpts)`, `getById`, `listById`, `listTableScan` |
| schema | `getSchemas` → `{ active, inProgress }` (JSON), `schemaValidationProgress`, `indexes(table)` → fields + backfill state + staged |
| edit | `addDocument` (≤ 4 096, all-or-nothing), `patchDocumentsFields(ids or whole table, fields)`, `replaceDocument`, `deleteDocuments` (≤ 4 096), `clearTablePage` (4 000 per call, oldest first, loop on cursor), `createTable` — every edit writes an audit-log entry |
| functions | `modules.list` / `listForAllComponents` (functions, visibility, HTTP routes, crons), `modules.argsValidator` |
| other | files (`fileStorageV2.*`), schedules and crons, environment variables, auth providers, deployment events (audit log), deployment state, version, URLs, exports |

**HTTP** (`crates/local_backend/src`): `/api/shapes2` (inferred document types), `/api/get_indexes`,
`/api/delete_tables`, environment variables, pause / unpause, and:

- **Metrics** `/api/app_metrics/{udf_rate, cache_hit_percentage, latency_percentiles, table_rate,
  *_top_k, scheduled_job_lag, function_concurrency}` — a `window { start, end, num_buckets }`, series of
  `[time, value | null]`.
- **Logs** `/api/app_metrics/stream_function_logs?cursor=<ms>` — a **long-poll**: returns as soon as
  there are entries after the cursor, or `{ entries: [], newCursor }` after 60 s; an in-memory ring of the
  last ~1 000 executions. Entries are `Completion` (function, type, timestamps, duration, cached, error,
  request / execution / parent ids, usage stats, OCC info, log lines) or `Progress` (log lines of a running
  action). Log lines are `{ messages, level, timestamp, isTruncated }`.

### 1.6 Priorities for a bunvex admin API (for the server side)

1. Admin-key auth on HTTP and WebSocket; named operations; `check_admin_key`-style endpoint.
2. Browse: table list with counts, paginated documents with a filter expression (index range + field
   filters), point lookup by id.
3. Edit: insert (all-or-nothing, bounded), patch (with "unset"), replace, delete (bounded), clear by
   pages; audit entries.
4. Schema and indexes with backfill state; inferred shapes can come later.
5. Logs: cursor long-poll over a ring buffer, with the Completion / Progress shape — ideally with
   server-side filters (Convex filters on the client, capped at 10 000 entries).
6. Functions: module list, visibility, argument validators; deployment version and state.
7. Metrics: rates, cache hit rate, latency percentiles, top-k, per window.
8. Later: files, schedules and crons, environment variables, audit log, pause, exports.

## 2. What an app can observe

The dashboard is a tool for the people running an app, not part of the app's contract. What a user of it
relies on, and bunvex keeps:

- the screens and what they show: tables and their documents, indexes (with backfill state), schema,
  functions, logs, health;
- the Data browser's behaviour: filter by index (prefix + range) and by any field, in the index's order;
  live documents and counts; edit a value in place, add documents, delete a selection, clear a table,
  with confirmations for what cannot be undone;
- links: a filtered view and a single document are URLs that can be shared;
- the admin-key model: an admin key (or a scoped one) decides what the dashboard may do.

## 3. How bunvex does it

As built, the design is recorded in UI-01 §11–§12. In short: `@bunvex/dashboard` holds every screen and
reads everything through an injected `DashboardDataSource` (contract v2, UI-01 §12.4) — never the engine;
`apps/dashboard` is a thin Vite host over a `MockDataSource` until the server's admin API exists (§1.6 is
the server side's priority list). The Database screen: a resizable table list; a data grid (TanStack Table
v9 + Virtual) with keyboard navigation, in-place editing, selection, live updates and change highlighting;
a filter bar over one serializable `FilterExpression`; one side panel at a time (document, schema, indexes,
columns, add documents).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | Our own dashboard package, not Convex's dashboard run against a compatible API | One package for self-hosted and a future cloud, behind an interface; Convex's dashboard is FSL, consumes ~40 system UDFs and HTTP routes over its own sync protocol, and is tied to Next.js and its hosts | **decided** (the owner's brief, UI-01) |
| D2 | The screen is **Database** at `/database/$table`; Convex's is **Data** at `/data?table=` | the owner's naming | **decided** (UI-01 §12.6) |
| D3 | Live documents by `watchTable` ("the table changed") + refreshing the loaded pages, not reactive pages | simpler for the server; same screen | **decided** (UI-01 §12.6) |
| D4 | Changed data flashes **blue** (our `--info`), not yellow | blue already means "live" in bunvex; yellow reads as our `--warning` | **decided** (UI-01 §12.5.4) |
| D5 | Changes compared by **row id**, not by position; a row counts as new when it arrives between or above rows already shown, not when `_creationTime` is within 1 s of the viewer's clock | scrolling and paging never flash; no dependence on a skewed clock | awaiting the owner |
| D6 | With reduced motion, a steady tint for the same time instead of no flash; a polite screen-reader announcement ("2 documents changed"), at most every 5 s | accessibility | awaiting the owner |
| D7 | The filter lives in one `filter` param: base64url of bunvex's `FilterExpression` (`index.eq` + `range`, `clauses`, `order`); Convex's `filters` param is base64 of its own shape (`indexEq`/`indexRange` clauses, a search-index variant) | our contract's shape; search indexes do not exist yet | awaiting the owner |
| D8 | A link to a document is `?doc=<id>` (opens the side panel); Convex links a filter `_id eq <id>` | the document opens beside the list instead of replacing it | awaiting the owner |
| D9 | Values are typed in the filter bar's syntax (`42`, `true`, `"text"`, `[1, 2]`, `42n`, a bare word is text; an empty cell removes the field); Convex edits JS literals in a Monaco editor | no editor dependency; one syntax for filters and edits | awaiting the owner |
| D10 | Columns are reordered from a **Columns** panel (keyboard-first); Convex drags headers (dnd-kit) | accessible first; header dragging can come later | awaiting the owner |
| D11 | Not yet built: create table, generate schema, custom query, metrics per table, the context menu, "filter by this value", copy/view shortcuts per cell, `Shift+Enter` document editing | scope of the first PR | follow-up |
| D12 | The Health screen shows the engine's counters (commit clock, cache, subscriptions, conflicts), not Convex's function metrics | the server has no app-metrics API yet (parity §20) | follow-up |

## 5. Tests

- `describeDataSourceContract` (`@bunvex/dashboard/contract`): the contract's semantics — pagination and
  cursors, every filter operator against an oracle, index prefix and range, errors naming the clause,
  watchers, capabilities, and (opt-in, on a scratch table) the writes. The server's implementation runs
  the same suite against a live deployment.
- The Database screen end to end on the mock (filters, links, panels, live insertion, editing, selection,
  add / delete / clear, column layout, focus), with axe on each state; the grid and its pieces in
  `@bunvex/ui`. Each behaviour was sabotaged once and watched to fail.
- Not yet: the same scenarios against a real bunvex server, and side by side with Convex's dashboard.

## 6. Open questions

1. D5–D10: keep bunvex's choice, or match Convex?
2. Should the admin API mirror Convex's system UDFs and routes (§1.5) closely enough that Convex's own
   dashboard could run against bunvex too? (UI-01 §5.7 puts the admin messages in `@bunvex/protocol`.)
