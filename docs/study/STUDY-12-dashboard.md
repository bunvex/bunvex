# STUDY-12 — The dashboard (Data browser first)

- **Status:** accepted — every divergence in §4 decided by the owner (29–30 Sep 2026)
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

### 1.4.1 The cell's context menu and shortcuts

`dashboard-common/src/features/data/components/Table/TableContextMenu.tsx` builds the menu,
`…/Table/DataCell/utils/cellActions.ts` (`useActionHotkeys`) the shortcuts, which only the focused cell
listens to (`DataCell.tsx`), and `lib/useContextMenuTrigger.ts` opens it on a right-click (a long press
closes it on release).

- **Filter by `<column>`** ▸ equals, not equal, >, <, ≥, ≤, is type, is not type — trimmed by
  `showFilter`: `null`/unset get only the type filters; `_id`, objects, arrays and booleans no order
  filters; `_creationTime` no equality; `_id` and `_creationTime` no type filters. The clause is added to
  the draft filter.
- **View `<column>`** (Space) or **Go to reference** (Cmd+G, for an id or a file), **Copy `<column>`**
  (Cmd+C: text as it is, anything else as a pretty literal), **Edit `<column>`** (Enter).
- **View Document** (Shift+Space), **Copy Document** (Shift+Cmd+C), **Edit Document** (Shift+Enter),
  **Delete Document**. Cmd+Enter opens the menu from the keyboard.

bunvex builds the same menu and shortcuts, less View value, Go to reference and Delete document (D11). The
grid opens it on a right-click, Shift+F10, the Menu key or Ctrl/Cmd+Enter (the platform's keys as well as
Convex's). A filter is applied at once — bunvex's filter bar applies as you type (UI-01 §12.3) — rather
than added as a draft. View document opens the side panel (D8); Edit document opens it in its editor.

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
| D5 | Changes compared by **row id**, not by position; a row counts as new when it arrives between or above rows already shown, not when `_creationTime` is within 1 s of the viewer's clock | scrolling and paging never flash; no dependence on a skewed clock | **decided: keep** (30 Sep 2026) |
| D6 | With reduced motion, a steady tint for the same time instead of no flash; a polite screen-reader announcement ("2 documents changed"), at most every 5 s | accessibility | **decided: keep** (30 Sep 2026) |
| D7 | The filter lives in one `filter` param: base64url of bunvex's `FilterExpression` (`index.eq` + `range`, `clauses`, `order`); Convex's `filters` param is base64 of its own shape (`indexEq`/`indexRange` clauses, a search-index variant) | our contract's shape; search indexes do not exist yet | **decided: keep** (30 Sep 2026) |
| D8 | A link to a document is `?doc=<id>` (opens the side panel); Convex links a filter `_id eq <id>` | the document opens beside the list instead of replacing it | **decided: keep** (30 Sep 2026) |
| D9 | ~~Values typed in a syntax of our own (`42`, `"text"`, `42n`, a bare word is text)~~ | — | **decided: match Convex** (30 Sep 2026): values are JavaScript literals (`{ name: "Ada", credits: 10n }`, `Bytes("…")`, `undefined` removes a field), edited in a Monaco editor where a value can be long — filter values, cells with objects or arrays, the whole document, adding documents. No longer a divergence. |
| D10 | Columns are reordered by **dragging a header**, as Convex (dnd-kit there, pointer events here), **and** from a **Columns** panel (keyboard-first) | the panel is the keyboard and screen-reader way | **decided** (30 Sep 2026): both — dragging added (UI-01 §17.3), the panel kept |
| D11 | Not yet built: custom query, metrics per table. **Generate schema** added 30 Sep 2026: the schema panel's Saved / Generated tabs, as Convex's `ShowSchema.tsx` and `GenerateSchema.tsx` (Convex infers "shapes" on the server over every document, `/api/shapes2`; bunvex asks the source's optional `inferDocumentType(table)`, which the mock computes over its whole table). **Create table** added 30 Sep 2026 (also on a deployment with no tables at all: `/database` shows "There are no tables here yet" and Create table, as Convex's `EmptyData.tsx`) (the sidebar's name box, as Convex's `DataSidebar.tsx`, `validateConvexIdentifier`; the contract's optional `createTable`, which Convex does with `_system/frontend/createTable`, inserting and deleting a document). The cell menu is complete (§1.4.1): **View value** (Space) and **Delete document** added 30 Sep 2026, and **Go to reference** (Cmd/Ctrl+G) through the contract's optional `tableOfId` (what Convex reads off an id with its table mapping) | scope | follow-up |
| D13 | **Delete document** from a cell's menu asks first ("Delete 1 document?"), as Delete selected does; Convex deletes at once, and asks only on a production deployment (`TableContextMenu.tsx`, `isProtectedDeployment`) | a delete cannot be undone, and bunvex has no production/development distinction yet | **decided** (30 Sep 2026): keep asking, since bunvex will have production deployments too; `CONFIRM_DELETE_FROM_CELL_MENU` in `database/screen.tsx` switches it, to become a check of the deployment's kind (ask on production only, as Convex) once deployments have one |
| D12 | The Health screen shows the engine's counters (commit clock, cache, subscriptions, conflicts), not Convex's function metrics | the server has no app-metrics API yet (parity §20) | **closed on the mock** (30 Sep 2026): the Health screen keeps the engine's counters and adds Convex's function metrics from the contract's optional metrics methods (§12, UI-01 §18.1); a server fills them once it measures them |

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

1. ~~D5–D10~~ decided (§4).
2. Should the admin API mirror Convex's system UDFs and routes (§1.5) closely enough that Convex's own
   dashboard could run against bunvex too? (UI-01 §5.7 puts the admin messages in `@bunvex/protocol`.)

## 7. Logs, Functions and the function runner (added 29–30 Sep 2026)

Read at the same commit, in `npm-packages/dashboard-common/src/features/{logs,functions,functionRunner}`
and `lib/functions`, `lib/useLogs.ts`.

### 7.1 How Convex does it

**Logs** (`logs/components/Logs.tsx`, `LogList.tsx`, `LogListItem.tsx`, `LogDrilldown.tsx`,
`logs/lib/filterLogs.ts`, `lib/useLogs.ts`):

- One stream, opened when the screen mounts (`useLogs` over `stream_function_logs`, §1.5), never skipped.
  It starts with what the server's ring buffer holds; there is no paging back beyond it. The screen keeps
  at most **10 000** entries (`MAX_LOGS`), dropping the oldest.
- Entries are either a **log line** (level DEBUG / INFO (`LOG`) / WARN / ERROR, messages, the function,
  the request id) or an **outcome** (success / failure, duration, cached, error). The list shows them
  **newest first**, one row each: time with milliseconds, the first 4 characters of the request id, the
  outcome and duration (or a rule for a log line), the function kind's initial (Q / M / A / H) and name,
  then the message. Failures and ERROR lines are tinted.
- **Filters, all on the client** over the loaded buffer (`filterLogs`): functions (a multi-select of the
  deployment's functions plus "other"), log types (a multi-select of success, failure, DEBUG, INFO, WARN,
  ERROR), and a free-text box (debounced 200 ms) that matches the function name, the message or error, or
  a request id. Filters are kept in **local storage per deployment** (`logs/<deployment>/…`), not in the
  URL. Components add a component filter.
- **Pause**: scrolling away from the top pauses the list, and so does the pause button; new entries are
  buffered while paused and merged when it resumes (the button shows it). **Clear** hides what is loaded so
  far (a marker row can bring it back).
- **Drilldown**: activating a row opens a side panel with tabs for the execution (timing, usage, cached,
  caller, identity), the request (every execution of the request) and the function call tree (rebuilt from
  `parentExecutionId`). Up / Down move to the next or previous entry, Shift for the same request, Ctrl or
  Cmd for the same execution; "filter by this request id" fills the text box. Deployment events (pushes,
  environment changes) are interleaved in the list.

**Functions** (`functions/components/FunctionsView.tsx`, `DirectorySidebar.tsx`, `FileTree.tsx`,
`FunctionSummary.tsx`, `FunctionLogs.tsx`, `lib/functions/generateFileTree.ts`):

- A sidebar with the modules as a file tree (folders from the module path, functions inside each file in
  source order), searchable; the open function is `?function=<module:name>` in the URL.
- The function's summary: its name, kind and visibility ("Internal query"), a copyable identifier (and the
  URL for an HTTP action), and a **Run** button that opens the runner on it (disabled where the admin key
  may not run it, and for internal functions without the matching operation).
- Tabs: **Statistics** (invocations, errors, latency percentiles, cache hit rate — from the app-metrics
  API) and **Logs** (the Logs list filtered to this function, with its own text and level filters kept per
  function).

**Function runner** (`functionRunner/components/FunctionRunnerWrapper.tsx`, `FunctionTester.tsx`,
`FunctionResult.tsx`, `QueryResult.tsx`, `RunHistory.tsx`, `lib/functionRunner.ts`):

- A panel docked to every screen (bottom, or right when "vertical"), toggled with **Ctrl+`** or the "Run
  functions" button; it opens on the function being looked at, or on a "custom test query".
- Arguments in the object editor (JavaScript literals in Monaco, the same editor as documents), checked
  against the function's argument validator when it has one; "act as a user" adds an identity.
- A **query** is subscribed: its result updates live, with its log lines. A **mutation or action** runs on
  the **Run** button; each run is kept in a per-function history (local storage) that can be reopened. The
  result shows the value, the duration and the function's log lines, or the error.

### 7.2 How bunvex does it

The contract already has `listFunctions` (path, kind, visibility), `listLogs` (newest first, paged) and
`watchLogs` (live tail). Log entries are lines; the line that ends an execution carries its outcome
(`execution: { status, durationMs }`) instead of a separate outcome entry. Nothing below needs the server.

- **Logs**: one list, newest first, of the first `listLogs` page plus everything `watchLogs` delivers, at
  most 10 000 entries; older pages load at the end of the list. Filters as in Convex, on the client, kept in
  local storage per deployment scope: functions, types (success, failure and the four levels) and text
  (function, message, request id). Pause and resume with a count of what arrived meanwhile; Clear. A side
  panel for the activated line: the line, its execution's outcome and duration, and every line of the same
  request, with "filter by this request". The list is the data grid, so arrows move between lines.
- **Functions**: the modules as a tree, `?function=` in the URL, the summary (kind, visibility, copyable
  path, Run), and the function's logs (the same list, filtered to it). No Statistics tab.
- **Runner**: an optional `runFunction(path, args)` in the contract, a docked Run panel with the arguments
  in the code editor, the result as a literal, or the error.

### 7.3 Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| L1 | Functions has no Statistics tab | the server has no app-metrics API yet (parity §20); like D12 | **decided** (29 Sep 2026): build without metrics |
| L2 | Log filters on the client over the loaded list | — (this is Convex's way) | **decided** (29 Sep 2026): match Convex |
| L3 | An optional `runFunction` in the contract and a Run panel | — (Convex has the runner) | **decided** (29 Sep 2026): build it |
| L4 | Older logs load at the end of the list (`listLogs` pages); Convex shows only what its stream's ring buffer holds | the contract pages history; a server with a longer history can show it | **decided** (30 Sep 2026): keep the paging |
| L5 | The list does not pause by itself when you scroll down; it keeps your place instead (the row at the top of the view stays put while lines arrive above it), and the pause button stops new lines | the data grid anchors its top row already; the result a reader sees is the same | **decided** (30 Sep 2026): keep ours |
| L7 | Log filters live in the URL (`?function=&type=&q=`) **and** in this browser per deployment (on the Functions screen, `?type=&q=` next to the open function, kept per function); Convex keeps them in the browser only | a link carries the filters; opened without them, the screen starts from the last view, as Convex's does | **decided** (30 Sep 2026) by the owner |
| L6 | Not yet: deployment events in the list, usage and identity in the details, custom test queries, "act as a user", run history, live (subscribed) query results | the contract has no events, usage, identity or live function results yet | follow-up; live query results in the runner: **decided** (30 Sep 2026), built (§10.1); the call tree added 30 Sep 2026 (Convex's "Functions Called", `features/logs/components/FunctionCallTree.tsx`, from `executionId` / `parentExecutionId`); continued in §10: live query results, run history, acting as a user, deployment events, usage and identity all built |

## 8. Validators and the declared schema (added 30 Sep 2026)

### 8.1 How Convex does it

- **The form.** A `v.*` validator serializes to JSON (`npm-packages/convex/src/values/validators.ts`,
  `ValidatorJSON`): `{ type: "string" }`, `{ type: "id", tableName }`, `{ type: "object", value: { f: {
  fieldType, optional } } }`, `{ type: "union", value: [...] }`, `{ type: "record", keys, values }`, a
  `literal` with a JSON value (an int64 as `{ $integer }`). Push analysis stores each function's `args` and
  `returns` in this form.
- **What the dashboard receives.** `_system/frontend/modules:argsValidator` returns a function's arguments
  validator as a JSON string, or `{ "type": "any" }` when none is declared
  (`npm-packages/system-udfs/convex/_system/frontend/modules.ts`, `_system/cli/modules.ts`
  `DEFAULT_ARGS_VALIDATOR`); the CLI's `apiSpec` also returns `returns`.
- **The runner** (`dashboard-common/src/features/functionRunner/components/FunctionTester.tsx`) starts the
  arguments from `defaultValueForValidator` (`dashboard-common/src/lib/defaultValueForValidator.ts`:
  `""`, `0`, `0n`, `false`, `[]`, `{}`, a literal's value, a union's first member; optional fields left
  out), and its editor (`elements/ObjectEditor`) checks what is typed against the validator as it changes,
  underlining every misfit (`ConvexSchemaValidationError`: missing property, extra property, type not
  assignable, no union member matches) and disabling Run while there are errors.
- **Display.** `dashboard-common/src/lib/format.ts` `displayValidator` prints a validator as `v.*` code
  (`v.float64()` for a number, `v.int64()`, `v.id("t")`, `v.optional(...)` inside objects).
- **The server** validates arguments too: a misfit fails the call with an `ArgumentValidationError`.
- The Functions screen does not show validators; only the runner uses them.
- **The saved schema.** `_system/frontend/getSchemas` returns the active schema as JSON (`SchemaJson` in
  `dashboard-common/src/lib/format.ts`: per table its `documentType` validator and indexes, and
  `schemaValidation`). The table's schema panel (`features/data/components/TableSchema.tsx`,
  `ShowSchema.tsx`) prints it as the whole `convex/schema.ts` (`displaySchema`: `defineSchema({ t:
  defineTable({ … }).index("name", ["field"]) })`, adding `{ schemaValidation: false }` only when off) and
  highlights the table's lines; a second tab, "Generated", infers one from the documents.
- **The saved schema.** `_system/frontend/getSchemas` returns the active schema as JSON (`SchemaJson` in
  `dashboard-common/src/lib/format.ts`: per table its `documentType` validator and indexes, and
  `schemaValidation`). The table's schema panel (`features/data/components/TableSchema.tsx`,
  `ShowSchema.tsx`) prints it as the whole `convex/schema.ts` (`displaySchema`: `defineSchema({ t:
  defineTable({ … }).index("name", ["field"]) })`, adding `{ schemaValidation: false }` only when off) and
  highlights the table's lines; a second tab, "Generated", infers one from the documents.

### 8.2 How bunvex does it

- `FunctionInfo` carries optional `args` / `returns` in Convex's JSON form (`ValidatorJson` in the
  contract); absent means none declared. `src/validators.ts` displays them as `v.*` code (one line, or one
  field per line when wide), makes the template, and checks a value — each misfit with its path, so the
  runner's editor underlines the value (or the key, for an extra property) with the parser's positions
  (`parseLiteralLocated`). The dashboard never imports `@bunvex/values`: the JSON form is the contract.
- The runner follows Convex's: template, check as you type, every misfit underlined, Run disabled.
- The mock declares validators for most of its functions (some declare none) and checks arguments like a
  server: a misfit is the run's `ArgumentValidationError`, not a rejected call. The contract suite checks
  that declared validators are well-formed, and (opt-in) that a misfit fails the run.
- An `id` validator checks that the value is text; the table an id belongs to is not checked.
- **The saved schema**: `SchemaInfo.tables[].validator` is the declared document type in the same form
  (without system fields). The schema panel prints the whole `bunvex/schema.ts` (imports from
  `bunvex/server` and `bunvex/values`, declared indexes from the table list, the option only when
  validation is off), with the table's lines tinted and scrolled to, a screen-reader note naming them, and
  Copy. The "Generated" tab comes with the D11 follow-ups.
- **The saved schema**: `SchemaInfo.tables[].validator` is the declared document type in the same form
  (without system fields). The schema panel prints the whole `bunvex/schema.ts` (imports from
  `bunvex/server` and `bunvex/values`, declared indexes from the table list, the option only when
  validation is off), with the table's lines tinted and scrolled to, a screen-reader note naming them, and
  Copy. The "Generated" tab comes with the D11 follow-ups.

### 8.3 Divergences

| # | bunvex | why | status |
|---|---|---|---|
| V1 | The Functions screen shows a function's declared arguments and return validators as code; Convex's shows neither | the owner asked for it | **decided** (30 Sep 2026) by the owner |

## 9. Schedules, Files, Environment variables and History (added 30 Sep 2026)

The owner asked for these four screens on 30 Sep 2026, each built as **optional** contract methods (detected
with `typeof`, as the writes and `runFunction`) with the mock implementing them before the server does.

### 9.1 How Convex does it

Sources: `npm-packages/dashboard-common/src/features/{schedules,files,settings,history}`, the system
functions in `npm-packages/system-udfs/convex/_system/frontend/`, the system tables in
`npm-packages/system-udfs/convex/schema.ts` and `tableDefs/deploymentAuditLogTable.ts`, the routes in
`npm-packages/dashboard-self-hosted/src/pages/`.

- **Navigation** (`layouts/DeploymentDashboardLayout.tsx`): Files, Schedules, History and Settings are always
  in the sidebar. Schedules opens `/schedules/functions`, with a second page `/schedules/crons`; Settings has
  its own pages, among them `/settings/environment-variables` (the self-hosted build has it too). What a
  credential may not do is disabled with a tooltip ("You do not have permission…"), not hidden.
- **Scheduled functions** (`paginatedScheduledJobs.ts`, `ScheduledFunctionsList*.tsx`,
  `ScheduledFunctionsContentToolbar.tsx`): the `_scheduled_jobs` still to run (`nextTs` set), **nearest first**,
  paginated, optionally for one function (`udfPath`, a picker "Filter scheduled runs by function"). A row: id
  (copy), the scheduled time, the function, the state (`pending` or `inProgress`), and a menu — **View
  Arguments** and **Cancel** (a confirmation; disabled while it runs or without `WriteData`). **Cancel all**
  (optionally for the picked function) goes to `/api/cancel_all_jobs`, one to `/api/cancel_job`. Live, with
  a pause ("Go Live") when updates come too fast. Finished runs are not listed (they are in Logs).
- **Cron jobs** (`listCronJobs.ts`, `listCronJobRuns.ts`, `crons/CronsTable.tsx`): each `_cron_jobs` entry
  with its schedule (`interval` seconds, `hourly`, `daily`, `weekly`, `monthly` in UTC, or a `cron`
  expression), function and arguments, its last run (`_cron_job_logs`: time, status `success` / `err` /
  `canceled`, execution time, log lines) and next run; the columns Name, Schedule, Function, Args and a menu
  with the run history.
- **Files** (`fileStorageV2.ts`, `FileStorage*.tsx`, `Uploader.tsx`, `PreviewImage.tsx`,
  `DeleteFilesButton.tsx`): `_storage` newest first (or oldest), paginated, with a date range and a lookup by
  storage id; a row has the id (copy), size, content type, the creation time, a preview for **images**,
  **Download** and **Delete** (a confirmation); several can be selected and deleted together. **Upload**
  generates an upload URL (`generate_upload_url`, audited) and POSTs the file to it; it needs `WriteData`.
  The header shows the total number of files.
- **Environment variables** (`settings/components/EnvironmentVariables.tsx`, `listEnvironmentVariables.ts`,
  `settings/lib/api.ts`): name and value rows; values **hidden** ("•••") with Show / Hide and "Copy Name and
  Value"; add, edit and delete are gathered in a form and saved **together** by one
  `/api/update_environment_variables` call with `changes: [{ name, value | null }]`. Names: 1–256
  characters, `^[a-zA-Z_]+[a-zA-Z0-9_]*$`; values up to 8 KiB (the backend also caps 512 variables and
  512 KiB in all: `crates/common/src/knobs.rs` `ENV_VAR_LIMIT`, `ENV_VAR_TOTAL_SIZE_LIMIT`). Pasting a `.env`
  file adds its lines; a value wrapped in quotes gets a warning. "Copy All" copies them as `.env` lines.
- **History** (`history/components/HistoryView.tsx`, `paginatedDeploymentEvents.ts`): the
  `_deployment_audit_log`, newest first, paginated, filtered by a date range (and, in the cloud, by team
  member and action). An event has an `action` (`add_documents`, `update_documents`, `delete_documents`,
  `clear_tables`, `create_table`, `delete_files`, `generate_upload_url`, `create_environment_variable`,
  `update_environment_variable`, `delete_environment_variable`, `cancel_scheduled_function`,
  `cancel_all_scheduled_functions`, `push_config`, `build_indexes`, …), the author and its `metadata`. It
  needs `ViewAuditLog`. Running a function is not an audited action.

### 9.2 How bunvex does it

- **The contract** (`@bunvex/dashboard/data-source`, UI-01 §14): optional methods per feature —
  `listScheduledFunctions` / `cancelScheduledFunction` / `cancelAllScheduledFunctions` /
  `watchScheduledFunctions`, `listCronJobs`; `listFiles` / `getFile` / `uploadFile` / `deleteFiles`;
  `listEnvironmentVariables` / `updateEnvironmentVariables` (one all-or-nothing batch, Convex's shape);
  `listAuditEvents`. New operations: `viewEnvironmentVariables`, `writeEnvironmentVariables`,
  `viewAuditLog` (Convex's `ViewEnvironmentVariables`, `WriteEnvironmentVariables`, `ViewAuditLog`);
  schedules and files use `viewData` / `writeData`, as Convex.
- **The mock** implements all of it; the contract suite checks each feature when the caller opts in.
- **The screens** follow Convex's pages and routes: `/schedules/functions`, `/schedules/crons`, `/files`,
  `/settings/environment-variables` (`/settings` opens it), `/history`. The sidebar always lists them, as
  Convex's; on a source without the methods, the screen says the deployment does not offer it yet.

### 9.3 Divergences

| # | bunvex | why | status |
|---|---|---|---|
| S1 | Scheduled functions and cron runs refresh on a `watch…` signal (refetch), not a reactive query | the same approach as the documents (D3) | follows D3 (decided) |
| S2 | No component picker | bunvex has no components yet | follow-up |
| F1 | A preview for **text** files too (Convex previews images only) | proposed, **not built**: it would be a divergence | **decided** (30 Sep 2026): images only, as Convex |
| H1 | The author of an event is the credential ("admin key"), not a team member | a self-hosted deployment has no team members; the audit entry's `member_id` is null there | follows the data |
| H2 | Events are recorded by the source (the mock records the dashboard's writes, cancellations, file and environment-variable changes); pushes and index builds appear once the server records them | the contract only reads the log | follow-up (server) |

## 10. The runner and the logs, second pass (added 30 Sep 2026)

What Convex's function runner and log screen do beyond what §7 built, and how bunvex follows. Sources are in
`npm-packages/dashboard-common/src/features/functionRunner` and `features/logs` of the Convex repository.

### 10.1 Live query results (R1)

A **query** in Convex's runner is not run: `QueryResult.tsx` subscribes it with the current arguments
(`convex.watchQuery(…)`, `onUpdate`, `localQueryResult`, `localQueryLogs`), shows the last result while the
next one loads, and says "This query is subscribed to updates" with a blinking dot. With invalid arguments it
is **paused** ("The arguments are invalid. Fix the argument errors to continue."). Mutations and actions keep
the Run button (`FunctionTester.tsx`, `useFunctionResult`). bunvex: an optional `watchFunction(path, args,
onResult, onError)` in the contract, a query only (a mutation or an action is `invalid_request`); the runner
subscribes a query when the source has it and falls back to Run once when it has not.
**Status: decided** (30 Sep 2026, the owner: now), built.

### 10.2 Run history (R2)

`RunHistory.tsx`: for each function, the arguments of its last **25** runs (with the identity acted as), newest
first, kept in the browser per deployment (`useGlobalLocalStorage("runHistory/<deployment>/<function>")`);
the same arguments twice in a row are one entry. **Previous arguments** / **Next arguments** buttons step
through them, filling the editor. Only mutations and actions have it: a query follows its arguments.
**Status: built**, as Convex (no divergence; the entry keeps the arguments, the identity comes with §10.3).

### 10.3 Acting as a user (R3)

`FunctionTester.tsx`: an **Act as a user** checkbox (allowed with the `ActAsUser` operation) opens an editor
for the identity — `subject` and `issuer` required, the OpenID claims optional (`name`, `email`, …), and
`customClaims` (`parseImpersonatedUser`). Runs and subscriptions then carry it (the client's admin auth with an
acting identity); the history keeps the identity with the arguments. bunvex: an `actAsUser` operation,
`RunOptions.identity` on `runFunction` and `watchFunction`, the same checks (`runner/identity.ts`), one setting
for the whole page with Convex's default `{ subject: "fake_id", issuer: "fake_issuer" }`, kept in the history.
**Status: built**, as Convex.

### 10.4 Deployment events in the log list (L8)

`lib/interleaveLogs.ts` merges the execution log lines with the deployment's audit-log events by time
(`DeploymentEventListItem.tsx` shows one as a line of its own: who did what), and a "cleared" marker.
bunvex: the Logs list interleaves the audit log's events (§9) when the source has `listAuditEvents` and the
credential may read it; they are not filtered (Convex's are not); Enter on one opens it on the History screen,
where bunvex shows an event's details (Convex opens it in the log's drilldown). **Status: built**.

### 10.5 Usage and identity in a line's details (L9)

`LogMetadata.tsx`: for an execution or a whole request, **Resources used** — compute (memory × time), database
I/O read / written, file bandwidth, text and vector search, the bytes returned, summed across the executions
("Total resources used across N executions") — and who started it (`FunctionIdentity`: Admin, User, Admin
(acting as user), System, Unknown) and the environment (Convex's isolate or Node.js). bunvex: optional
`usage` and `identity` on an execution's last line in the contract; the details show who started the request
and its resources summed over its loaded executions. Not shown: the environment (bunvex runs functions in
one runtime) and text / vector search (bunvex has neither yet). **Status: built**.

## 11. Settings → General, narrow screens, the design system (added 30 Sep 2026)

### 11.1 How Convex does it

- **General** is the first settings page (`dashboard-common/src/layouts/deploymentSettingsPages.ts`,
  `DeploymentSettingsLayout.tsx`); self-hosted, it holds **Pause Deployment** only
  (`dashboard-self-hosted/src/pages/settings/index.tsx`). The deployment's two URLs — the client ("Cloud")
  URL and the **HTTP Actions URL** — are shown with the Health summary
  (`features/health/components/DeploymentSummary.tsx`, cloud only) and on the cloud "URL & Deploy Key" page.
- **Pause / resume** (`features/settings/components/PauseDeployment.tsx`): "This deployment is currently
  paused / running", a button (danger to pause, primary to resume) gated on the `PauseDeployment` /
  `UnpauseDeployment` operations, a confirmation naming the deployment, and the consequences listed (paused:
  new calls fail, scheduled jobs queue, cron jobs are skipped; resumed: calls run, queued jobs run, crons
  resume). The routes are `POST /api/pause_deployment` and `/api/unpause_deployment`
  (`features/settings/lib/api.ts`). While paused, every page shows a banner linking to the setting
  (`layouts/DeploymentDashboardLayout.tsx`).

### 11.2 Divergences

| # | bunvex | why | status |
|---|---|---|---|
| G1 | The URLs (client, HTTP actions) and the deployment's name, version and persistence sit on **Settings → General**, next to pausing; Convex shows the URLs with the Health summary (cloud only) | self-hosted has no cloud page for them; General is where a self-hosted reader looks for "what is this deployment" | **decided** (30 Sep 2026): the owner asked for them in Settings |

## 12. Metrics (added 30 Sep 2026)

### 12.1 How Convex does it

- **Routes** (`crates/local_backend/src/app_metrics.rs`), each with a `window` = `{ start, end, num_buckets }`
  and series of `[time, value | null]`: `udf_rate` (a function's `invocations`, `errors`, `cacheHits`,
  `cacheMisses`), `cache_hit_percentage`, `latency_percentiles` (asked percentiles, one series each),
  `function_call_count_top_k`, `failure_percentage_top_k`, `cache_hit_percentage_top_k` (the top `k`
  functions plus `_rest`), `table_rate` (`rowsRead`, `rowsWritten`), `scheduled_job_lag`. They need the
  `ViewMetrics` operation (`crates/keybroker/src/operations.rs`).
- **Dashboard** (`npm-packages/dashboard-common/src/lib/appMetrics.ts`): Health (`features/health/components/
  HealthView.tsx`) shows **Function Calls** (top 5 lines), **Failure Rate** and **Cache Hit Rate** (top-k
  lines, or a heatmap view), over the last hour, refreshed every minute. A function's **Statistics** tab
  (`features/functions/components/PerformanceGraphs.tsx`): Function Calls, Errors, Execution Time (p50, p90,
  p95, p99), Cache Hit Rate. A table's **Metrics** tool (`features/data/components/TableMetrics.tsx`, from
  `useToolPopup.tsx`): Reads and Writes.

### 12.2 What bunvex does

The contract gains optional methods in Convex's shapes (`data-source-metrics.ts`): `functionRate`,
`cacheHitPercentage`, `latencyPercentiles`, `topFunctions(measure)` (the three top-k routes as one method),
`tableRate`, `scheduledJobLag`, all behind `viewMetrics`. The mock measures them from its own log history,
so charts and the Logs screen agree. Charts are bunvex's own SVG line chart (`@bunvex/ui/components/
line-chart`), validated colours (dataviz), a keyboard crosshair and a table view.

| # | bunvex | why | status |
|---|---|---|---|
| M1 | The top-k measures are one method, `topFunctions(measure, window, k)`, not three | the same shape three times; a server maps it to its three routes | **decided** (30 Sep 2026): the owner asked for metrics in Convex's shape; the shapes are kept, only the method count differs |
| M2 | Failure and cache hit rate show lines only; Convex also has a heatmap view of them | lines first; the heatmap can follow | follow-up |
| M3 | A function keeps its colour across the charts and over refreshes (its slot comes from its name); Convex colours by rank | colour should follow the entity, not its rank (a refresh would repaint a line) | **decided** (30 Sep 2026): a better default, nothing an app observes |

## 13. Authentication and snapshots in Settings (added 30 Sep 2026)

### 13.1 Authentication (A1)

Convex: **Settings → Authentication** (`dashboard-common/src/features/settings/components/AuthenticationView.tsx`,
`AuthConfig.tsx`) lists the providers from `_system/frontend/listAuthProviders.ts` (the `_auth` system table,
which `auth.config.ts` fills on push; types in `npm-packages/convex/src/server/authentication.ts`): an OIDC
provider shows its domain and application ID, a custom JWT provider its issuer, JWKS URL, algorithm and optional
application ID, each value copyable, with a link to the docs of that kind; with none, "This deployment has no
authentication providers yet." and a docs link. The page needs both `ViewData` and `ViewEnvironmentVariables`.

bunvex: an optional `listAuthProviders` in the contract (`data-source-auth.ts`) with Convex's two shapes; the
page under Settings, after Environment variables; the same permission rule; the mock declares one provider of
each kind (`authProviders` overrides). One difference, from the repository's rule against Convex's names in
shipped code: with no providers the page says they are declared in `auth.config.ts` instead of linking Convex's
docs (bunvex has no docs site yet). **Status: built** (UI-01 §19.1).

## 14. The Schema screen (added 30 Sep 2026)

Missed in the first lists and caught by the owner: Convex's sidebar has **Schema** between Data and Functions
(`dashboard-common/src/layouts/DeploymentDashboardLayout.tsx`, `href: …/schema`; the self-hosted page is
`dashboard-self-hosted/src/pages/schema.tsx` → `SchemaView`).

### 14.1 How Convex does it

`features/schema` (~5 000 lines, on `@xyflow/react` and `elkjs`):

- **Data** (`SchemaView.tsx`): the saved schema (`getSchemas`, `active`) wins; tables that hold documents without
  a schema entry join it, typed from their inferred shapes and flagged ("not defined in your schema",
  `TableNode.tsx`); with no saved schema, the graph is built from the shapes alone. No tables: "This deployment
  doesn't have any tables" and "Create a table and add a convex/schema.ts …"; no `ViewData`: a permission notice.
- **Graph** (`lib/buildSchemaGraph.ts`): a node per table with its top-level fields — a compact TypeScript-style
  label (`Id<users>`, `{ … }`) and the full type when the label hides detail — and an edge for every `v.id(…)`,
  direct or nested in arrays, records, objects and unions. A union document type keeps its members, with a
  discriminator detected from literal fields.
- **Groups** (`lib/clustering.ts`, `SchemaClusters.tsx`): connected components; a large one split by Louvain
  modularity; named after the most connected table; on by default, the choice kept per deployment; groups can be
  renamed and dragged.
- **Layout** (`lib/elkLayout.ts`): ELK `layered`, top to bottom, groups as compound nodes; ELK loaded on demand.
- **Around it**: search over groups, tables, fields and indexes (`SchemaSearch.tsx`); a minimap
  (`SchemaMinimap.tsx`); zoom in / out, fit, reset layout, the grouping toggle (`SchemaControls.tsx`); a side panel
  with each field (a long type expands), a union's members and the discriminator, and the table's indexes
  (`SchemaSidePanel.tsx`, reusing the data page's index view).

### 14.2 What an app can observe

Nothing: it is a view of the schema the app already declares.

### 14.3 How bunvex does it

`packages/dashboard/src/schema/` (UI-01 §21), with **@xyflow/react 12.12.0 and elkjs 0.12.0** (the owner's call,
as Convex), both in the Schema route's chunk. Fed by the contract's `getSchema` (Convex's JSON validators, V2),
`listTables` (indexes, counts, undeclared tables) and, where the source has it, `inferDocumentType` for tables
without a declared type. The same model (fields, compact and full labels, references, union members with their
discriminator), groups (connected components, Louvain's local moving for groups of 8 or more), ELK layout,
search, minimap, controls and side panel. The open table is in the URL (`?table=`).

### 14.4 Divergences

| # | bunvex | why | status |
|---|---|---|---|
| SC1 | Groups cannot be renamed or dragged as a whole; tables can be dragged, and Reset layout lays everything out again | a first version; nothing an app observes | follow-up |
| SC2 | The type labels quote table names (`Id<"users">`), as TypeScript writes them; Convex shows `Id<users>` | the same text the code has | decided (30 Sep 2026, part of building it as Convex) |
| SC3 | No schema-validation progress (Convex links the CLI's `?showSchema=true` to it) | the contract has no validation progress yet | follow-up |

