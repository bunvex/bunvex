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
| D10 | Columns are reordered from a **Columns** panel (keyboard-first); Convex drags headers (dnd-kit) | accessible first; header dragging can come later | **decided: keep** (30 Sep 2026) |
| D11 | Not yet built: custom query, metrics per table. **Generate schema** added 30 Sep 2026: the schema panel's Saved / Generated tabs, as Convex's `ShowSchema.tsx` and `GenerateSchema.tsx` (Convex infers "shapes" on the server over every document, `/api/shapes2`; bunvex asks the source's optional `inferDocumentType(table)`, which the mock computes over its whole table). **Create table** added 30 Sep 2026 (the sidebar's name box, as Convex's `DataSidebar.tsx`, `validateConvexIdentifier`; the contract's optional `createTable`, which Convex does with `_system/frontend/createTable`, inserting and deleting a document). The cell menu is complete (§1.4.1): **View value** (Space) and **Delete document** added 30 Sep 2026, and **Go to reference** (Cmd/Ctrl+G) through the contract's optional `tableOfId` (what Convex reads off an id with its table mapping) | scope | follow-up |
| D13 | **Delete document** from a cell's menu asks first ("Delete 1 document?"), as Delete selected does; Convex deletes at once, and asks only on a production deployment (`TableContextMenu.tsx`, `isProtectedDeployment`) | a delete cannot be undone, and bunvex has no production/development distinction yet | **open** |
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
| L6 | Not yet: the call tree, deployment events in the list, usage and identity in the details, custom test queries, "act as a user", run history, live (subscribed) query results | the contract has no parent execution id, events, usage, identity or live function results yet | follow-up; live query results in the runner: **decided** (30 Sep 2026), later — a query runs once for now |

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

