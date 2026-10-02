# UI-01 — the design system and the dashboard

> **v1, 29 Sep 2026** (open questions of §10 decided the same day). Adds three workspaces — `@bunvex/ui`, `@bunvex/dashboard` and
> `apps/dashboard` — and the contract between the dashboard and whatever serves its data,
> `DashboardDataSource`. The server side of that contract is implemented elsewhere; this document is the
> agreement both sides build against. The living map stays in [`ARCHITECTURE.md`](../../ARCHITECTURE.md).
>
> Amended through §25 (1 Oct 2026). Sections are kept as the record of each round; where a later one
> replaced an earlier rule, the earlier section says so. **§0 is the current state.**

## 0. Current state (1 Oct 2026)

Everything below runs on `MockDataSource`; no server implements the contract yet (§5.7).

**Screens** (main sidebar, in labelled groups, §23.2):

| Screen | Route | Specified in |
|---|---|---|
| Health | `/` | §18.1 (metrics charts); the engine counters from slice 4 (§12.5.1) |
| Topology | `/topology?node=` | §22 (a bunvex addition) |
| *Data* — Database | `/database/$table?filter&doc&panel` | §12.3, §12.5.2–§12.5.10, §15.2–§15.5, §22.3 |
| *Data* — Schema | `/schema?table=` | §21, §22.2, §22.6 |
| *Data* — Files | `/files` | §14.3, §24 |
| *Functions* — Functions | `/functions?function&tab` | §13.2, §15.1, §18.2, §22.5 |
| *Functions* — Schedules | `/schedules/functions`, `/schedules/crons` | §14.2, §23.3 |
| *Manage* — Authentication | `/auth/$section` (`/settings/authentication` redirects) | §25 (a bunvex addition) |
| *Observe* — Logs | `/logs?function&type&kind&q&range&from&to` | §22.4 (supersedes the layout of §13.1) |
| *Observe* — History | `/history` | §14.5, §22.5 |
| Settings | `/settings/general`, `/settings/environment-variables`, `/settings/snapshots` | §17.1, §17.2, §14.4, §19.2, §23.3 |
| The function runner | a panel on every screen | §13.3, §16.1–§16.3 |

**Shared patterns:** the **section column** (`shell/section-column.tsx`: title and action, labelled nav,
the current page's filters; resizable; a sheet on phones; §23.1); the **docked side panel**
(`shell/panel.tsx`, resizable, persisted width, a sheet on phones; §22.1); the **full-bleed grid** with
Bar 1 (title, count, actions; 44 px, aligned with the panel header) and Bar 2 (search, filters)
(`shell/bars.ts`, `DataTable` `fill`; §22.3, §22.5); the **flow canvas** with shared controls
(`shell/flow-controls.tsx`; Schema §21, Topology §22); values as **JavaScript literals** in the code
editor (§12.5.7); **plain-path routes** (§11.2).

**The contract** (`@bunvex/dashboard/data-source`; every optional method is detected with `typeof`, and
`describeDataSourceContract` covers each area, the writes opt-in):

- required: deployment, capabilities, stats, tables, schema, documents (list, get, `watchTable`), functions, logs (list, watch);
- data: `insertDocuments`, `patchDocuments`, `replaceDocument`, `deleteDocuments`, `clearTable`, `createTable`, `tableOfId`, `inferDocumentType`;
- functions: `runFunction`, `watchFunction`;
- deployment (`data-source-deployment.ts`): scheduled functions and crons, files (`listFiles`, `countFiles`, `fileStats`, `getFile`, `uploadFile`, `deleteFiles`, `watchFiles`), environment variables, the audit log;
- state (`data-source-state.ts`): `getDeploymentState`, `pauseDeployment`, `resumeDeployment`;
- metrics (`data-source-metrics.ts`): function rate, cache hit, latency percentiles, top functions, table rate, scheduler lag;
- snapshots (`data-source-snapshot.ts`): export and import;
- auth (`data-source-auth.ts`): `listAuthProviders`; auth admin (`data-source-auth-admin.ts`): users, sessions, organizations, events, config;
- topology (`data-source-topology.ts`): `getTopology`, `watchTopology`.

**The dev host's mock knobs** (`apps/dashboard`, query params kept for the tab, §11.2): `latency`,
`fail`, `writes`, `tables` (`0`: no tables), `tasks`, `executions` (volume, §19.3), `nodes` (Topology).

**Tests:** happy-dom + Testing Library + axe per package (`bun test`); the contract suite on the mock;
Playwright end-to-end in Chromium (`bun run e2e` in `apps/dashboard`, the CI job "e2e · dashboard in
Chromium", not a required check), with axe and colour contrast in both themes and a guard on Health's
first load (§12.5.10, §14.1, §19.4).

## 1. Goals and non-goals

**Goals**

- A dashboard for a bunvex deployment: an overview, tables and their documents (paginated), functions,
  and logs.
- One dashboard package that serves **two hosts**: the self-hosted server today, a cloud control plane
  later. It therefore knows nothing about where its data comes from: every byte arrives through an
  injected `DashboardDataSource`.
- A design system of its own (`@bunvex/ui`) — tokens, light and dark themes, accessible components —
  reusable by `apps/docs` and any later UI.
- Developable and testable with no server running (`MockDataSource`).

**Non-goals for v0**

- Editing documents, running functions, deleting tables, schema editing. The contract leaves room for
  them (§5.6) but the screens are read-only.
- Authentication UI. Credentials (an admin key, a cloud session) belong to the data source a host
  constructs, never to the dashboard.
- The HTTP implementation of the data source and the server's admin endpoints (§5.7).
- Serving the dashboard from `bunvex start` / a Docker image.

## 2. Stack and versions

Pinned with `^` to the latest release on 29 Sep 2026 (`npm view`), Bun 1.4.2 as for the rest of the repo.

| concern | choice | version | why |
|---|---|---|---|
| UI library | React | 19.3 | shadcn/ui and Base UI target it; `@bunvex/react` will too |
| primitives | Base UI (`@base-ui/react`) | 1.8 | asked for; unstyled, accessible, `render` prop instead of `asChild` |
| components | shadcn/ui, **Base UI variant** (`style: "base-lyra"`) | CLI 4.21 | code we own, generated by `shadcn add` and then edited; *Lyra* is shadcn's boxy, sharp style that pairs with monospace type — a fit for a dashboard that is mostly ids, timestamps and JSON |
| styling | Tailwind CSS v4 (CSS-first `@theme`, no `tailwind.config`) | 4.3 | shadcn v4 default |
| variants / classes | `class-variance-authority`, `clsx`, `tailwind-merge` | 0.7 · 2.1 · 3.7 | what shadcn's generated code uses (`cn`) |
| animation | `tw-animate-css` | 1.4 | shadcn's replacement for `tailwindcss-animate` |
| icons | `lucide-react` | 1.48 | shadcn's default icon library |
| app bundler | Vite + `@vitejs/plugin-react` + `@tailwindcss/vite` | 8.3 · 6.1 · 4.3 | only in `apps/dashboard` |
| tests | `bun test` + `@happy-dom/global-registrator` + `@testing-library/react` / `user-event` + `axe-core` | 20.14 · 16.3 / 14.6 · 4.13 | the repo's runner; no Jest/Vitest |

**Found while generating (shadcn 4.21):** `shadcn add` without `shadcn init` in a workspace package
resolves aliases through the package's `exports` (every alias needs an entry, `hooks` included), does not
install the style's dependencies, writes no tokens, and imports `cn` from an npm package named `cn` (a
dependency of the CLI itself) instead of the `utils` alias. The generated files were fixed by hand
(`@bunvex/ui/lib/utils`), the `cn` package removed, the style's dependencies added and the tokens written
in `globals.css`. Re-check each `shadcn add` for the same.

**Vite runs under Bun** (`bun --bun vite`): the workspace packages export TypeScript sources, which
Node's loader refuses in `vite.config.ts`.

How the Base UI variant is selected (shadcn docs, v4.21): the `style` field of `components.json` carries
the primitives library as a prefix — `base-<style>` for Base UI, `radix-<style>` for Radix — and
`shadcn init --base base` writes it. Generated components import from `@base-ui/react/*` and compose with
`render={<Button />}` where the Radix variant used `asChild`.

**Not used**: `next-themes` (a 40-line theme provider in `@bunvex/ui` does it without Next). *(v1 also
ruled out a router and TanStack Query; the owner reversed that the same day — see §11.)*

## 3. Layout

```
packages/
├── ui/                                @bunvex/ui                ← design system, no bunvex dependency
│   ├── components.json                shadcn config: style base-lyra, aliases @bunvex/ui/*
│   ├── src/
│   │   ├── styles/globals.css         Tailwind entry, tokens (light + .dark), @theme inline mapping
│   │   ├── lib/utils.ts               cn()
│   │   ├── lib/contrast.ts            OKLCH → WCAG contrast, used by the token tests
│   │   ├── components/*.tsx           shadcn (Base UI) components + our own: code-block, data-table,
│   │   │                              empty-state, stat, theme-toggle, json-view
│   │   ├── theme.tsx                  ThemeProvider, useTheme (light | dark | system)
│   │   └── theme-script.ts            storage key + pre-paint script, no React (for build configs)
│   ├── test/
│   └── tsconfig.json                  DOM lib + react-jsx
│
├── dashboard/                         @bunvex/dashboard         ← screens; depends on ui only
│   ├── src/
│   │   ├── data-source.ts             THE CONTRACT: DashboardDataSource and its types (no React)
│   │   ├── mock/                      MockDataSource + seeded fixtures (deterministic)
│   │   ├── data/                      hooks: useResource, usePaginated, useWatch
│   │   ├── routes.ts                  DashboardRoute union, parse/format for hosts that use the URL
│   │   ├── screens/                   overview, tables, documents, functions, logs
│   │   ├── shell/                     sidebar, header, error boundary
│   │   └── dashboard.tsx              <Dashboard dataSource … />
│   ├── test/
│   └── tsconfig.json
│
apps/
└── dashboard/                         private, not published    ← thin Vite host
    ├── index.html · vite.config.ts · tsconfig.json
    └── src/main.tsx · src/app.css     mounts <Dashboard dataSource={new MockDataSource()} />
```

### 3.1 Exports (ARCH-01 D7: the `exports` map is the public API)

| package | subpath | contents |
|---|---|---|
| `@bunvex/ui` | `./components/*` | one file per component (`@bunvex/ui/components/button`), shadcn's monorepo convention |
| | `./lib/*` | `cn`, `contrast` |
| | `./hooks/*` | shared hooks (required by the shadcn CLI's `hooks` alias) |
| | `./theme` | `ThemeProvider`, `useTheme` |
| | `./theme-script` | `THEME_STORAGE_KEY`, `themeScript()` — no React |
| | `./styles.css` | the Tailwind entry with the tokens |
| `@bunvex/dashboard` | `.` | `Dashboard`, `DashboardRoute`, route helpers |
| | `./data-source` | the contract types only — importable by a server-side or cloud implementation with no React |
| | `./mock` | `MockDataSource`, `createFixture` |
| | `./contract` | `describeDataSourceContract` — imports `bun:test`, so it has its own subpath and never reaches a browser bundle |

Like every package today, both export their TypeScript sources (ARCH-01 §7, D8); a build step comes with
publishing. Inside `@bunvex/ui` the generated components import each other through the package's own
name (`@bunvex/ui/lib/utils`) — the shadcn monorepo convention, resolved by package self-reference.

### 3.2 Tailwind across packages

`@bunvex/ui/styles.css` declares `@source "../**/*.{ts,tsx}"` for its own files. The host's CSS imports it
and adds `@source` for `@bunvex/dashboard`'s sources, so utilities used by the screens are generated.
The dashboard therefore ships **no CSS of its own**: a host must include the two `@source` lines (the app
shows how; the package README will say it).

## 4. Design

### 4.1 Tokens and themes

- Semantic tokens as CSS variables in OKLCH, shadcn's names (`--background`, `--foreground`, `--primary`,
  `--muted`, `--border`, `--ring`, `--destructive`, `--chart-1..5`, `--sidebar-*`) plus three the
  dashboard needs: `--success`, `--warning`, `--info` (log levels, statuses) with `-foreground` pairs.
- Light values under `:root`, dark under `.dark`; `@custom-variant dark (&:is(.dark *))`. The theme
  provider sets the class on `<html>`, persists the choice in `localStorage` (`bunvex-theme`), follows
  `prefers-color-scheme` in `system` mode, and exposes an inline script string so a host can set the class
  before first paint (no flash).
- Typography: a sans stack for chrome, a monospace stack (`--font-mono`) for ids, timestamps, JSON and
  function paths — a dashboard for a database is mostly data. No web font is bundled in v0.
- Shape: Lyra's square corners and hard edges; tables are the main surface.

### 4.2 Accessibility

- Base UI supplies focus management, ARIA roles and keyboard interaction for the interactive primitives
  (menus, dialogs, selects, tabs, tooltips).
- Every screen has one `<h1>`, landmarks (`nav`, `main`), a skip link, visible focus (`ring` token), and
  no information carried by colour alone (log levels have a text label as well as a colour).
- **Contrast is tested, not eyeballed**: a test converts every foreground/background token pair of both
  themes from OKLCH to sRGB and asserts WCAG AA (4.5:1 for text, 3:1 for `--ring` and `--border`-drawn
  controls against `--background`). `--border` is decorative (dividers) and exempt; control boundaries
  use `--input`, which is therefore darker than shadcn's default.
- `prefers-reduced-motion` disables `tw-animate-css` transitions.

### 4.3 Navigation

> **Superseded by §11.2** (TanStack Router). Kept as the v1 record.

`<Dashboard>` owns no URL. Navigation is a typed value:

```ts
type DashboardRoute =
  | { screen: "overview" }
  | { screen: "tables" }
  | { screen: "documents"; table: string; index?: string; order?: "asc" | "desc" }
  | { screen: "document"; table: string; id: string }
  | { screen: "functions" }
  | { screen: "logs"; function?: string; level?: LogLevel };
```

It is uncontrolled by default (internal state) and controlled when the host passes `route` +
`onNavigate`. Links are real `<a href>` (`hrefFor(route)`, default `#` + path) so a new tab, copy and
middle-click work; a plain click navigates in place. A navigation moves focus to `<main>` so a screen
reader announces the new screen; the skip control is a button, not a `#main` link, because a host may
route on the hash.

The **host owns the theme** and any account UI: `<Dashboard headerActions={…}>` renders what it is given
at the end of the header (`apps/dashboard` passes `ThemeToggle`). The dashboard does not assume a
`ThemeProvider`, so a control plane with its own theming can mount it. `parseRoute(path)` / `formatRoute(route)` convert to and from a path (`/tables/tasks`), so a
host can mirror it in the URL or the hash; `apps/dashboard` uses the hash. A cloud control plane mounts the
dashboard under its own router with a prefix.

### 4.4 Data layer

> **Superseded by §11.3** (TanStack Query). Kept as the v1 record.

Three hooks over the injected source, in `src/data/`, with no global cache:

- `useResource(fn, deps)` — one Promise-returning call; `{ data, error, loading, reload }`; aborts the
  previous call (`AbortSignal`) when deps change or the component unmounts.
- `usePaginated(fn, deps)` — cursor pagination; keeps the pages loaded, `loadMore()`, `isDone`, reset on
  deps change.
- `useWatch(subscribe, deps)` — wraps a `watch*` method with `useSyncExternalStore`.

**The overview** is built around the commit clock — the timestamp every write advances — with commits per
second over the last ~60 samples as a sparkline (`@bunvex/ui/components/sparkline`: one series, from
zero, hover crosshair with the exact value, the summary as its accessible name), and the counters below
with their per-second rates. Rates come from consecutive `watchStats` samples (`screens/stats.ts`); a
sample whose commit clock went back resets the history (a server restart).

Errors are rendered by the screen (inline, with a retry) — an `unauthorized` or `unavailable`
`DataSourceError` is shown by the shell once, not by every panel.

## 5. The contract — `DashboardDataSource`

Lives in `@bunvex/dashboard/data-source`: plain TypeScript types and one error class, **no React and no
bunvex import**, so an implementation can live anywhere (an HTTP client in the browser, a cloud API
client, the mock). All methods are asynchronous; every call takes an optional `AbortSignal`.

```ts
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A document as the dashboard shows it. System fields as in Convex. */
export type Document = { _id: string; _creationTime: number; [field: string]: Json };

export type CallOptions = { signal?: AbortSignal };
export type Unsubscribe = () => void;

// ------------------------------------------------------------------ deployment
export type DeploymentInfo = {
  name: string;                        // shown in the header; "local" for self-hosted dev
  version: string;                     // server version
  persistence: string;                 // "memory" | "sqlite" | "postgres" | … (free text)
  url?: string;                        // the deployment's client URL, if the host wants it shown
};

/** A point-in-time snapshot of the counters the server keeps (today's GET /stats). */
export type DeploymentStats = {
  at: number;                          // wall-clock ms when sampled
  commitTs: number;                    // latest visible commit timestamp
  commitGroups: number;                // group commits since start
  conflicts: number;                   // OCC conflicts since start
  retries: number;                     // mutation retries since start
  cacheHits: number;
  cacheMisses: number;
  subscriptions: number;               // live subscriptions now
  subscriptionReruns: number;
  subscriptionUpdates: number;         // updates published
};

// ------------------------------------------------------------------ tables & documents
export type IndexInfo = { name: string; fields: string[]; system: boolean };
export type TableInfo = {
  name: string;
  indexes: IndexInfo[];                // system indexes (by_id, by_creation_time) first
  documentCount?: number;              // omitted when the source cannot count cheaply
};

export type PageRequest = { numItems: number; cursor: string | null };
/** Convex's pagination result shape, so the server can pass core's paginate() through. */
export type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

export type DocumentQuery = PageRequest & {
  table: string;
  index?: string;                      // default "by_creation_time"
  order?: "asc" | "desc";              // default "desc"
};

// ------------------------------------------------------------------ functions
export type FunctionKind = "query" | "mutation" | "action";
export type FunctionInfo = {
  path: string;                        // "module:name"
  kind: FunctionKind;
  visibility: "public" | "internal";
};

// ------------------------------------------------------------------ logs
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEntry = {
  id: string;                          // unique and ordered: a later entry has a greater id
  time: number;                        // wall-clock ms
  level: LogLevel;
  message: string;
  function?: { path: string; kind: FunctionKind };
  requestId?: string;                  // groups the lines of one execution
  execution?: { status: "success" | "failure"; durationMs: number }; // on the line that ends one
};
export type LogFilter = { function?: string; levels?: LogLevel[] };
export type LogQuery = PageRequest & LogFilter; // newest first; the cursor walks back in time

// ------------------------------------------------------------------ errors
export type DataSourceErrorCode = "unauthorized" | "not_found" | "invalid_request" | "unavailable";
export class DataSourceError extends Error {
  constructor(readonly code: DataSourceErrorCode, message: string) { super(message); }
}
// exported with it: LOG_LEVELS, toDataSourceError(e) (anything else → "unavailable"), isAbortError(e)

// ------------------------------------------------------------------ the interface
export interface DashboardDataSource {
  getDeployment(opts?: CallOptions): Promise<DeploymentInfo>;
  getStats(opts?: CallOptions): Promise<DeploymentStats>;
  /** Pushes a fresh snapshot whenever the source has one (an implementation may poll). */
  watchStats(onStats: (s: DeploymentStats) => void, onError: (e: DataSourceError) => void): Unsubscribe;

  listTables(opts?: CallOptions): Promise<TableInfo[]>;
  listDocuments(q: DocumentQuery, opts?: CallOptions): Promise<Page<Document>>;
  getDocument(table: string, id: string, opts?: CallOptions): Promise<Document | null>;

  listFunctions(opts?: CallOptions): Promise<FunctionInfo[]>;

  listLogs(q: LogQuery, opts?: CallOptions): Promise<Page<LogEntry>>;
  /** Live tail: entries newer than those already delivered, in id order, matching the filter. */
  watchLogs(filter: LogFilter, onEntries: (e: LogEntry[]) => void, onError: (e: DataSourceError) => void): Unsubscribe;
}
```

### 5.1 Semantics both sides rely on

- **Pagination is by opaque cursor**, never by offset: `cursor: null` starts; `continueCursor` of the last
  page is passed back; `isDone` ends. A cursor is only valid for the same query (table, index, order /
  filter). A document inserted after the first page may or may not appear — the dashboard offers a
  refresh, it does not promise a consistent snapshot across pages (core's `paginate` is an M item; when it
  lands with snapshot semantics, the contract does not change).
- **`numItems` is a hint**: a page may hold fewer items without being the last one (`isDone` decides).
- **Errors** are thrown as `DataSourceError`; anything else is treated as `unavailable`. Unknown table →
  `not_found`. Aborting a call rejects with the signal's `AbortError`, which the hooks ignore.
- **Watchers** deliver on their own schedule, never synchronously inside the `watch*` call, and stop
  delivering once unsubscribed. `onError` does not end the subscription unless the code is
  `unauthorized`.
- **Values are JSON** in v0. When `@bunvex/values` defines the richer types (Int64, bytes, ids that carry
  their table), `Json` becomes an exported encoding of them (Convex's `$integer` / `$bytes` style) — an
  additive change to this file, versioned with the package.

### 5.2 Mapping to today's server (informative, for the implementer)

| contract | server today |
|---|---|
| `getStats` | `GET /stats`: `ts → commitTs`, `groups → commitGroups`, `conflicts`, `retries`, `cacheHits`, `cacheMisses`, `subs → subscriptions`, `reruns → subscriptionReruns`, `published → subscriptionUpdates` |
| `getDeployment.persistence` | the `label` passed to `createServer` (`storage` in `/stats`) |
| `listTables` | `engine.schema.tables` (indexes with `system: name is by_id or by_creation_time`) |
| `listDocuments` | a scan of the chosen index at a snapshot, plus a cursor = the last index key; needs admin-only access to `Tx` and core's `paginate` (M) |
| `listFunctions` | the `Functions` registry (needs a read-only listing method) |
| `listLogs` / `watchLogs` | the server's `logs` module (M) — until it exists the real source returns an empty page |

### 5.3 Why an interface in the dashboard package, not a wire protocol

The dashboard must run against a cloud control plane whose transport we do not know yet. An interface
lets each host bring its own implementation; the wire format of the self-hosted admin API is a separate,
server-side decision (§5.7). The alternative — the dashboard speaking HTTP to a fixed admin API — was
rejected: it would force the cloud to imitate the self-hosted server's endpoints.

### 5.4 Versioning

The contract changes additively while bunvex is pre-alpha; a removal or a semantic change is a breaking
change of `@bunvex/dashboard`, recorded in a changeset and in an amendment to this section.

### 5.5 `MockDataSource`

- Deterministic: built from a seed (`new MockDataSource({ seed, latencyMs, failRate })`), so tests and
  screenshots are stable. Fixtures: a few tables (`tasks`, `messages`, `users`) with ~1 000 documents in
  the largest, a dozen functions of all kinds, a few thousand log lines.
- Implements every semantic of §5.1 (cursor validity, aborts, `not_found`, watchers that never fire
  synchronously) — its own test suite checks them, and that suite is **reusable**: exported as
  `describeDataSourceContract(name, make)` from `@bunvex/dashboard/contract`, so the real implementation
  can run the same assertions against a live server (the conformance-suite idea of PERSIST-01, in small).
  It needs one table with at least 3 documents; each case was checked to fail on a sabotaged mock
  (cursor not bound to its query, a synchronous watcher, a page that skips an item).
- Cursors are **index keys, not offsets** (the last key returned, bound to its query): a document
  inserted between two pages neither appears twice nor pushes another out; a finished walk's cursor
  picks up documents appended later.
- Beyond the contract, for the dev app and tests: `insertDocument(table, fields)` and `logSomething()`.
- `latencyMs` and `failRate` exercise loading and error states by hand in `apps/dashboard`.

### 5.6 Room for later (not in v0)

> All of these exist now, with more (§0 lists the contract as it stands).

Optional methods, detected with `typeof source.x === "function"`, so older sources stay valid:
`runFunction(path, args)`, `insertDocument` / `patchDocument` / `deleteDocuments`, `watchTable(table)`
(live document lists), `getSchema()` (declared validators once `@bunvex/values` has them).

### 5.7 The self-hosted HTTP implementation (proposed split)

The server session defines the admin endpoints and their messages (in `@bunvex/protocol`, next to the
client messages; protected by the admin key). A `createHttpDataSource({ url, adminKey })` then lives in
`@bunvex/dashboard/http` and implements this contract over them — which would add
`dashboard → protocol` to the dependency rules (protocol has no dependency and is browser-safe). Until
then `@bunvex/dashboard` depends on `@bunvex/ui` only.

## 6. Dependency rules

Added to ARCHITECTURE.md and to `scripts/check-deps.ts`:

```
ui          ──► (no @bunvex package)
dashboard   ──► ui                        (later: protocol, for the HTTP source — §5.7)
apps/dashboard ──► dashboard, ui
```

- `ui` and `dashboard` never import `@bunvex/core`, `@bunvex/server`, or any package that pulls the engine;
  the existing check already rejects any `@bunvex/*` import not listed, so this follows from the table.
- No existing package may import `ui` or `dashboard` (they are absent from every other rule).
- `react` and `react-dom` are **peer dependencies** of `ui` and `dashboard` (one React per host); the app
  depends on them directly.

## 7. Testing

| layer | what | how |
|---|---|---|
| tokens | every text pair ≥ 4.5:1, focus ring and control borders ≥ 3:1, in both themes | pure function over `globals.css` values (`lib/contrast.ts`), `bun test` |
| ui components | our own components and every shadcn component we edit: roles, keyboard (Tab, arrows, Esc), `render` composition, dark class | Testing Library + user-event on happy-dom |
| accessibility | `axe-core` on each screen with mock data (colour-contrast rule off — happy-dom has no layout; the token test covers it) | `bun test` |
| contract | §5.1 semantics against `MockDataSource` via `describeDataSourceContract` | `bun test`; later reused by the server session against the real source |
| data hooks | abort on deps change, pagination accumulation and reset, watcher cleanup | Testing Library `renderHook` |
| screens | overview renders stats and updates on watch; documents paginate (load more until `isDone`); errors render with retry; routes round-trip through `parseRoute`/`formatRoute` | Testing Library |
| app | `vite build` of `apps/dashboard` succeeds | part of `bun run check` (§8) |

**DOM without polluting the other tests.** React DOM, Base UI and Testing Library read `window` /
`document` when they are first evaluated — and Bun evaluates their CommonJS modules before the body of any
ES module importing them, so a DOM registered from inside a test file comes too late (tried: `screen`
binds to no document). Registering and unregistering per file, or `--isolate`, does not change that
ordering. So each UI package **preloads** its DOM (`packages/{ui,dashboard}/bunfig.toml` →
`test/dom.ts`) and runs its tests **in its own process**; the root `bunfig.toml` ignores those paths, and
the root `test` script runs the root suite, then each UI package's suite. The engine and server tests
never see happy-dom's `fetch` / `WebSocket` / `Request`.

End-to-end browser tests (Playwright) are out of v0.

## 8. Changes outside the three workspaces (approved, §10)

The request limits shared-file changes to ARCHITECTURE.md and `scripts/check-deps.ts`. These additional
edits are unavoidable for `bun run check` to cover the new code; each is the minimum found:

| file | change | why it cannot be avoided |
|---|---|---|
| `package.json` | `workspaces` += `"apps/*"`; `typecheck` += `&& tsc -p packages/ui && tsc -p packages/dashboard && tsc -p apps/dashboard`; `test` += the UI packages' own runs (§7); `check` += `&& bun run build:dashboard` | the app is not a workspace otherwise; the UI needs its own compiler options (below); the build proves the app still bundles |
| `tsconfig.json` | `exclude`: `packages/ui`, `packages/dashboard` | the root config (`lib: ESNext`, no `jsx`) includes `packages/*/src`; `.tsx` files fail there. Adding `DOM` + `jsx` to the root instead would give the server and engine DOM types (`WebSocket`, `fetch` overloads) they must not see |
| `biome.json` | `css.parser.tailwindDirectives: true` | Biome's CSS parser rejects `@theme`, `@custom-variant`, `@source`, `@apply` otherwise |
| `scripts/check-deps.ts` | besides the two rules: also scan `apps/*` (it scanned `packages/` only), and see side-effect imports (`import "x"`), which the regex missed | otherwise `apps/dashboard`'s imports go unchecked, and `import "@bunvex/core"` passed anywhere |
| `bunfig.toml` (new) | `[test] pathIgnorePatterns` for the UI packages | their tests need a preloaded DOM and run in their own process (§7) |
| `bun.lock` | new dependencies | follows from any `bun add` |
| `.github/workflows/ci.yml` | a `bun run build:dashboard` step after the tests | CI runs the steps separately, not `check` (asked for by the owner) |

## 9. Slices

> Replanned in §12.5 after the Convex study; every slice is done. Kept as the v1 record.

Each one ends with `bun run check` green and is shown before the next.

1. **Scaffold**: the three workspaces, configs of §8, `check-deps` rules, ARCHITECTURE.md lines, one
   trivial test per package; `vite build` works.
2. **`@bunvex/ui` foundation**: `components.json` (base-lyra), tokens light/dark, `cn`, contrast test,
   `ThemeProvider`, and the first components via `shadcn add` (button, badge, card, separator, skeleton,
   tooltip); DOM test harness (`test/dom.ts`).
3. **Contract + mock**: `data-source.ts`, `MockDataSource`, `describeDataSourceContract`.
4. **Shell + overview**: sidebar, header (deployment, theme toggle), routes, overview with live stats.
5. **Tables and documents**: table list, document list with index/order and cursor pagination, document
   view (JSON).
6. **Functions and logs**: function list grouped by module, logs with filters, paging back and live tail.
7. **Accessibility pass**: axe on every screen, keyboard walk-through, reduced motion, README of each
   package.

## 10. Decisions (29 Sep 2026)

1. The shared-file changes of §8 are **approved** as listed.
2. shadcn style: **Lyra** (`base-lyra`).
3. §5.7 **agreed**: the admin messages live in `@bunvex/protocol` (server session); `createHttpDataSource`
   lives in `@bunvex/dashboard/http`, adding `dashboard → protocol` when it lands.
4. `@bunvex/ui` and `@bunvex/dashboard` stay **`private: true`**.

## 11. Amendment — the TanStack stack (29 Sep 2026)

The owner asked for the TanStack ecosystem to be in place before the data screens: Router, Query, Table and
Virtual. Versions checked on npm and the current docs (context7) the same day:

| package | version | where | for |
|---|---|---|---|
| `@tanstack/react-router` | 1.170 | dashboard | routes, search params, loaders |
| `@tanstack/react-query` | 5.104 | dashboard | the cache every read goes through |
| `@tanstack/react-router-devtools`, `@tanstack/react-query-devtools` | 1.167, 5.104 | dashboard, lazy | `<Dashboard devtools>`; the app turns them on in development (a 0.3 kB no-op chunk in production) |
| `@tanstack/react-table` | **9.2** (a new major: `useTable`, required `features`, `table.FlexRender`) | ui | `DataTable` |
| `@tanstack/react-virtual` | 3.14 | ui | `DataTable` rows |

The router's file-based mode (`@tanstack/router-plugin`) is not used: it generates the route tree inside the
app, and the screens live in the package.

### 11.1 Layout changes

```
packages/dashboard/src/
├── router.tsx          routes (code-based), search validation, createDashboardRouter, DashLink, RouteError
├── dashboard.tsx       <Dashboard>: QueryClient, router over the host's history, devtools
├── devtools.tsx        the two devtools, loaded on demand
├── data/queries.ts     queryOptions / infiniteQueryOptions over the contract, dashboardKeys
├── data/live.ts        useWatch; useStatsHistory (watchStats → the query cache)
└── (routes.ts and data/hooks.ts are gone)
packages/ui/src/components/data-table.tsx   DataTable (Table v9 + Virtual)
```

Exports of `@bunvex/dashboard` now: `Dashboard`, `DashboardProps`, `createDashboardQueryClient`,
`dashboardKeys`, `createDashboardRouter`, `DashboardRouter`, `DashboardRouterContext`, `DocumentsSearch`,
`LogsSearch`, and the contract. `DashboardRoute`, `parseRoute`, `formatRoute`, `onNavigate` and `hrefFor`
are removed — the router owns the URL.

### 11.2 Routing

- **The router lives in the package; the host picks the history.** `<Dashboard history={…} basepath={…}>`:
  the browser history in `apps/dashboard` (plain paths, as Convex's dashboard; ~~`createHashHistory()`~~
  until 30 Sep 2026, when the owner dropped the `/#/` addresses), the browser history under a
  `basepath` in a control plane (`/projects/p1/dashboard`), `createMemoryHistory()` in tests.
- Routes: today's list is in §0 (the v1 routes `/tables…` became `/database/$table`, §12.6). Search params
  are validated by hand (`validateTableSearch`, `validateLogsSearch`, …): an invalid option is dropped,
  not an error — a hand-edited URL still opens. Every validator returns all its keys, `undefined` when
  invalid, because TanStack Router keeps a raw param a validator leaves out (#47).
- **No global `Register`.** TanStack Router's type safety normally comes from declaring the app's router in
  `interface Register`; a package that did so would collide with a host that has its own router. Links
  are typed against `DashboardRouter` explicitly: `DashLink` takes `link: ValidateLinkOptions<DashboardRouter,
  …>` — checked: an unknown path, a missing `$table` param and `order: "up"` are compile errors.
- Every route has a loader that fills the query cache (`ensureQueryData` / `ensureInfiniteQueryData`); a
  failing loader renders `RouteError` (the `ErrorState` with a retry that resets and invalidates) **inside the
  shell** (`defaultErrorComponent`), so the navigation stays usable. Unknown paths render "Page not found"
  inside the shell.
- The active link is styled from the `aria-current="page"` the router's `Link` sets — its `activeProps`
  classes are concatenated without `tailwind-merge` and lost to `border-transparent` (found in the
  browser).
- Focus moves to `<main>` after a navigation that changes the path (`router.subscribe("onResolved")`), not
  on a search-only change (a filter, a sort) and not on the first load.
- **For a future control plane with its own TanStack Router:** it mounts `<Dashboard>` under a splat route
  with the browser history and a `basepath`. Two routers then share the history; that composition is
  untested until the control plane exists — the alternative, exporting the route tree for the host to
  graft into its own, is recorded here as the fallback.

### 11.3 Data

- **Every read is a query-options factory** over the contract (`data/queries.ts`): the loader and the
  component share one cache entry. Paginated reads are `infiniteQueryOptions` whose page param is the
  contract's cursor (`initialPageParam: null`, `getNextPageParam: p => p.isDone ? undefined :
  p.continueCursor`).
- Keys are `["bunvex", scope, …]`. `<Dashboard queryClient={…} scope={…}>` lets a host share its client
  between several dashboards (one per deployment); otherwise the dashboard creates its own
  (`createDashboardQueryClient`: `staleTime` 5 s, one retry).
- **Reactive data goes into the same cache**: `useStatsHistory` feeds `watchStats` samples into
  `["bunvex", scope, "stats", "history"]` with `setQueryData`, so leaving the overview and coming back keeps
  the last minute (tested). The test found a bug on the way: a re-subscribing watcher's first sample
  equals the last one kept, and `appendSample` took it for a server restart; a restart is now only a
  commit clock that goes back, and a sample no newer than the last is dropped.
- The data source is read once per `<Dashboard>` (a new `key` switches it); the router context carries
  `{ queryClient, scope: { source, scope } }`.

### 11.4 `DataTable` (`@bunvex/ui/components/data-table`)

- Table v9 with a fixed `dataTableFeatures` (none yet; sorting and sizing are added when a screen needs
  them), columns built with `dataTableColumns<T>()`, `useTable(options, () => null)` so the table's own
  state never re-renders the list.
- Rows virtualized at a fixed height; it stays a real `<table>` with a caption naming both the table and
  its scroll region, `aria-rowcount` / `aria-rowindex` for the rows not rendered, spacer rows hidden.
- `onEndReached` (within `endThreshold` rows of the end) is how a screen asks its infinite query for the
  next page; `onRowActivate` by click or Enter.
- Tests: happy-dom has no layout, so every `offsetHeight` is 0 and the virtualizer renders nothing; the
  DataTable test gives its scroll container a 360 × 800 px size for that file only.

### 11.5 Dependency rules

Unchanged between bunvex packages (`dashboard → ui`, `ui → none`). The new external dependencies are
declared by the packages that import them, as `check-deps` requires.


## 12. Amendment — the dashboard after studying Convex's (29 Sep 2026)

> **Status: decided** (§12.6, the same day). The owner asked for the structure of Convex's own dashboard
> to be studied before the data screens go further; the study is
> [STUDY-12](../study/STUDY-12-dashboard.md) (it was a research note; moved to `docs/study/` when that convention landed). This section records what changes.
> It supersedes the "tables" screens of §11 (list at `/tables`, documents at `/tables/$table`, a document at
> `/tables/$table/$id`), which were built but not merged.

### 12.1 What we keep, and what we do better than the reference

- **The split** is Convex's: shared screens in `@bunvex/dashboard`, thin hosts. Convex consumes its shared
  package through tsconfig aliases and lets it know its hosts; ours goes through `exports` and the
  dependency rules forbid the reverse edge — keep it.
- **The seam** stays the `DashboardDataSource` interface plus a few `<Dashboard>` props, not a 60-member
  context of hooks. Differences between hosts are **capabilities of the source** (§12.3) and **prop slots**,
  never `isSelfHosted` branches.
- **The design system** stays `@bunvex/ui` (Convex has the same: a separate package, semantic tokens, a
  `.dark` class, an injected `Link`).

### 12.2 Navigation

> Superseded by §23.2 (labelled groups, more screens). Kept as the record.

Health · **Database** · Schema · Functions · Logs, then Settings. (Files, Schedules and History come with the
server features they show.) The overview is renamed **Health**; its commit clock stays and gains the
function metrics when the server has them.

### 12.3 The Database screen

One screen, as Convex's "Data" (named **Database** here):

```
/database/$table?filter=<base64url JSON>&doc=<id>&panel=schema|indexes
DatabaseScreen
├─ TablesSidebar      table search, one link per table (+ count), "not in schema" marker
└─ TableView  key=table
   ├─ Toolbar         table name · N documents · actions (gated by capabilities) · menu: schema, indexes
   ├─ FilterBar       index + index clauses (prefix, trailing range) · field filters · order · columns
   ├─ DataTable       virtualized, columns = observed ∪ schema fields (_id first, _creationTime last),
   │                  resizable / reorderable / hideable, per-table settings in localStorage
   └─ SidePanel       ONE at a time: document (viewer, later editor) · schema · indexes
```

- `/database` goes to the first table; an unknown table says so inside the screen, with the sidebar.
- **URL state**: the table (path), the filter expression (one `filter` search param), the open document
  and the open panel. A link to one document is `/database/tasks?doc=<id>`. Filters of each table are
  remembered in memory when switching tables. Column widths, order and hidden columns live in
  localStorage per deployment `scope` + table.
- **Filter model**: a pure module (`filters.ts`) that knows the index rules and offers only valid next
  moves; the UI keeps a draft and applies it when valid (typed values debounced).
- **Live data**: the documents and the count update while the screen is open (§12.4, `watchTable`),
  keeping the scroll position; the previous rows stay visible while a new filter loads.
- **Editing** (insert, patch a field, replace, delete selected, clear table) comes in a later slice,
  behind the `writeData` capability, with confirmation for destructive actions.

### 12.4 Contract v2 (`@bunvex/dashboard/data-source`)

Additive where possible; the removals are marked.

```ts
// Values: JSON, plus encodings for what JSON cannot carry; a missing field is not null.
type Value = Json | { $integer: string /* base64 LE int64 */ } | { $bytes: string /* base64 */ };

// Filters — one serializable expression, validated by the source.
type FieldOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "anyOf" | "noneOf" | "type" | "notype";
type FieldFilter = { id: string; field: string; op: FieldOp; value?: Value | Value[] | ValueType; enabled: boolean };
type IndexFilter = {
  name: string;
  eq: { value: Value; enabled: boolean }[];                      // a prefix of the index fields
  range?: { lower?: { op: "gt" | "gte"; value: Value }; upper?: { op: "lt" | "lte"; value: Value } };
};
type FilterExpression = { index?: IndexFilter; clauses: FieldFilter[]; order: "asc" | "desc" };

type DocumentQuery = PageRequest & { table: string; filter?: FilterExpression };  // replaces index/order
// An invalid expression → DataSourceError("invalid_request", …, { clause?: string /* FieldFilter.id */ })

interface DashboardDataSource {
  // … v1 methods, with listDocuments taking the new DocumentQuery …
  getCapabilities(opts?): Promise<Capabilities>;
  getSchema(opts?): Promise<SchemaInfo>;              // declared tables, document validators (when
                                                      // @bunvex/values has them), indexes with state
  watchTable(table, onChange: (e: { count?: number }) => void, onError): Unsubscribe;
  // optional, present when capabilities.writeData:
  insertDocuments?(table, docs: Record<string, Value>[], opts?): Promise<string[]>;  // all or nothing
  patchDocuments?(table, ids: string[], fields: Record<string, Value | { $unset: true }>, opts?): Promise<void>;
  replaceDocument?(table, id, doc, opts?): Promise<void>;
  deleteDocuments?(table, ids: string[], opts?): Promise<void>;
  clearTable?(table, opts?): Promise<{ deleted: number }>;
}

type Capabilities = { operations: ("viewData" | "writeData" | "viewLogs" | "viewMetrics" | "runFunctions")[];
                      readOnly: boolean };
type IndexInfo = { name: string; fields: string[]; system: boolean; state: "ready" | "backfilling";
                   progress?: { indexed: number; total?: number } };
```

- **Reactivity** is `watchTable`: "this table changed (and its count is now n)". The dashboard then
  refreshes the pages it has loaded. It is simpler for the server than reactive pages (Convex subscribes to
  each page's key range) and enough for a dashboard; reactive pages can come later without changing the
  screen.
- **Where it maps on the server** (for the server session; see research §6): capabilities ↔ a
  `check_admin_key`-style endpoint; `listDocuments` ↔ `paginatedTableDocuments` (index range, then field
  filters while scanning, bounded reads per page, `_id eq` as a point lookup); `watchTable` ↔ a
  subscription on the table's write set; the writes ↔ `addDocument` / `patchDocumentsFields` /
  `replaceDocument` / `deleteDocuments` / `clearTablePage`, each with an audit entry.
- The mock implements all of it, and `describeDataSourceContract` grows to cover filters, `watchTable`,
  and — when a source declares `writeData` — the writes.

### 12.5 Slices, replanned

> All done; the amendments §13–§25 went further. Kept as the record.

5. **Contract v2 + mock + contract suite** (filters, schema, capabilities, watchTable; writes in the mock).
6. **Database screen, read-only**: sidebar, table view, filter bar with the filter model, side panel with the
   document and schema/indexes, URL state, live updates.
7. **Editing** behind `writeData`.
8. **Functions and Logs**, then **Health** metrics — each when the server has the data.

### 12.5.1 Slice 5, as built

- `data-source.ts` is the v2 contract above. Value order and filter meaning live in a pure module,
  `filters.ts` (`valueType`, `compareValues`, int64 encode/decode, `matchesClause`, `validateFilter`,
  `matchesFilter`, `canonicalFilter` — what a cursor is bound to: disabled clauses and clause ids do not
  change the query). Its tests pin the semantics by hand, because…
- …the contract suite uses `filters.ts` as its **oracle**: for a dozen expressions (every operator, unset
  fields, a disabled clause, an index prefix, a range) a source must return exactly the documents the oracle
  selects, in index order, across pages. Against the mock this mostly checks pagination and cursors (the
  mock evaluates with the same module); against a server it checks the semantics.
- **Write tests are opt-in** (`{ writes: { table, clear? } }`): the suite may be pointed at a live
  deployment, and must never touch a table nobody named.
- The mock: int64 and bytes values, a table not in the schema (`imports`), a backfilling index
  (`tasks.by_text`), capabilities (read-only credentials are refused with `unauthorized`), bounded
  all-or-nothing writes, `watchTable`, and `liveWritesMs` (the dev app inserts or deletes a task every 3 s).
- Checked by sabotage: the mock ignoring field clauses, a non-atomic insert, and `neq` excluding unset
  fields each turn a test red.
- Routes: `/database` (redirects to the first table) and `/database/$table` (a placeholder until slice 6);
  the overview is titled **Health**. The v1 tables screens were removed.

### 12.5.2 Slice 6, as built — the Database screen, read-only

- `src/database/`: `screen.tsx` (sidebar + table view), `tables-sidebar.tsx` (search, sizes, "*" for tables
  not in the schema; a picker below md), `filter-bar.tsx`, `side-panel.tsx` (document · schema · indexes,
  one at a time, Escape closes, covers the table below lg), `live.ts` (`watchTable` → invalidate the
  table's documents, the open document and the table list), and three pure modules with their own tests:
  `filter-url.ts` (base64url JSON in the `filter` param, read defensively: an unreadable link opens
  unfiltered and says so), `value-input.ts` (`42`, `true`, `"quoted"`, `[1,2]`, `42n` for int64, a bare word
  is text), `filter-model.ts` (the draft and its valid moves; an empty range bound is no bound).
- The bar applies 350 ms after the last change, only when the draft is valid for the model and for the
  table's indexes (`validateFilter`); the source's rejection is shown against the clause it names. The
  creation-time index offers its range only (nobody looks for one exact timestamp).
- The previous rows stay (dimmed) while a new filter loads; a new filter scrolls back to the top.
- `DataTable` gained **top-row anchoring**: rows inserted above the view (a live, newest-first list) keep
  the row at the top in place instead of pushing it down.
- The QueryClient retries only `unavailable`, once: a rejected filter used to wait for a pointless retry.
- Tests: the screen end to end on the mock (redirect, sidebar, columns, building a filter, a filtered
  link, a rejected and an unreadable filter, the document / schema / indexes panels, live insertion and
  count, an unknown table), axe on each. Sabotage: the live invalidation and the filter's apply each turn a
  test red. (A first sabotage run "passed" because the formatter had re-indented the target line and the
  edit never applied — sabotages now print how many edits they made.)
- **Left for the UI review the owner announced**: the narrow table and the column settings were done in
  §12.5.6; the loader still keeps the previous table on screen for the ~250 ms it takes to load the next
  one.

### 12.5.3 The data grid and in-place editing (slice 6, continued)

- `DataTable` takes `grid`: the WAI-ARIA data grid pattern. One cell is in the tab order (roving
  tabindex); arrows, Home/End (row), Ctrl/Cmd+Home/End (grid), PageUp/PageDown (a screenful) move, and the
  virtual list scrolls along (scrollTop set directly, then a scroll event: it works in browsers and in
  happy-dom). The focused cell is kept by **row id**, so live rows arriving above it do not move it. Enter
  or F2 or a double-click edits through the caller's `renderEditor`, or calls `onCellActivate` on a cell
  that cannot be edited; `done("stay" | "right" | "cancel")` ends the edit and puts the focus back.
  Clicking another cell during an edit leaves it unsaved. Cells say `aria-readonly` when they cannot be
  edited.
- The Database screen's editor (`cell-editor.tsx`): the value in the filter bar's syntax (`42`, `true`,
  `"text"`, `[1, 2]`, `42n`); an empty box removes the field (`$unset`). Enter saves and stays, Tab saves
  and moves right, Escape cancels (without closing the side panel). A value that does not parse, or that
  the source refuses, keeps the editor open with the reason. A save goes through `patchDocuments`, then
  the new value is written into the cached pages and document; the live refresh confirms it.
- Editable: any non-system field, when the capabilities grant `writeData`, the credential is not read-only
  and the source has `patchDocuments`; otherwise the screen says "Read-only". `_id` and `_creationTime`
  are never edited: Enter on them opens the document.
- Checked by sabotage: not refocusing after an edit, not scrolling to the focused row, and a save that
  skips the source each turn tests red.

### 12.5.4 Showing what changed (live)

Studied in Convex (`DataCell/utils/useTrackCellChanges.ts`, `DataRow.tsx`, `Table.tsx`): a cell compares its
value with the previous render's and flashes for 1 s; a new row flashes when its `_creationTime` is less than
1 s old; when rows arrive above a scrolled view, the header's bottom edge flashes. All on the client, from
the reactive query's new results. Ours (`DataTable highlightChanges`, pure diff in
`@bunvex/ui/lib/change-tracking`), with three differences:

- compared by **row id**, not position: scrolling, the next page or a new filter (`resetKey`) flash
  nothing;
- a row is "added" when it arrives **between or above rows already shown** — no dependence on the
  viewer's clock (Convex compares `_creationTime` with `Date.now()`, which a skewed clock breaks);
- **reduced motion** keeps a steady tint for the same time instead of no mark at all (our global rule
  cuts animations short); a polite live region says "2 documents changed, 1 document added", at most once
  every 5 s.

Whoever made the change — another tab, a function, this editor — it flashes. The colour is a light **blue**
(`--highlight`, from `--info`; contrast-tested in both themes), and so is the header edge: in bunvex blue
already means "live" (the commit pulse, the focus ring), while yellow would read as our `--warning` (the
owner chose blue over Convex's yellow). The table list shows a table icon (lucide `table-2`),
which Convex's does not.

### 12.5.5 Selecting, adding, deleting, clearing

- `DataTable selection`: a checkbox column in front that is a grid column like the others (Space or Enter
  toggles, Shift for a range since the last toggle; Shift-click too); the header's checkbox selects every
  loaded row and shows a dash for "some" (the generated shadcn checkbox drew a tick for that state — fixed
  in `checkbox.tsx`). Controlled by the screen: a new filter clears it, rows that left the list leave it.
- **Add documents**: a side panel (`panel=add`) with a JSON editor — one object or a list — checked as you
  type (no `_` fields; the reason shows under the editor), inserted all or nothing; the draft survives
  closing the panel; Ctrl+Enter adds.
- **Delete (n)**: shown with a selection, behind a confirmation naming the count and that it cannot be
  undone; batches of 4 096 ids (the contract's bound).
- **Clear table…**: in the table's "More" menu, behind a confirmation that asks for the table's name.
- Each action is shown only when the capabilities grant `writeData`, the credential is not read-only and
  the source has the method; its outcome is said once (`role="status"`, or `alert` when it failed).
- **Focus**: when the focused row disappears (deleted here, or live), `DataTable` puts the focus on the
  neighbouring row's cell instead of losing it to `<body>`. After Delete, the button that opened the dialog
  is gone with the selection: the dialog does not restore focus (`finalFocus={false}`) and the screen asks
  the grid for it (`DataTable focusRequest`). Checked in a browser: Base UI hides the page behind a modal
  with `aria-hidden` and traps the focus (no `inert`), so axe is run on the dialog while it is open.
- ~~Known, left: in `apps/dashboard`, the dev-only query params (`?writes=…`) leak into the hash route's
  search.~~ Fixed: TanStack's `createHashHistory` reads `location.search` as the route's search, so the
  host now reads the mock's knobs once, keeps them for the tab (sessionStorage) and takes them out of
  the address (`apps/dashboard/src/knobs.ts`). Since the move to plain paths (30 Sep 2026) the knobs share
  the query with the route's own search, so only their three keys are taken out.

### 12.5.6 Columns and room for the table (its side-panel rule superseded by §22.1)

- **Columns, per table, kept in this browser** (`localStorage`, per deployment `scope` and table): the
  order and hidden columns from a **Columns** side panel (a checkbox and move up / move down per column,
  Reset); widths from a **resize handle** on each header's edge. `DataTable` takes `columnState` +
  `onColumnStateChange` and applies them before the table model (order via `mergeColumnOrder` — a field
  that appears later lands after its natural predecessor, so a saved order survives it and `_creationTime`
  stays last — hidden ones dropped, widths on a fixed-layout `<colgroup>`). The `_id` column starts at
  260 px, others at 180. Reordering by dragging headers (as Convex) is not built; the panel does it from the
  keyboard.
- **`ResizeHandle`** (`@bunvex/ui/components/resize-handle`): the WAI-ARIA window-splitter pattern — a
  focusable `separator` with its value; drag, or Left/Right (16 px, Shift 64), Enter or a double-click for
  the default. Used by the column headers and by the table list.
- **Room**: the side panel is a drawer over the table below 1 536 px (`2xl`) and beside it above, so it no
  longer squeezes the table; the table list is **resizable** from its edge (160–480 px, kept in this
  browser). A collapsible table list was built first and dropped at the owner's request in favour of the
  resizable one.
- Checked in a browser at 1 400 and 1 600 px, and by dragging both handles (the widths are saved).

### 12.5.7 Values as JavaScript literals, in a code editor

STUDY-12 D9 was decided "match Convex" (30 Sep 2026): the syntax of our own (a bare word is text,
comma lists) is gone.

- **`literal.ts`** (dashboard): a hand-written parser and formatter for JavaScript literals — never
  evaluated. Objects with bare or quoted keys, arrays, strings in either quote, numbers, `10n` for an int64
  (range-checked), `Bytes("base64")`, `true`/`false`/`null`, comments and trailing commas. `undefined`
  means "no field": it removes a field in a patch, drops a key in an object and is refused in a list;
  `NaN`/`Infinity` are refused. Every error carries the offset where it is. JSON is a subset.
- **`CodeEditor`** (`@bunvex/ui/components/code-editor`): Monaco (`monaco-editor` 0.57 through
  `@monaco-editor/react`, **bundled, no CDN**, its worker built by Vite) loaded on demand, with a plain
  input/textarea that has the same keys until it loads and in tests (`setCodeEditorImplementation("plain")`).
  One line (Enter submits, Escape cancels, Tab leaves the field or calls `onTab`) or several (Ctrl+Enter or
  Cmd+Enter submits). A Monarch language `bunvex-literal`, light and dark themes built from the design
  tokens (redefined when the theme changes), the error underlined from its offset. Only the editor
  contributions a value box needs are imported. Monaco is ~3.2 MB, in its own chunk, fetched when the
  Database screen mounts (`preloadCodeEditor`), not with the app.
- **Where**: every filter value (index equals, range bounds, clause values; a list without brackets is read
  as one), a cell (one line for a scalar; a multi-line popover for an object or a list, opening leftwards
  near the grid's edge), **Add documents**, and a new **Edit** on the document panel — the fields without
  `_id`/`_creationTime`, saved whole with `replaceDocument` (shown when the source has it and the
  credential can write).
- Checked in a browser: both themes, typing and auto-closing, both save shortcuts, an error underlined
  in a cell, the object popover at the right edge, no request leaves localhost.

### 12.5.8 A cell's context menu and shortcuts

As in Convex (STUDY-12 §1.4.1).

- **`DataTable`**: `grid.cellMenu({ row, columnId, edit })` returns the items of a cell's context menu
  (DropdownMenu items); the grid opens it on a right-click (at the pointer), Shift+F10, the Menu key or
  Ctrl/Cmd+Enter (at the cell), and gives the focus back to the cell when it closes. `grid.onCellKey`
  lets the caller take keys on a focused cell before the grid's own. `DropdownMenuContent` takes an
  `anchor` (a virtual element here). Base UI closes a trigger-less menu when its submenu opens ("a
  sibling opened"); the grid ignores that reason.
- **Database**: **Filter by `<field>`** ▸ the operators that make sense for the value (as Convex's
  `showFilter`), added to the applied filter at once; **Copy `<field>`** (Ctrl/Cmd+C: text as it is,
  anything else as a literal); **Edit `<field>`** (Enter); **View document** (Shift+Space); **Copy
  document** (Ctrl/Cmd+Shift+C); **Edit document** (Shift+Enter: the side panel opens in its editor).
  Edit items are disabled without the grant. A copy is announced ("Copied email.").
- The side panel's document view is keyed by the id, so another document never opens in the last one's
  editor.

### 12.5.9 Accessibility pass (slice 7)

- **axe on every screen state** (`packages/dashboard/test/a11y.test.tsx`): the overview, a table, each
  side panel, a table not in the schema, an unknown table, Functions, Logs. Colour contrast, which the
  test DOM cannot compute, was run with axe in Chrome on the same states in both themes: one failure, a
  select's placeholder on its dark hover surface (4.29:1). Dark `--muted-foreground` went from
  `oklch(0.72 0 0)` to `oklch(0.74 0 0)` (4.66:1), and the token test gained that pair
  (`input/50@card`, dark only).
- **Keyboard walk-through** (same file): skip link → main, sidebar → Database, table list → a table, one
  tab stop into the grid, Enter on `_id` opens the document, Escape closes it and returns the focus to
  the same cell. It found a bug: the first Tab into the grid focused the default cell without marking it
  current, so no focus ring showed (WCAG 2.4.7); fixed in `DataTable`.
- **Reduced motion**: the global rule in `globals.css` (animations and transitions to 0.01 ms) is now
  under test; the grid's highlight already falls back to a steady tint (STUDY-12 D6).
- READMEs for `@bunvex/ui`, `@bunvex/dashboard` and `apps/dashboard`.

### 12.5.10 Smoke tests in a real browser

The owner decided (29 Sep 2026): Playwright, with a CI job that is not a required check until it has
proved stable.

- `apps/dashboard/e2e/dashboard.e2e.ts`, run by `bun run e2e` (root or `apps/dashboard`): builds the app,
  serves it with `vite preview`, and drives Chromium through `playwright-core` (pinned, 1.63.0) —
  the system Chrome locally, Playwright's Chromium in CI (`E2E_BROWSER=chromium`, job **e2e ·
  dashboard in Chromium**).
- What it covers, which the DOM tests cannot: Monaco loads from the app with no request elsewhere and
  its worker is bundled; a cell edited in Monaco (Enter saves, Tab saves and moves right, Escape leaves
  it); the object editor stays inside the grid; a document typed fast and saved with Ctrl+Enter is saved
  exactly; the theme toggle switches Monaco's theme too; reduced motion cuts transitions; axe with
  colour contrast on the main screens in both themes.
- It found a bug on its first run: `CodeEditor` controlled Monaco through `value`, and typing faster than
  React re-rendered lost keystrokes — a document was saved truncated. Fixed in #22 (Monaco holds the
  text; `value` is written back only when it changes from outside; Enter / Tab / Ctrl+Enter render the
  last keystroke before calling the handler).
- Selecting everything and typing a quote wraps the selection in quotes (Monaco's `autoSurround`), as in
  Convex's editor, which keeps Monaco's defaults; kept.

### 12.6 Decisions (29 Sep 2026)

1. The screen is named **Database**, at **`/database/$table`**.
2. Live data through **`watchTable`** + refreshing the loaded pages.
3. ~~Editing after the read-only screen (slice 7).~~ **Revised the same day**: the owner wanted the table to
   work like Convex's data grid — move between cells with the keyboard, Enter to edit, Enter to save and keep
   going — so in-place editing joined slice 6 (§12.5.3); then the owner asked to finish the Database screen in
   the same pull request, so inserting, deleting and clearing joined it too (§12.5.5).

## 13. Amendment — Logs, Functions and the function runner (30 Sep 2026)

After STUDY-12 §7. The owner decided on 29 Sep 2026: Functions without metrics for now (L1), log filters on
the client as in Convex (L2), and an optional `runFunction` in the contract with a Run panel (L3).

### 13.1 The Logs screen

> The layout, the filters' form, the toolbar and the details' header are superseded by §22.4 (the Logs
> redesign, 1 Oct 2026); the lines, paging, pausing, clearing, the URL and browser view and the details'
> content below still hold.

- **`/logs`** (`src/logs/`): every function's log lines, newest first, one row per line: time (with ms),
  the request id's first four characters, the execution's outcome and duration on its last line, level,
  the function (its kind's letter and path) and the message; errors and failed executions in the
  destructive colour.
- **Lines** (`useLogLines`): the newest `listLogs` page (200 lines; the route loader fetches it), then
  whatever `watchLogs` delivers, merged by id, at most 10 000 (as Convex). Older pages load at the end of
  the list (STUDY-12 L4, decided: keep the paging). **Pause** holds new lines and counts them ("Resume (3 new)"); resuming shows
  them. **Clear** hides every loaded line; "Show N cleared" brings them back.
- **Filters on the client** (`log-filter.ts`): functions and types (success, failure, debug, info, warn,
  error — a line passes on its level, or on its execution's outcome) as multi-selects, and a text box
  (200 ms after the last keystroke) matching the function path, the message or a request id. **In the URL
  and in this browser** (STUDY-12 L7, the owner's call): `?function=a:b,c:d&type=failure,error&q=text`
  (comma lists; `none` for an empty choice), validated by hand like the table's search; every change is
  also kept per deployment scope (`bunvex:logs:<scope>`), and the screen opened without filters starts
  from that view and writes it into the address. Picking functions or types is a history step (Back
  undoes it); typing replaces the address.
- **Details** (`LogDetails`, in the shared `shell/panel.tsx`): the activated line — function, request id
  (copy), the execution's outcome and duration, the message, and every loaded line of the same request —
  with **Filter by this request**. The list is the data grid: arrows move between lines, a click or Enter
  opens the details, and while they are open they follow the current line (Convex's Up / Down in its
  drilldown).
- **`DataTable`** gained two grid options for lists like this one: `activateOnClick` (a click on a cell
  that cannot be edited calls `onCellActivate`) and `onCellFocus` (each move of the current cell).
- Built since (STUDY-12 L6, §10): the call tree (§15.6), deployment events (§16.4), usage and identity (§16.5).

### 13.2 The Functions screen

> The Logs tab now uses the shared logs view (§22.4) with its own filter column, and the argument and
> return validators moved to the Statistics tab (§22.5).

- **`/functions?function=<module:name>`** (`src/functions/`), the URL as in Convex. A sidebar holds the
  modules as a **tree** (`buildFunctionTree`): folders from the module path, then files, each
  alphabetical, with the functions as links (kind letter, name, "internal"). Files and folders collapse,
  and **Search functions** narrows the tree, opening every branch.
- The open function: its name, "Query in tasks" / "Internal action in users", and a copyable path. Below
  that are **its logs**: the Logs list (§13.1) fed by `listLogs` / `watchLogs` with the source's function
  filter. Its type and text filters are in the URL (`?function=<path>&type=&q=`) and kept in
  this browser per function (STUDY-12 L7, as the Logs screen: a link opens filtered; a function opened
  without filters starts from its own kept view); there is no function picker.
- **No Statistics tab** (STUDY-12 L1, decided): the server has no app metrics yet. No Run button until
  §13.3.
- Nothing open: a hint. An unknown function in the URL is named. No functions: says so.

### 13.3 The function runner

- **Contract**: an optional `runFunction(path, args)` → `FunctionRun` (`value`, or `error: { message,
  data? }` when the function threw, its `logLines`, `durationMs`). A function that throws is a result, not
  a rejected call. The call rejects only when it cannot be made: `not_found` (no such function),
  `unauthorized` (no `runFunctions`, or a read-only credential running a mutation or an action), or
  `unavailable`. The run is logged like any other execution. The mock runs `<table>:list`, `<table>:get`
  and `tasks:byOwner` over its tables, returns `null` otherwise and changes no data; as a mock-only hook,
  `throw: "…"` makes a run throw. The contract suite covers it when opted in (`run: { query, args }`).
- **The panel** (`src/runner/`): docked at the bottom of every screen, as in Convex, and opened by **Run
  functions** in the header, **Run** on the Functions screen, or **Ctrl+`** anywhere. It has a function
  picker; **arguments** as a JavaScript literal in the code editor, with a draft kept per function while
  the page is open; **Run query / mutation / action**, or Ctrl+Enter; then the result as a literal, or the
  error, with the duration and the lines the run logged. A refused call is shown as an alert. While the
  runner is open, the screen keeps room to scroll past it.
- Shown only when the source has `runFunction` and the credential has `runFunctions`. A read-only
  credential runs queries only.
- Not yet (STUDY-12 L6): custom test
  queries. (Argument validation came with §15.1.)

## 14. Amendment — loading, and the deployment's other screens (30 Sep 2026)

### 14.1 Each screen is its own chunk

- The routes load their screens with TanStack Router's `lazyRouteComponent`: Health, Database, Functions
  and Logs are fetched when their route is first matched, in parallel with the route's loader. The function
  runner is a `React.lazy` panel, fetched when it first opens. The screens import `router.tsx` for their
  routes' hooks; loading them lazily also removes that import cycle.
- Measured with `vite build` (entry chunk) and in Chrome (JS the page fetched until the screen's heading
  shows, from the Resource Timing API's decoded sizes):

  | | before | after |
  |---|---|---|
  | entry chunk | 739.8 kB (236.1 kB gzip) | 335.9 kB (109.2 kB gzip) |
  | first load of `/` | 722 kB in 1 file | 494 kB in 7 files |
  | first load of `/logs` | 722 kB in 1 file | 628 kB in 10 files |
  | first load of `/database/users` | 3 923 kB in 2 files | 3 907 kB in 12 files |

  The Database screen stays heavy on purpose: it preloads Monaco (§12.5.7).
- Guarded by an e2e test: the entry holds no screen's own text, and Health's first load stays under
  600 kB of JS as the browser counts it; importing a screen or the runner eagerly again fails it. (The
  entry's own size is not the bound: Rollup moves shared code in and out of it as screens are added.)

### 14.2 Schedules

> Navigation between Scheduled functions and Cron jobs moved to the section column, with the scheduled
> filters under it (§23.3); the grids follow §22.5.

STUDY-12 §9. The owner asked for it on 30 Sep 2026, contract and mock first.

- **Contract** (`data-source-deployment.ts`, re-exported by `@bunvex/dashboard/data-source`), all optional:
  `listScheduledFunctions({ numItems, cursor, function? })` — the runs still to happen, nearest first
  (`ScheduledFunction`: id, creation time, function, arguments, scheduled time, `pending` / `inProgress`);
  `watchScheduledFunctions(onChange, onError)`; `cancelScheduledFunction(id)` (a started run is
  `invalid_request`, a gone one `not_found`); `cancelAllScheduledFunctions(fn?)` → `{ canceled }`;
  `listCronJobs()` — each job with its `CronSchedule` (Convex's `interval` / `hourly` / `daily` / `weekly` /
  `monthly` / `cron`, UTC), next run and last run; `listCronRuns(name)` — newest first. Reading needs
  `viewData`; cancelling `writeData`, as Convex's `WriteData`.
- **Contract suite** (`contract-deployment.ts`): the reads run whenever the source has the methods;
  cancelling runs only with `schedules: { cancel: true }`.
- **Mock** (`mock/schedules.ts`): 24 pending runs and one running, four cron jobs (daily, every 15 minutes, a
  `*/30 * * * *` expression, weekly) with five past runs each, on a clock that starts at the fixture's `now`.
  While watched, due runs and crons run and are logged like any execution, and new runs get scheduled.
- **Screen**: `/schedules` opens `/schedules/functions`; `/schedules/crons` is the second tab, as Convex's two
  pages.
  - Scheduled functions: a function picker (`?function=`), the grid (scheduled for, with a relative time;
    state; function; id), and a run's details beside it (`?run=`): function, id (copy), times, state,
    arguments as a literal, and **Cancel run** after a confirmation (disabled once started or without
    `writeData`). **Cancel all** (or all of the picked function's) after a confirmation.
  - Cron jobs: name, schedule in words (`schedules/cron.ts`), function, last run (status and when), next
    run; a job's details (`?cron=`) with arguments and its recent runs (status, time, duration, error, log
    lines).
  - Refreshed on `watchScheduledFunctions` (STUDY-12 S1). A source without the methods gets "This deployment
    does not offer … yet"; the sidebar always lists the screen, as Convex's does.
- Tests: the cron helpers; the screen (order, picker in the URL, details, cancel one and all, a running run,
  read-only and no-`writeData` credentials, the crons and their runs, a source without them, axe); the
  contract suite on the mock; an e2e case and axe with colour contrast in both themes.

### 14.3 Files

> The screen's layout is §24 (section column: upload, storage use, views by type, filters, buckets).

- **Contract**, optional: `listFiles({ numItems, cursor, order?, from?, to? })` — newest first by default
  (`StoredFile`: storage id, creation time, base64 SHA-256, size, content type or null, a URL);
  `countFiles()`; `getFile(id)` (null when absent); `uploadFile(blob)` → the new storage id (the content type
  is the blob's); `deleteFiles(ids)` (unknown ids ignored); `watchFiles(onChange, onError)`. Reading needs
  `viewData`; uploading and deleting `writeData`, as Convex.
- **Contract suite**: the reads (both orders, a time range, the count, `getFile`) whenever offered; upload
  and delete only with `files: { write: true }` (it checks size, type and SHA-256 of what it stored).
- **Mock** (`mock/files.ts`): six SVG avatars, a text, a JSON, a CSV, a PDF-like and two binaries (one with
  no type), over the last 30 days; object URLs, so previews and downloads work in a browser.
- **Screen** (`/files`): the total ("12 files stored"), **Upload files** (several at once), a lookup by
  storage id (opens its details), the order and a day range in the URL (`?order=asc&from=&to=`, days in
  the viewer's zone), the grid (storage id, size, content type, uploaded) with row selection and **Delete N**
  after a confirmation; a file's details (`?file=`): a **preview for images only**, as Convex (STUDY-12 F1,
  decided: no text previews), size, type, SHA-256, time, **Download**, **Delete**.
- Tests: the screen (order, day range, details and preview, no preview for text, upload, select and delete,
  lookup, delete from details, read-only, a source without files, axe), the contract suite on the mock, an
  e2e case (a real upload and an image that loads) and axe with colour contrast in both themes.

### 14.4 Settings: environment variables

> Settings' pages are reached from the section column now (§23.3), not a frame with tabs.

- **Contract**, optional: `listEnvironmentVariables()` — by name; `updateEnvironmentVariables(changes)` — a
  batch of `{ name, value | null }` (null deletes), applied whole or not at all, as Convex's
  `update_environment_variables`; a rename is a delete and a set. New operations, Convex's:
  `viewEnvironmentVariables`, `writeEnvironmentVariables` (and `viewAuditLog`, for §14.5).
- **Rules** (`settings/env-vars.ts`, used by the screen and enforced by the mock): names
  `^[a-zA-Z_]+[a-zA-Z0-9_]*$` up to 256 characters, values up to 8 KiB, at most 512 variables and 512 KiB in
  all; warnings (not errors) for quotes around a value and spaces at its ends; reading a pasted `.env` file
  (comments, `export`, quotes, `\n` in double quotes) and writing one.
- **Contract suite**: the read whenever offered and allowed; the batch semantics (all or nothing, the limits,
  deleting an unknown name) only with `environmentVariables: { write: true }`.
- **Screen**: `/settings` opens `/settings/environment-variables`, under a Settings heading with its own
  navigation (one page so far). Values are **hidden** until shown (a toggle per variable), **Copy** one as
  `NAME=value` or **Copy all as .env**. With `writeEnvironmentVariables`: **Edit** (name and value, so a
  rename), **Delete** (marked, **Undo**), **Add a variable**; a `.env` file pasted into an empty name box
  becomes a row per line. The changes wait in a bar ("2 unsaved changes") with **Discard** and **Save**; Save
  is blocked while a name or value is invalid (said under the field) or a name is used twice. A refused
  batch keeps the changes, with the reason. Without `viewEnvironmentVariables` the values are not fetched.
- Tests: the rules; the batch a set of rows makes; the screen (hidden values, edit and save, a new variable
  with bad and duplicate names and a quote warning, delete and undo and discard, rename, a pasted `.env`, a
  refused batch, credentials without write, read-only, without view, a source without them, axe); the
  contract suite on the mock; an e2e case and axe with colour contrast in both themes.

### 14.5 History

- **Contract**, optional: `listAuditEvents({ numItems, cursor, from?, to?, actions? })` — newest first
  (`AuditEvent`: id, time, Convex's action name, author, JSON metadata); `watchAuditEvents(onChange, onError)`.
  Needs `viewAuditLog`, as Convex's `ViewAuditLog`. The source records events; the dashboard only reads them.
- **Contract suite**: the reads (order, time range, one action) whenever offered and allowed; with
  `history: { table }` it inserts a document there and expects an `add_documents` event.
- **Mock** (`mock/audit.ts`): nine past events (deploys, an index build, variables, documents) and, from then
  on, what its writes do: `add_documents`, `update_documents`, `delete_documents`, `clear_tables`,
  `cancel_scheduled_function`, `cancel_all_scheduled_functions`, `generate_upload_url`, `delete_files`,
  `create_` / `update_` / `delete_environment_variable`. Author "admin key" (STUDY-12 H1).
- **Screen** (`/history`): each event in words ("Added 2 documents to imports", `history/describe.ts`), its
  time and author; one action and a day range in the URL (`?action=&from=&to=`); an event's details
  (`?event=`) with its metadata as a literal. Live on `watchAuditEvents`. Without `viewAuditLog` the log is
  not fetched.
- Tests: the words for each action; the screen (order, action filter, day range, live recording of writes,
  details, without the operation, a source without it, axe); the contract suite on the mock; an e2e case (a
  change made in Settings shows up in History) and axe with colour contrast in both themes.

## 15. Amendment — deepening the screens (30 Sep 2026)

### 15.1 Validators on functions (STUDY-12 §8, V1)

- **Contract**: `FunctionInfo.args` / `returns?: ValidatorJson` — Convex's JSON form of `v.*` validators
  (the owner's call: the dashboard never imports `@bunvex/values`); absent means none declared.
- **`src/validators.ts`**: `displayValidator` (the `v.*` code, one line or one field per line past 72
  columns), `defaultValueFor` (the template, as Convex's runner), `validateValue` (every misfit, with its
  path and whether to point at the key or the value), `isValidatorJson`.
- **Functions screen**: "Arguments" and "Returns", the validators as code (a focusable box when it
  scrolls), or "None declared".
- **Runner**: the arguments start from the template; they are checked as they are typed; every misfit is
  underlined (`CodeEditor.moreErrors`; with several, each covers its word), the first is said below the
  box, and Run waits for a fit. `parseLiteralLocated` gives each value's (and key's) offset by path.
- **Mock**: validators for most functions (`mock/function-validators.ts`); `runFunction` fails a misfit
  with `ArgumentValidationError: …` as a server would. **Contract suite**: declared validators are
  well-formed; `run.misfitArgs` (opt-in) fails the run, not the call.

### 15.2 The saved schema (STUDY-12 §8)

- **Contract**: `SchemaInfo.tables[].validator?: ValidatorJson` (was untyped JSON), without system
  fields. The mock declares types for `messages`, `tasks` and `users` (not enforced); the contract suite
  checks the form.
- **`database/schema-code.ts`**: `schemaCode(schema, tables)` — the `bunvex/schema.ts` that declares the
  schema, as Convex's `displaySchema` prints it (prettier's two layouts, with or without
  `{ schemaValidation: false }`), and each table's line range.
- **Schema panel**: the table's status in one sentence, then **Saved schema** — the file, the table's
  lines tinted (`--info`) and scrolled to, "Lines a to b declare t." for screen readers, Copy. A table
  outside the schema, or no schema at all, says so.
- Found in the browser: `scrollIntoView` returns a Promise in current Chrome, so an effect written as an
  arrow expression returned it and React tore the screen down. Effects that scroll use a block body; a
  test makes `scrollIntoView` return a Promise.

### 15.3 The cell menu, completed (STUDY-12 D11, D13)

- **View `<field>`** (Space, or the menu): the whole value beside the cell (`ValueView`, a Popover
  anchored to the cell's rectangle, which `DataTable` now hands to `cellMenu` and `onCellKey` as
  `anchor()`): the field's name, the value as a literal, Copy. Escape closes it; the focus returns to the
  cell.
- **Go to reference** (Cmd/Ctrl+G, or the menu) takes View's place when the value is id-shaped text (31–37
  characters of lowercase base32, not the row's own `_id`) and the source's optional `tableOfId(id)`
  names a table — Convex decodes the id with its table mapping; bunvex asks the source. It opens the
  document in its table (`/database/<table>?doc=<id>`). The mock answers by looking the id up.
- **Delete document** (the menu, destructive): the same confirmation as Delete selected
  (`DeleteDialog`, now controlled; STUDY-12 D13, decided: keep asking). The behaviour sits behind
  `CONFIRM_DELETE_FROM_CELL_MENU` (`database/screen.tsx`): `false` deletes at once, as Convex does outside
  production; it becomes a check of the deployment's kind once deployments have one.
- Read-only: Delete document disabled, like the edit items.

### 15.4 Creating a table (STUDY-12 D11)

- **Contract**: optional `createTable(name)` — an empty table outside the schema; a taken name or one
  that is not an identifier is `invalid_request`. The mock implements it; the contract suite (writes,
  opt-in) checks both.
- **Table list**: "Create table" at its foot (where the credential can write and the source can),
  turning into a name box as in Convex: the name is checked as it is typed (`table-name.ts`, Convex's
  rules: letters, digits and `_`, not starting with a digit or `_`, at most 64; not taken), Create (or
  Enter) makes the table and opens it, Cancel or Escape puts the button back with the focus on it; a
  refusal from the source is an alert under the box.
- Not yet: a deployment with no tables at all shows the `/database` message without the list, so no
  Create table there (the route component is in `router.tsx`, left alone while route splitting is under
  way elsewhere).
- **A deployment with no tables at all**: `/database` (which otherwise opens the first table) shows
  "There are no tables here yet." and, when the credential may create one, the same Create table, which
  opens the new table (`database/empty.tsx`, lazy like the screens); otherwise it says tables appear once
  data is written. As Convex's `EmptyData.tsx`. The mock's `tables: false` (the dev host's `?tables=0`)
  gives such a deployment.

### 15.5 A generated schema (STUDY-12 D11)

- **Contract**: optional `inferDocumentType(table)` — a type every document in the table fits, in
  Convex's JSON form without system fields, null for an empty table (Convex keeps "shapes" for this on
  the server). The contract suite checks that every document of its fixture table fits what comes back.
- **Mock** (`mock/infer.ts`): over the whole table — a field missing from some documents is optional,
  several types make a union, objects merge their fields, arrays hold the union of their elements (an
  array never seen with one: `v.any()`), and text that is always an id of one table is `v.id(table)`.
- **Schema panel**: tabs, as Convex — **Saved** (§15.2) and **Generated**: the table alone in a
  `bunvex/schema.ts` with `// Other tables here...` where the others go, a sentence saying it is
  approximate and where to paste it, Copy; "Add at least one document…" for an empty table. It opens on
  Saved, or on Generated when nothing is saved. Without `inferDocumentType`, no tabs.

### 15.6 The functions a request called (STUDY-12 L6)

- **Contract**: `LogEntry.executionId` and `parentExecutionId` (optional): the execution a line belongs to,
  and the one that called it in the same request. The contract suite checks they agree (an execution stays
  in one request; its caller is another execution of the same request).
- **Mock**: an action may call one or two queries or mutations; their lines sit inside the action's, in
  its request, with its execution as their caller.
- **Details**: when the request ran more than one function, **Functions called** — Convex's outline
  (`FunctionCallTree.tsx`): one row per execution under its caller, in starting order, with its outcome
  (an icon and, for screen readers, "Succeeded:" / "Failed:" / "Running:") and duration; the line's own
  execution is marked "this line". `logs/call-tree.ts` builds it from the loaded lines (a caller not
  loaded: its call stands at the top; no outcome yet: running). The **Outcome** is now the line's own
  execution's, not another call's in the same request.


## 16. Amendment — the runner and the logs, second pass (30 Sep 2026)

### 16.1 A query stays subscribed (STUDY-12 §10.1, R1)

- **Contract**: optional `watchFunction(path, args, onResult, onError)`: the query's `FunctionRun`
  (asynchronously), then a new one whenever its result may have changed; `runFunction`'s permissions and
  errors, to `onError`; a mutation or an action is `invalid_request`. **Contract suite** (with `run`): the
  first run arrives, never inside the call; a mutation is refused.
- **Mock**: the query runs again when its module's table changes (`tasks:list` when `tasks` does), each run
  logged like any other.
- **Runner**: a query, when the source can watch it, has no Run button: it is subscribed with the current
  arguments while they are valid ("Subscribed: the result updates as the data changes."), shows the last
  result until the next, and pauses when they are not ("The result is paused until the arguments are
  fixed."). Without `watchFunction` a query runs once with Run, as before.

### 16.2 Run history (STUDY-12 §10.2, R2)

- A mutation's or an action's last **25** runs, newest first, in this browser per deployment and function
  (`bunvex:run-history:<scope>:<path>`, `runner/history.ts`); the same arguments twice in a row are one
  entry. **Previous arguments** / **Next arguments** beside the editor fill it with them. A query keeps none
  — watched, it follows its arguments; run once (without `watchFunction`), it still keeps none, as Convex's
  queries.

### 16.3 Acting as a user (STUDY-12 §10.3, R3)

- **Contract**: an `actAsUser` operation (Convex's `ActAsUser`); `UserIdentity` (`subject`, `issuer`, any
  claims); `RunOptions.identity` on `runFunction` and, as `opts`, on `watchFunction`. Without the operation,
  an identity is `unauthorized`. **Mock**: the run's first line says `authenticated as <name or subject>
  (<issuer>)`, as a function reading `ctx.auth.getUserIdentity()` would.
- **Runner**: **Act as a user** (disabled, with the reason, without `actAsUser`) opens a **User identity**
  editor, checked as Convex's `parseImpersonatedUser`: `subject` and `issuer` required, the OpenID claims
  typed, `customClaims` flattened (`runner/identity.ts`). It is one setting for the page, as in Convex,
  starting from Convex's `{ subject: "fake_id", issuer: "fake_issuer" }`. An invalid identity blocks Run and
  pauses a watched query; a run keeps its identity in the history, and Previous / Next bring it back.

### 16.4 The deployment's events among the log lines (STUDY-12 §10.4, L8)

- On the Logs screen (not a function's logs), the audit log's events (§14.5) from the oldest loaded line on
  are placed among the lines by time (`logs/events.ts`, as Convex's `interleaveLogs.ts`): level **event**,
  the author where a line has its function, the event in words (History's `describeEvent`). The log filters
  leave them, as in Convex. They refresh on `watchAuditEvents`. Enter on one opens it on the History screen.
- Only when the source has `listAuditEvents` and the credential `viewAuditLog`.

### 16.5 Usage and identity in a line's details (STUDY-12 §10.5, L9)

- **Contract**: an execution's last line may carry `usage` (`memoryMb`, database, file and returned bytes) and
  `identity` — who started the request: `admin`, `user`, `acting_as_user`, `system`, `unknown` (Convex's
  `identityType`). **Contract suite**: when given, they are well-formed.
- **Details**: **Started by** (Convex's words, with what they mean) and **Resources used** — compute (memory
  for the time), database read / written, files read / written, returned — summed over the request's loaded
  executions (memory: the most one used), saying so when there are several (`logs/usage.ts`).
- **Mock**: every execution has both, made up from its kind, duration and place (not the random stream, so
  the fixture is unchanged); the runner's runs are an admin's, or an admin's acting as a user.

## 17. Amendment — Settings → General, narrow screens, the design system (30 Sep 2026)

### 17.1 Settings → General (STUDY-12 §11)

> The Settings frame (`settings/layout.tsx`) now draws the section column, not tabs (§23.3).

- `/settings` now opens **General**, the first page, as Convex's; the Settings frame (`settings/layout.tsx`)
  lists General and Environment variables.
- **Deployment**: name, version, persistence, the **client URL** and the **HTTP actions URL**, each with a
  copy button; a URL the source does not give is left out. The contract's `DeploymentInfo` gains optional
  `httpActionsUrl` (Convex's site URL); the mock's is `http://127.0.0.1:3211`, next to its client URL on
  3210, as a self-hosted Convex backend.

### 17.2 Pausing the deployment (STUDY-12 §11)

- **Contract** (`data-source-state.ts`, optional): `getDeploymentState()` → `{ state: "running" | "paused" }`,
  `pauseDeployment()`, `resumeDeployment()` — Convex's `POST /api/pause_deployment` / `unpause_deployment`;
  both idempotent. Operations `pauseDeployment` / `resumeDeployment` (Convex's `PauseDeployment`,
  `UnpauseDeployment`). **Contract suite**: the state is well-formed; opt-in `pause: { toggle, query? }`
  pauses, checks the state and that `query` is refused, and always resumes.
- **Settings → General → Pause deployment**, as Convex's: "This deployment is currently running / paused",
  what pausing or resuming does, one button (destructive to pause) behind a confirmation naming the
  deployment, disabled with a reason for a credential without the operation; not shown for a source
  without the methods.
- **Every screen** shows a banner while paused, linking to Settings (`shell/paused-banner.tsx`), as Convex's
  dashboard layout.
- **Mock**: while paused, `runFunction` is refused, its live writes stop, due scheduled runs wait and cron
  runs are skipped; pausing and resuming are recorded as `pause_deployment` / `unpause_deployment` events.

### 17.3 Dragging a column header (STUDY-12 D10)

- A header of a `DataTable` with `onColumnStateChange` can be **dragged** to move its column, as Convex's
  (`Table/ColumnHeader.tsx`, `utils/useColumnDragAndDrop.ts`, which uses dnd-kit): a press becomes a drag
  after 4 px; while dragging, the column is dimmed and a bar marks the edge it will land at (the left edge
  of the column it goes before, or the last one's right edge); the release saves the order through
  `columnState` (`moveColumnBefore`, hidden columns keep their places); Escape or a cancelled pointer
  leaves it. The resize handle and anything interactive in a header keep their own drag.
- Native pointer events, no new dependency. The **Columns** panel stays: it is the keyboard and screen-
  reader way (the owner's call).

### 17.4 Narrow screens

Checked on every screen at 390 px (a phone) and 768 px (a tablet); nothing scrolls sideways but a grid.
- Below `md` the screens' list is behind **Menu** in the shell: a disclosure (`aria-expanded`,
  `aria-controls`) that closes when a screen is picked, or on Escape (the focus goes back to Menu).
- Below `lg`, the second columns become a row above the content: the table list becomes the **Table**
  picker, the Functions tree sits above the function, and the Settings pages above the page — a 768 px
  screen no longer holds the dashboard's sidebar, a list and the content side by side.
- Button rows wrap (a table's actions, a function's path and buttons, a URL and its copy button).
- An e2e case at 390 px checks that no screen scrolls sideways and that Menu works.

### 17.5 The design system's page

- `apps/dashboard/design-system.html` (`src/design-system.tsx`): `@bunvex/ui`'s tokens (the surface /
  foreground pairs, lines and chart colours) and components (type, buttons, badges, form controls, card,
  tabs, data table, JSON view, sparkline, skeleton), each rendered in a **light and a dark panel side by
  side** (the `.dark` class works on any subtree), for whoever builds screens.
- A second page of the private dev host, not of `apps/site`: the site is the public bunvex.dev (SITE-01,
  users' documentation), and this is a tool for contributors. It is a separate Vite entry, so it adds
  nothing to the dashboard's first load.
- An e2e case loads it and runs axe, colour contrast included, over both themes at once.

## 18. Amendment — metrics (30 Sep 2026)

### 18.1 The contract's metrics and the Health charts (STUDY-12 §12)

- **Contract** (`data-source-metrics.ts`): `MetricsWindow` `{ start, end, numBuckets }`, `Timeseries` (a
  bucket's start and value or `null`), and optional `functionRate`, `cacheHitPercentage`,
  `latencyPercentiles`, `topFunctions` (+ `REST`), `tableRate`, `scheduledJobLag`, behind `viewMetrics`.
  The contract suite checks them when offered (bucket times, errors and cache hits within the calls,
  percentiles in order, top-k bounded and ranked, an unknown table `not_found`, a bucketless window
  `invalid_request`), over the six hours before the newest log line.
- **Mock** (`mock/metrics.ts`): measured from its log history (an execution's last line); a query's cache
  hit and a function's rows are derived from its execution id, so they never change between calls.
- **`LineChart`** (`@bunvex/ui/components/line-chart`): one y-axis from zero, round ticks, 2 px lines broken
  at missing buckets, a crosshair tooltip by pointer or keyboard (the chart is a focusable `figure`: Left /
  Right / Home / End / Escape, the values said through a live region), a legend for two or more series,
  optional direct labels, and **Show as table**. Colours are `--series-1…5`, `--series-other` and
  `--series-p50…p99`, a set per theme, validated with the dataviz skill's script (categorical: colour-blind
  separation ≥ 8.4, normal ≥ 19.3; three light slots under 3:1 on white, so the legend and table carry them).
- **Health** (`metrics/health.tsx`, below the engine's counters): **Function calls**, **Failure rate**,
  **Cache hit rate** (top 5 and "Other functions") and **Scheduler lag**, the last hour in minutes,
  refreshed every minute. A function keeps its colour whatever its rank (STUDY-12 M3). Without metrics it
  says why: the deployment does not report them, or the credential may not view them.
- The commit clock's card is one row now — the timestamp, its rates and a compact sparkline labelled with
  the span it covers — instead of a full-width sparkline that stayed nearly flat and empty for the first
  seconds (UX-18).

### 18.2 A function's Statistics tab (STUDY-12 §12, L1)

- The open function's header (name, kind, path, Run, validators) is followed by **Statistics** and **Logs**
  tabs; Statistics comes first, as Convex's `FunctionsView.tsx`. The tab is in the URL (`?tab=statistics` /
  `logs`); without it, a link with log filters (`type`, `q`) opens the logs, any other the statistics.
  Changing the filters keeps the tab, so restoring a function's kept filters never switches it.
- **Statistics** (`metrics/function-stats.tsx`), the last hour per minute, as Convex's `PerformanceGraphs.tsx`:
  **Function calls**, **Errors**, **Execution time** (p50, p90, p95, p99 — one blue, light to dark,
  labelled at the lines' ends) and, for a query, **Cache hit rate**. Without metrics it says why.

### 18.3 A table's metrics (STUDY-12 §12)

- **Metrics** beside Schema and Indexes on the Database screen (shown when the source has `tableRate`)
  opens the side panel (`?panel=metrics`), as Convex's table **Metrics** tool (`TableMetrics.tsx`): the rows
  the table's functions read and wrote per minute over the last hour, one chart with Reads and Writes (the
  same unit, one axis). A table no function touches shows a flat zero line; without the permission, why.

### 18.4 The rate cards' heatmap (2 Oct 2026, STUDY-12 M2, M5)

- **Failure rate** and **Cache hit rate** get a "Line chart / Heatmap" switch, as Convex's `FailureRate.tsx` /
  `CacheHitRate.tsx`: failure rate opens as a chart, cache hit rate as a heatmap; the choice is kept in this
  browser (`bunvex:health-<measure>-view`). Same data as the chart (`topFunctions`), no new contract.
- **`Heatmap`** (`@bunvex/ui/components/heatmap`): a row per function, worst first by its average (failures
  high, cache hits low; rows with no value last, "Other functions" among them), a cell per bucket. Five steps of
  one blue (`--heat-1…5`, light and dark; validated as an ordinal ramp in both themes), the darker the worse; an
  empty bucket is a dashed, unfilled cell, never zero. It is a real table — row headers, time column headers,
  each cell's value in text — and the hovered cell is said in a line under it; a legend names both ends and
  "no data".

## 19. Amendment — Settings: authentication, snapshots; volume; every screen in the browser (30 Sep 2026)

### 19.1 Settings → Authentication (STUDY-12 §13.1)

> Moved to the Authentication screen as "Sign in / Providers" (§25.3); `/settings/authentication`
> redirects there.

- **Contract** (`data-source-auth.ts`): optional `listAuthProviders()` → `AuthProvider[]`, Convex's OIDC
  `{ domain, applicationID }` or custom JWT `{ type: "customJwt", issuer, jwks, algorithm, applicationID? }`,
  in the config's order. Needs `viewData` and `viewEnvironmentVariables`. **Contract suite**: when offered and
  allowed, every provider is well-formed (`isAuthProvider`).
- **Page** (`settings/auth.tsx`, lazy): a list item per provider named by its kind and domain / issuer, its
  values as code with copy buttons; none → "This deployment has no authentication providers yet." and where they
  are declared (Convex links its docs; bunvex has no docs site yet); without both operations the page says why and asks nothing of the source; a source without the method
  gets the "not offered" screen.
- **Mock**: an OIDC and a custom JWT provider (`mock/auth.ts`; the `authProviders` option overrides).

### 19.2 Settings → Snapshots (STUDY-12 §13.2, a bunvex addition)

- **Contract** (`data-source-snapshot.ts`, every method optional): `getLatestSnapshotExport`,
  `requestSnapshotExport({ includeStorage })`, `downloadSnapshotExport(id)` → the zip as a `Blob`;
  `startSnapshotImport({ file, format, mode, table? })` → `failed` with why, or `waiting_for_confirmation` with
  `changes` (per table: added, deleted); `confirmSnapshotImport`, `cancelSnapshotImport`, `getSnapshotImport`
  (progress, checkpoints, rows written). Operations `viewBackups`, `createBackups`, `downloadBackups`,
  `importBackups` (Convex's names); importing also needs to write. **Contract suite**: the latest export is
  read when offered; an export (opt-in) is requested, followed to `completed` and downloaded (a zip of its
  size); an import (opt-in, into a scratch table) refuses a bad file, then is confirmed and written.
- **Page** (`settings/snapshots.tsx`, lazy): **Export** — include stored files, Export a snapshot, its state
  while it runs (polled every 500 ms), then when, how large, until when, and Download (a `snapshot-<time>.zip`);
  **Import** — a file (the format guessed from its extension, the table from its name), the format, the
  table for a single-table format, and what to do when a table has documents (the four modes; replacing
  everything only for a zip); Upload and review shows what will change per table; the confirm button says how
  many documents it deletes; then progress, the steps done, and the documents written. Every half follows its
  operations; a source without either gets the "not offered" screen.
- **Mock** (`mock/snapshots.ts`, `mock/zip.ts`): exports and imports advance a step per table every
  `snapshotStepMs` (300 ms); the zip is Convex's layout, stored uncompressed, and the reader also takes deflated
  entries; ids and creation times in a file are kept (an `append` that repeats an id fails); CSV numbers and
  booleans are read as such, empty cells left out; `request_export` and `snapshot_import` go to the audit log
  (History says them in words).

### 19.3 Volume

Measured in headless Chrome against the production build (`vite preview`), with the dev host's new volume
knobs `?tasks=100000&executions=4000` (100 000 tasks; ~10 000 log lines): the Database screen opened on
`tasks`, then scrolled to the end 15 times (16 pages, 1 600 rows); a field filter (`done = true`); the Logs
screen scrolled until ~8 450 lines were loaded, then 10 characters typed in its filter. "Long tasks" are the
browser's (> 50 ms on the main thread).

| | before | after |
|---|---|---|
| Database: long tasks while loading 15 more pages | 16, max 186 ms, total 2 779 ms | **1, 71 ms** |
| Database: first rows | 594 ms | 483 ms |
| Logs: long tasks while scrolling to ~8 450 lines, and while filtering them | none | none |

- The cost was the **mock's** `listDocuments`: every page filtered, sorted with a key built per comparison,
  and cloned every matching document — 170 ms a page at 100 000 documents (in Bun). It now builds each key
  once and clones only the page: **13 ms** a page. The dashboard's own work (the grid, virtualized; React)
  stays under the long-task line; a profile of the scrolling shows the rest is React rendering the new rows.
- Left as is: opening the page with 100 000 tasks has one ~260 ms task — the mock generating them, in the
  dev host only. A real server pages from an index.

### 19.4 Every screen in the browser

The e2e suite (`apps/dashboard/e2e`, against the production build in Chromium) now opens every screen: to the
Database, Monaco, Schedules, Files, Settings → Environment variables, History, the design system's page and
the phone-width pass already there, it adds **Health** (its counters, nothing fetched elsewhere),
**Functions** (a function's page; its query subscribed in the runner), **Logs** (a line's details follow the
arrows), **Settings → General** (pause, the banner on another screen, resume), **Authentication** (the
providers, copyable) and **Snapshots** (export, download a real zip, import a file and confirm). The axe pass
(colour contrast included, both themes) now also covers a function's page, Logs, General, Authentication and
Snapshots. 22 tests, about a minute.

## 20. Amendment — UX review (30 Sep 2026)

Every screen was captured in both themes at 1 440 px and at phone width and reviewed for consistency; the
owner approved all 25 findings (UX-1…UX-25; UX-18 went to the Health redesign). They land in five grouped
pull requests.

### 20.1 Database: polish and bugs

- **UX-1** The document panel shows the document as the JavaScript literal the rest of the dashboard uses
  (`credits: 10n`, `Bytes("…")`, bare keys), through `database/literal-view.tsx` — no more wire form
  (`{"$integer": …}`).
- **UX-2** A filter row just added is silent until something is typed in it; it does not apply meanwhile.
- **UX-12** The schema panel's code wraps long lines with a hanging indent instead of running past its edge.
- **UX-20** On a phone the toolbar keeps Add documents and ⋯ on the title row; Schema, Indexes and Columns
  move into the ⋯ menu (`TableMenu panels`).
- **UX-21** Every cell value truncates with an ellipsis; numbers (and int64) are right-aligned.
- **UX-22** The cell menu groups the cell's actions, the document's, and Delete document on its own.
- **UX-23** A right-click with no click before targets the cell under the pointer (tested). The review's
  capture likely hit a layout shift while the table settled.
- **UX-25** Add documents has no reserved line between the editor and its button.
- **Submenu** (owner's note): "Filter by …" closed before it could be clicked when the pointer moved fast.
  Base UI focuses the parent menu when the pointer leaves an item — the submenu's own trigger on the way into
  it — and the submenu closed as "focus-out". `DropdownMenuSub` (`@bunvex/ui`) ignores a focus-out that stays
  in the menu tree; a sibling item, Escape, a click outside or picking an item still close it. Reproduced and
  checked in Chrome.

### 20.2 Logs

- **UX-5** The Time column stays in view when a long message scrolls the list sideways: `DataTable`
  gains `stickyColumn`.
- **UX-6** On a phone the message comes right after the time (Time, Message, Level, Function, Outcome,
  Request).
- **UX-24** A line's details say who started the request once (the explanation is its tooltip), show the
  function's kind as the list's Q/M/A badge, and keep the copy button in the body font.

### 20.3 Shell layout and lists

- **UX-4** On a phone the header shows the deployment as one muted line (`local · memory · 0.0.0-mock`,
  labelled for assistive tech) and Run functions as an icon (its name kept for assistive tech); the
  labelled list returns from `md` up.
- **UX-9** An environment variable's actions sit at the row's right edge, on the name's line; each Copy
  button says "Copy" (named for its variable), so they line up.
- **UX-14** One place for counts: next to the title (Database, Files, History) or above the list (each
  Schedules tab); a footer only says "N loaded" while more are still to load. History's counts (its title's
  and an event's, "Added 1,452 documents") use the shared count format, with thousands separators.
- **UX-16** Files' Open button is as tall as the storage-ID box.
- **UX-17** No reserved status line between a toolbar and its table (Files, Scheduled functions).



### 20.4 Functions and the runner

- **UX-3** The header's Run functions (and Ctrl+`) opens the runner on the function the Functions screen
  shows, as Convex's runner follows the selected function; elsewhere it keeps the last one.
- **UX-12, UX-13** A function's Arguments and Returns validators wrap long lines with a hanging indent, grow
  to 12 lines, and past that scroll with a note ("N lines: scroll for the rest.").

### 20.5 Shared components

- **UX-7** The schema panel's Saved / Generated are underlined tabs (`TabsList variant="line"`), as every
  switch between sibling views is; Settings' vertical nav already had the sidebar's active treatment.
- **UX-8** A copy next to a value is an icon (`CopyButton iconOnly`) named by its label ("Copy client URL"),
  with the label, then "Copied", as its tooltip; page-level copies keep their text.
- **UX-10** Destructive actions read the same: a row's delete is `destructive-ghost` (quiet, red); a
  reversible but disruptive action (Pause deployment) is `destructive-outline`; confirmations keep the strong
  one.
- **UX-11** One `StatusBadge` (`@bunvex/ui`): an icon and a sentence-case word in the status colours, with
  optional detail (a duration), for a log line's outcome, a scheduled run's state and a cron's last run.
- **UX-15** `DayInput` (`@bunvex/ui`): the design system's input, typed as `YYYY-MM-DD` (it applies once
  complete and valid; a wrong day says so) or picked from a month's calendar in a popover — not the
  browser's date field.
- **UX-19** The "bright bar" on a phone was the open function's row, cut by the short tree; the tree now
  scrolls the open function into view.

## 21. Amendment — the Schema screen (30 Sep 2026)

STUDY-12 §14. A **Schema** entry in the navigation, between Database and Functions, at `/schema` (`?table=` opens
a table), lazy like the other screens.

- **Model** (`schema/graph.ts`): `buildSchemaGraph(schema, tables, inferred)` — a node per table (declared ones,
  plus tables with documents but no declaration, flagged `notInSchema` and typed from `inferDocumentType` when the
  source has it; with no declared table, every table is inferred), fields with a compact TypeScript-style label
  and the full one when it hides detail, `references` from every `v.id` (nested too), a union document type's
  members and discriminator, and an edge per reference to a table that exists. `null`: nothing to draw.
- **Groups** (`schema/clusters.ts`): linked tables form a group, named after the most linked one; a group of 8 or
  more is split by modularity (Louvain's local moving); lone tables form none. On by default; the choice is kept
  per deployment (`bunvex:schema-groups:<scope>`).
- **Layout** (`schema/layout.ts`): ELK `layered`, top to bottom, groups as compound nodes; loaded on first use.
  At 150 tables and ~280 references: the model and groups in under 6 ms, ELK about 1 s — "Laying out…" is said
  meanwhile.
- **Diagram** (`schema/diagram.tsx`, @xyflow/react 12.12.0): table nodes (at most 12 fields, then "N more"),
  group boxes, smooth-step arrows (dashed when the field is optional; the open table's highlighted and labelled
  with the field), a dotted background, a minimap (from `md`), zoom in / out, fit, Reset layout, Group related
  tables. Search over groups, tables, fields and indexes: arrows move through the hits, Enter opens one, and the
  diagram dims what does not match. Themed from the tokens (xyflow's CSS variables), following the page's theme;
  reduced motion makes every zoom instant. Many tables: only the visible ones are rendered past 60.
- **Keyboard**: every table node is focusable and named ("Table tasks: 5 fields, references users"); Enter or
  Space opens it. The URL, not xyflow's selection, says which table is open (xyflow's selection re-opened a closed
  panel), so nodes are not selectable.
- **Side panel** (`schema/panel.tsx`, the shared `Panel`): Open in Database, the document count, a note for an
  undeclared table, every field (a long type expands), a union's members one at a time with the discriminator
  marked, the references in and out (each opens that table), and the indexes.
- **States**: no tables — "This deployment doesn't have any tables", with how to declare a schema
  (`bunvex/schema.ts`, `defineSchema`); no `viewData` — "You cannot view the schema"; errors with Retry; a
  skeleton while loading.
- **Size**: the screen's chunk is 203 kB (65 kB gzip) with xyflow; ELK is its own 1.43 MB (436 kB gzip) chunk,
  fetched when the first layout runs. Neither reaches the shell (an e2e test checks the entry chunk).
- Tested: the model, groups and layout (unit); the screen in happy-dom with axe (navigation, counts, the panel
  from the URL, an undeclared table, search, a union, Enter on a node, the empty and permission states, the
  grouping choice); e2e in Chromium in both themes with axe (contrast included). Each behaviour was sabotaged once.

## 22. Amendment — Topology (1 Oct 2026)

A **bunvex addition** (STUDY-12 §15): who is running and how it connects, after STUDY-24's roles. Reworked twice
the same day at the owner's request: a canvas like PlanetScale's primary/replicas and Railway's service flow,
then diagram only, laid out like the Schema screen, with each node's query cache.

- **Contract** (`data-source-topology.ts`): optional `getTopology()` and `watchTopology(onTopology, onError)`,
  needing `viewMetrics`. A `Topology` is the leader first then followers by id (role, state `ok` / `lagging` /
  `down`, version, uptime, CPU, memory, connections, subscriptions, a follower's lag in commits and ms, the
  leader's commits per second, who runs the scheduler, actions running, a minute of samples), the **store**
  (driver, single-node or not, lease holder, expiry and TTL, latency, size, connections) and recent
  **events** newest first. Each node may carry its own **query cache** (`NodeCache`: entries and the LRU's
  capacity, bytes and their limit, hit rate, invalidations per second, evictions, the most-cached
  functions); samples carry its hit rate and invalidations. The contract suite checks the shape
  (`contract-topology.ts`): entries within capacity, rates in range, most-cached in order.
- **Mock** (`mock/topology.ts`): `nodes` (default 1, as today; the dev host's `?nodes=4`, up to 8) — with several,
  the store is Postgres, clients connect to followers, one follower drifts behind and catches up, emitting
  events. Each node's LRU fills from its queries, is invalidated in step with the leader's commits, and evicts
  past its 5k capacity. Its own clock, so a fixed `now` stays consistent.
- **Screen** (`/topology`, lazy), laid out like the Schema screen: full-bleed inside `<main>`; a slim bar with
  the title and the one-line summary ("Leader node-a · 3 followers · 881 clients · max lag 740 ms · Postgres
  OK"); the canvas taking the rest; the **events docked under it**, one line (the newest) until opened, then a
  short scrolling list — the right edge stays free for the node panel, and the canvas keeps its height.
- **Diagram** (`diagram.tsx`, React Flow — already a dependency for Schema — loaded with the diagram only;
  zoom/fit controls and the dot grid shared with Schema, `shell/flow-controls.tsx`):
  - **Layout** (`layout.ts`, no ELK): fixed layers top to bottom — one **client group** per serving node, the
    **followers** side by side (120 px apart), the **leader**, the **store** — centred; one node: clients →
    node → store. Positions depend only on which nodes exist: live updates never move anything; the view
    re-frames when a node joins or leaves, and Fit re-frames on demand, never past 100 % zoom. On a **phone**
    (a canvas under 640 px when it opens) the layout is one column — each follower under its clients, then
    the leader, then the store — framed to the width at a readable zoom and panned vertically; the commit
    streams climb along the left margin, one lane per follower, so they never cross a card (their labels
    are left to the cards, which say the lag).
  - **Cards** (220 px, 11–13 px text): a server's id, a crown and "Leader", its state as an icon and a word;
    its lag in words with a bar (or commits/s and "scheduler" on the leader); CPU and memory with thin bars;
    and a **cache strip**: hit rate, the LRU's occupancy "3.1k/5k" with a bar, invalidations per second.
    Clients: a device icon and the count. Store: a generic database mark per driver (no brand logos), the
    lease holder and TTL, latency and size.
  - **Edges**: clients → follower "385 ws" (dashed); the commit stream leader → follower "3 commits · 50 ms"
    (", lagging" / ", down"), width by commits/s, colour by the follower's state, labelled near the follower;
    leader → store "110 commits/s" with a lock. **Particles** move along the stream and the store edge, their
    number and speed from commits/s; none under `prefers-reduced-motion`.
  - Hovering a node, or picking one of the events, lights its edges and dims the rest; a click or Enter on a
    focused node opens the panel (`?node=`). Nodes are focusable with descriptive labels ("node-d, follower,
    lagging, 73 commits · 740 ms behind, 88 clients, cache 89% hits, 3,900 of 5,000 entries, press Enter
    for details").
- **Node panel**: **Overview** (role, state, version, lag, vitals, CPU and lag or connections sparklines) and
  **Cache** (hit rate and invalidations-per-second sparklines, entries and bytes against the limits with the
  occupancy bar, evictions, the most-cached queries with their counts).
- The List view and its `?view=` are gone (the owner's call): the summary line and the nodes' labels carry
  the picture in words.
- Tests: the words; the wide and narrow layouts (positions stable across updates, spacing); the stream's
  look; the edges' words and node labels (pure — happy-dom cannot measure, so draws no edge); the mock's LRU
  (capacity, evictions, invalidations following commits); the screen: one node, the cache strips, Enter and
  the Cache tab, the docked events lighting a node, permission, not offered; axe; the contract for 1 and 4
  nodes. e2e (real Chromium): nodes, edges, labels, particles and cache strips in both themes, hover dimming,
  the Cache tab, none under reduced motion, the phone layout; Topology in the axe sweep with contrast.

### 22.1 Side panels are docked and resizable (the owner's call, 1 Oct 2026)

Supersedes §12.5.6's rule ("a drawer over the table below 2xl, beside it above"). Every side panel — Database
(document, schema, indexes, columns, metrics, add documents), Logs details, Files, Schedules (a run, a cron),
History, Schema's table, Topology's node — is the one `Panel` (`shell/panel.tsx`):

- **Docked**: part of the layout beside the screen's content, which shrinks to make room; never floating over
  it. At most 45 % of its row, so the content keeps the rest. Below `md` (a phone) there is no room side by
  side: a full-screen sheet.
- **Resizable** by dragging its left edge — `ResizeHandle` (the window-splitter pattern, now with a left-edge
  mode: Left widens, Right narrows, Shift for 64 px, Enter or a double-click puts the default back), 288–760
  px, default 416 — its width kept in this browser **per kind of panel** (`bunvex-dashboard:panel-width:<kind>`).
- A complementary landmark named by its title; Escape or the close button closes it; on open it takes the focus
  (its heading) and on close gives it back to what had it, unless the screen keeps the focus (Logs: the list,
  whose current line the details follow).
- Tests: the shared panel (landmark, focus in and back, a screen that keeps it, resize by keyboard within
  bounds, the width kept per kind); Database's layout classes; e2e: docked beside the content on Database and
  Topology at 1440 (content ends where the panel starts; dragging the edge widens it and narrows the content),
  a full-screen sheet at 390.

### 22.2 Schema: indexes on the cards, going to a relation (1 Oct 2026)

As Convex's `TableNode.tsx`: each card shows a table icon (`Table2`, as the tables list) left of its name, its
fields, then an **Indexes** section — each index's name and fields; system indexes (`by_id`,
`by_creation_time`) left out; at most 5, then "+N more indexes" — sized into the layout. A field whose type
references a table (`Id<"users">`) is a button: it **pans to that table, lights it a moment and focuses it**
(instant under reduced motion), without opening its panel; the panel's references do the same and open it.
Both canvases fit never past 100 % zoom and share their controls and dot grid.

### 22.3 Database layout (the owner's annotated screenshot, 1 Oct 2026)

- **The grid fills the screen**: edge to edge between the tables list and the docked panel, down to the bottom
  of the viewport (the screen is `100svh − 3rem` from `lg`; the shell's header is now exactly 48 px, so no
  canvas or grid screen scrolls by a pixel). No padding or box around it; `DataTable`'s new `fill` mode drops
  its frame and height cap, and pins its footer ("N of M documents loaded") to its bottom edge — with few rows
  the rest is the grid's own background. Horizontal scrolling stays inside the grid. Below `lg` the tables
  list sits above and the table takes a screen's height of its own.
- **Two full-width bars** with dividers, no boxed filter card: **Bar 1** — the table's name, "· N documents",
  "· Not in the schema" (and Read-only) on the left, the actions on the right — is 44 px, as tall as the side
  panel's header, so their bottom lines continue across. It folds by its **own width** (a container query): in
  a narrow bar (beside a docked panel, on a phone) Schema, Indexes, Metrics and Columns move into ⋯ (which
  lists them at every width) and Add documents keeps only its icon. **Bar 2** — the filter bar: Index, the
  range, Add filter (and Clear filters) on one row with Order at its end; clause rows stack inside it. The
  grid starts right under it. Notices and errors are thin rows between the bars and the grid.
- **The document panel follows the row**: while it is open, a click on any cell of any row — or ↑/↓ onto
  another row — switches it to that row's document (`?doc=`, the title), as the Logs details follow their
  list; the grid keeps the focus (the panel does not take it). A single click selects a cell (and moves the
  panel); editing a cell still needs a double-click or Enter. **Unless the document's editor holds unsaved
  changes**: then the panel stays, with "Save or cancel your edit to open another document." (an unchanged
  editor does not hold it). `DataTable` gains `onCellClick` (any single click, even on the current cell).
- Tests: the panel follows a click and the arrows, opens nothing when closed, the unsaved-edit guard and its
  notice (and an unchanged editor not holding it), the bars and the filled grid; e2e at 1440 (tasks, imports)
  and 1024: the grid ends at the viewport's bottom, Bar 1's bottom line and the panel header's within 1 px, no
  page scroll, a click on another row switches the panel. Follow-up: the same full-bleed, two-bar layout for
  Logs, Files, Schedules and History (each has its own header and toolbar today).

### 22.4 Logs redesign (the owner's call, 1 Oct 2026)

Logs take the Database screen's visual language (§22.3); the reference was a Supabase-like logs screen, for
the layout only. Supersedes §13.1's layout, its multi-select filters and its toolbar. One component,
`LogsView` (`src/logs/screen.tsx`), is both the Logs screen and a function's **Logs** tab.

- **Filter column** (`filter-column.tsx`) on the left, as the tables list: fixed, resizable from its right
  edge (the window-splitter handle), its width kept in this browser (`bunvex-dashboard:logs-filters-width`;
  the Functions tab keeps its own). Its header ("Filters", Reset) is 44 px, on Bar 1's line. Sections, each a
  labelled group: **Time range** (radios: All time, Last minute, Last 5 / 15 minutes, Last hour);
  **Functions**, **Type** (success, failure, debug, info, warn, error) and **Function kind** (query,
  mutation, action) as checkboxes, each with the number of loaded lines it holds **in text** — counted under
  the time range and the search, not under the other choices (`facetCounts`). Every box checked is "all"
  (later functions included). The Functions tab's column has Time range and Type only. Below `md` the
  column is a **Filters** button in Bar 1 that opens the same sections in a sheet (the shared panel).
- **The view in the URL and the browser** (STUDY-12 L7, extended): `?function=&type=&kind=&q=&range=15m`;
  a brushed window is `&from=<ms>&to=<ms>` (both, `from < to`, or neither) and overrides the range. The
  window lives in the URL only (not kept in the browser: it is a moment, not a preference). A range that
  reaches past the oldest loaded line loads older pages until it is covered or the buffer is full (10 000
  lines; STUDY-12 L2, L4). The Functions tab carries `type, q, range, from, to` next to `?function=`.
- **Bar 1** (`log-bar.tsx`, 44 px, its bottom line continuing the panel header's): the heading (Logs
  screen), the search box (200 ms), the line count ("208 lines", "57 of 208 lines"; polite live region),
  then **Live** (a dot that pulses, steady under reduced motion; pressing it pauses, and it becomes "Resume (N
  new)"), **Export** and **Clear** ("Show N cleared" when some are hidden). Beside a docked panel the bar is
  narrow: Export and Clear keep their icons (a container query, `@container/logs`).
- **Export**: the lines the list shows (every filter applied, events left out), oldest first, as **JSON
  Lines** (`logs-<ISO time>.jsonl`, `application/x-ndjson`), saved the way snapshot exports are (an object
  URL and a download link); no library.
- **Bar 2, the histogram** (`histogram.tsx`, `histogram-data.ts`): the loaded lines' volume over time in 60
  buckets, from the oldest loaded line (or the range's start, when earlier) to now; counted under every
  filter but time. Stacked by outcome: success in neutral ink (bottom), warnings amber, failures red (a
  failed execution or an error line); 2 px gaps between buckets and segments, the top segment's corners
  rounded. The amber and red steps are chart-only and pass the dataviz palette checks on each theme's
  surface (colour-vision ΔE ≥ 8); the text tokens alone did not. A **legend** with icons, words and totals;
  colour is never the only signal. Hover — or focus the strip and use ←/→ — shows a bucket's tooltip
  (its time and counts per outcome). **Drag across the strip** to pick a window (a click picks one bucket);
  the keyboard does it with Shift+←/→ and Enter; Escape or **Clear selection** drops it. A preset range is
  drawn as a band and named on the strip. A screen-reader table carries the same numbers.
- **The grid** (`fill`, edge to edge, down to the bottom): Time, Level, Function (kind letter + path),
  Outcome / duration, Request, Message (on a phone: Time, Message, …, UX-6). Events interleave as before.
- **Details** only while a line is selected, docked on the right, following the selection (click, ↑/↓). New
  at the top: the time as ISO, local and relative ("58 seconds ago"), and the level; at the end, the line as
  **raw JSON** (read-only). The rest as before: function, request id (copy), outcome, started by, resources
  used, the message, the request's other lines and its call tree.
- Tests: counts and filters, presets and the URL, the window (keyboard and drag) filtering and in the URL,
  older pages for a range past the loaded lines, the export's content, the details' time and raw JSON, the
  Functions tab's column, the phone sheet; e2e at 1440: the filter header, Bar 1 and the panel header on one
  line, the grid down to the bottom, no page scroll; dragging across the histogram filters and goes into the
  URL; the Functions tab with its own column and a screen-high list.

### 22.5 The other grid screens in the same language (the owner's call, 1 Oct 2026)

Follows §22.3 and §22.4: History, Schedules (scheduled functions and cron jobs) and Files take the Database /
Logs layout, and the Functions, Schema and Topology screens' top bars match it. Supersedes the layouts of
§14.2, §14.3 and §14.5 (their content, filters and actions still hold).

- **The frame** (`shell/bars.ts`): full-bleed, a screen's height; **Bar 1** — the heading (`text-base`), the
  count, the actions — 44 px, so its bottom line continues the docked panel header's and the filter column's
  header; **Bar 2** — search and filters — where a screen has them outside a column; then the grid (`fill`),
  edge to edge, down to the bottom. Details are the shared docked panel; while open they **follow the
  current row** (click, ↑/↓; the grid keeps the focus), as on Database and Logs.
- **The filter column** (`shell/facet-column.tsx`, shared with Logs): resizable, width kept per screen, a
  44 px "Filters" header with Reset, labelled sections of checkboxes or radios with each choice's count in
  text; below `md`, a Filters button in Bar 1 opens the same sections in a sheet.
  - **History**: *Days* (radios: Any day, Today, Last 7 days, Last 30 days — they set `from`), *Day range*
    (From / Until), *Action* (checkboxes, `?action=a,b`, filtered by the source as before). An action's count
    is of the loaded events of those days **for every action** (a second query, the same one when no action
    is picked), so a narrowed list still shows what the other actions would add; a note says the counts are
    of the loaded events.
  - **Scheduled functions**: *State* (Pending, Running; filtered here, over the loaded runs: `?state=`) and
    *Function* (radios, filtered by the source, as before: `?function=`), each with its loaded runs' count.
    Bar 1: Schedules, the two pages as tabs, the count, Cancel all.
  - **Cron jobs**: no column — a deployment has a handful of jobs, all in view.
  - **Files**: no column — its filters are the source's (order, upload days, a storage id), in Bar 2; a
    content-type facet over one loaded page would mislead. Bar 1: Files, "N files stored", Delete N and
    Upload (its icon only when the bar is narrow, beside a docked panel).
- **Functions**: Bar 1 holds the function's name, kind and module, the **Statistics / Logs tabs**, its path
  (copy) and Run; the tree's search sits on the same 44 px line. The declared validators move into the
  Statistics tab, so the Logs tab (§22.4) has the whole height below the bar; from `lg` the screen is a
  screen's height and the tree and the statistics scroll inside.
- **Schema and Topology**: their top bars become Bar 1 (44 px), on the docked panel header's line.
- Tests: History's action counts (every action's, while the list is narrowed), the URL, Reset, the day
  presets, the details following ↓; Scheduled's function and state facets with counts and the URL; e2e at
  1440: History, Scheduled, Crons and Files — Bar 1, the filter header and the panel header on one line, the
  grid to the bottom, no page scroll, ↓ moves the open details; Functions' 44 px Bar 1 with its tabs.

### 22.6 Schema: spacing inside a group box (1 Oct 2026)

A group box (a cluster of linked tables, §15) lays its tables out with the root's spacing — 96 px between
layers, 56 between tables. ELK reads its spacing options per parent, so the boxes had used its defaults: the
tables sat 20 px apart and the reference lines ran along the cards' borders, between `tasks`, `messages` and
`users`. Test: inside a box, consecutive layers are at least 90 px apart.

## 23. Design language: the section column (the owner's call, 1 Oct 2026)

The owner showed Supabase-like screens as **layout references only**; bunvex keeps its own context and design
system. Every screen is: the main sidebar · the screen's **section column** · the main area (Bar 1, then the
content full-bleed) · the docked details panel, only while something is selected.

### 23.1 The section column (`shell/section-column.tsx`)

- **One component** for every screen's column (it replaces §22.4's filter column and the Database tables
  list's own frame): fixed, resizable from its right edge (the window-splitter handle; 176–440 px, default
  224), its width kept in this browser per screen.
- **Top**, 44 px — on Bar 1's line and the panel header's: the screen's name (a level-2 heading) and its
  primary action when it has one ("+ New …", "Upload").
- **Nav groups** (`SectionNav`): the screen's pages under small uppercase labels (a group may have none), the
  current page marked (the router's `aria-current`).
- **Filters** (`SectionFilters`), below the nav: the current page's facets — checkbox and radio groups, each
  choice with how many loaded rows it holds, in text — with Reset. Only on pages that have filters.
- **Below its breakpoint** (md; lg on Database, whose table picker sits above the grid there) the column is
  hidden; a button in Bar 1 (`useSectionSheet`: "Filters", "Pages", "Schedules") opens the same content as a
  sheet (the shared panel), which a picked page closes.
- **Bar 1** names the current page (the `h1`), says in a few words what it is for, and holds its actions.

### 23.2 The main sidebar's groups

(no label) Health, Topology · **Data**: Database, Schema, Files · **Functions**: Functions, Schedules ·
**Observe**: Logs, History · (no label) Settings, last. Each group is a list named by its label. Schema sits
with Database (it describes the data) and Files is stored data; Schedules run functions; Logs and History are
what happened. **Manage** (Authentication) joins with §25.

### 23.3 The screens on the column

- **Database**: "Database"; search, Create table (it turns into its name box in place, so it stays at the top
  of the list rather than in the header), then the TABLES group.
- **Settings**: "Settings"; **Configuration** (General, Environment variables, Authentication) and **Data**
  (Snapshots) — instead of the page tabs. Bar 1: the page's name and purpose; the page scrolls inside.
- **Schedules**: "Schedules"; Scheduled functions and Cron jobs as the nav (no tabs in Bar 1); the state and
  function filters below it on Scheduled functions only. Bar 1's `h1` is the page's name.
- **Logs**, **History**: "Logs" / "History", then their filters (§22.4, §22.5).
- Tests: the grouped sidebar; Settings' groups and current page; Schedules' filters on one page only; the
  column on Database, Logs and History; the phone sheet (a pick closes it). e2e at 1440: the column header and
  Bar 1 on one line, no page scroll, on Database, Settings, Schedules, Logs, History; at 390 the column hidden
  and the Pages sheet navigating.

## 24. Files on the section column (the owner's call, 1 Oct 2026)

- **Column** (`files/column.tsx`): "Files" with **Upload** on top (it left Bar 1); then the **storage used** —
  bytes in N files, a bar of the bytes by kind (2 px gaps; the chart tokens, with a legend in words and bytes,
  so colour is never alone); the **views** — All files, Images, Documents, Other, each with its count
  (`?view=images|documents|other`); the **filters** — *Uploaded* (Any time, Today, Last 7 days, Last 30 days:
  they set `from`, as History's) and *Size* (Under 1 KB, 1 KB – 1 MB, Over 1 MB: `?size=small|medium|large`),
  each choice counted under the other sections' choices; and **Buckets**, only "Default" (see STUDY-12 §7.7).
  The custom day range and the order stay in Bar 2 with the storage-id lookup. Phones: a Views sheet.
- **Kinds** (`fileKind`, in the contract): `image/*` is an image; text, PDF, JSON, XML, RTF and office
  formats are documents; the rest (and no content type) is other.
- **Contract**: an optional `fileStats(filter?)` — count and bytes in all and per kind for the files matching
  a filter (time, kind, size) — and, from a source that offers it, `listFiles` honours `kind`, `minSize`,
  `maxSize`. Without `fileStats` the screen keeps §14.3's filters only (no views, sizes or counts). The mock
  implements both; the contract suite checks the counts, the bytes and the filtered lists.
- Tests: usage, views with counts and the URL, the current view marked, size counts under the view, Reset, the
  bucket; contract: stats and filters (sabotaged: a source ignoring `kind` fails it). e2e: the column header
  on Bar 1's line.

## 25. Authentication (the owner's call, 1 Oct 2026; a bunvex addition)

A screen to administer the app's own users, mock-first: there is no core implementation yet — the point is
to see everything the screen can offer. Concepts and names follow **better-auth** (users, accounts per
provider, sessions, verification, two-factor, passkeys, organizations / members / invitations, the admin
plugin's ban, impersonation and session revocation); STUDY-12 §7.8 cites what was read. In the sidebar under
**Manage**; `/auth` opens Users; every page is `/auth/<page>`.

### 25.1 The column and Users

- **Column**: "Authentication"; **Manage** — Users, Sessions, Organizations; **Configuration** — Sign in /
  Providers, Multi-factor, Passkeys, Sessions (lifetime), Rate limits, URL configuration, Emails, Audit. On
  Users, the filters below the nav: *Provider* and *Status* (verified, unverified, banned) as radios with the
  loaded users' counts (`?provider=`, `?status=`; the source filters).
- **Users**: Bar 1 — the page, its count and **Add user**, a split button (Add user creates; its menu: Create
  user, Invite by email), each a form in the docked panel; a created user opens. Bar 2 — search by name or
  email (`?q=`, 200 ms). The grid, full-bleed: avatar (initials) and name, email, providers, created, last
  sign-in, status.
- **The user's panel** (`?user=`, following the current row; `?tab=logs|json`): **Overview** — who they are
  (id with copy, email verified, role, created, last sign-in, two-factor, passkeys, the ban), their providers,
  *Send an email* (password reset, magic link, verify email when unverified), their sessions each with Revoke,
  and a **Danger zone**: Revoke all sessions, Remove MFA factors, Ban (1 hour, 1 day, 7 days, 30 days, for
  good; a reason) or Unban, Impersonate (a one-hour session, audited), Delete user — each asking first.
  **Logs** — the user's auth events. **Raw JSON** — the user record.

### 25.2 Sessions and Organizations

Full-bleed tables: every session (user, signed in, expires, device in words, IP, impersonated by, Revoke after
a confirmation); every organization (name, slug, members, pending invitations, created).

**An organization's panel** (2 Oct 2026, owner's follow-up): a row (click, Enter) opens it, docked, in the URL
(`?org=<id>&orgTab=members|invitations`), following the current row like Users. **Members**: name, email, role
(Owner / Admin / Member, changed in place), Remove after a confirmation (the user account stays); an
organization keeps an owner — the source refuses to demote or remove the last one and the panel says why.
**Invitations**: every status (Pending, Accepted, Rejected, Canceled — icon and word), newest first, with the
role, when it was sent and when a pending one expires; **Invite by email** with a role; **Resend** (extends
the expiry) and **Cancel** (after a confirmation) for pending ones. The counts in the grid are the members and
the pending invitations, so they stay true after a change.

### 25.3 Configuration

A form per page over its part of the configuration, saved alone (`updateAuthConfig({ <part> })`), with
Discard; read-only credentials see it disabled. **Sign in / Providers**: the sign-in methods (email and
password, magic link, Google, GitHub, Apple, Microsoft, passkey) with their client IDs, and **the token
providers** that were Settings → Authentication (§19.1; that page is gone, its address redirects here, and
Settings' column loses the item). **Multi-factor**: TOTP, email codes, backup codes, who must use one.
**Passkeys**: on/off, relying party name and ID. **Sessions**: lifetime, refresh age, fresh age. **Rate
limits**: on/off, max per window. **URL configuration**: site URL, redirect allow-list. **Emails**: subject and
body per template, now with the **variables** each email fills in (insert at the caret), a warning for one it
does not fill (it would reach the recipient as written), and a **preview** with sample values, light or dark,
rendered in a **sandboxed iframe** (`sandbox=""`: no scripts, no same origin) — plain text keeps its links and
line breaks, HTML is used as such (`auth/email-preview.ts`, pure and unit-tested). **Audit**: the auth events,
newest first.

### 25.4 Contract

`data-source-auth-admin.ts`: every method optional, detected with `typeof`; `listAuthUsers` offers the screen.
Users (paged, searched, filtered by provider and status), one user, create, invite, send an email, sessions
(all or a user's), revoke one or all, remove factors, ban / unban, impersonate, remove, organizations and
their members (list, change role, remove) and invitations (list, invite, resend, cancel), the configuration
(read; merge a part), auth events. The mock (`mock/auth-admin.ts`) implements them from its own
random stream; reads need `viewData`, writes `writeData` and not read-only. The contract suite
(`contract-auth-admin.ts`) checks the listing and its filters, create / ban (signing out) / unban / remove, and
the configuration's merge, and organizations: counts match members and pending invitations, the last owner
is kept, a role changes, an invitation is pending then canceled (and cannot be resent), a member is removed.

## 26. Extensions (the owner's call, 1 Oct 2026)

Some screens are experiments the owner may keep or remove (Analytics, Workflows, Feature flags…), and later
components may bring screens of their own. Such a screen is an **extension**: one folder,
`packages/dashboard/src/extensions/<id>/`, holding everything it needs, listed in three small registries.

- **What an extension declares** (`extensions/types.ts`, `DashboardExtension`): `id` (the folder's name),
  `title`, `icon`, `nav` (its sidebar group — `overview`, `data`, `functions`, `manage`, `observe` or its own
  `extensions` group before Settings — its order after the built-in entries, and the link), `routes` (path,
  the screen's module loaded lazily and the export's name, an optional `validateSearch`), `requires` (the
  contract methods it needs) and, when it has sub-screens, `column` (the section column's navigation, §23).
- **Its contract** is optional methods, as every feature since §14: their types live in its folder and join
  `DashboardDataSource` through `ExtensionFeatures` (`extensions/index.ts`). The sidebar shows the entry only
  when the source has every method in `requires`; a route reached anyway says the deployment does not offer
  it (`extensions/guard.tsx`, applied inside the lazy chunk).
- **Its mock part** (`extensions/mock.ts`, `MockExtensionPart`) gets a `MockContext` from `MockDataSource` —
  its random source, clock, `call` (latency, failures, abort), `can(operation)`, `record` (the audit log the
  History screen reads) and the mock's options — and returns the methods it adds.
- **Its contract-suite part** (`extensions/contract.ts`, `ContractExtensionPart`) runs inside
  `describeDataSourceContract` and tests only what the source offers (writes only when the suite's writes are on).
- **Links**: extension routes are in the router at run time but not in its types (their paths are plain
  strings, which would widen every built-in `DashLink` to `string`), so extensions link with `ExtensionLink`.
- **Inputs, not globals**: `<Dashboard extensions>`, `new MockDataSource({ extensions })` and
  `describeDataSourceContract(…, { extensions })` default to the registries and accept others — the tests use
  a sample extension (`test/fixtures/sample-extension.tsx`) this way, and a host can add screens of its own.
- **Adding one**: create the folder (the extension's declaration, its screen(s), its contract types, mock
  part and contract part) and add one line in each of `extensions/index.ts` (the declaration, and its features
  in `ExtensionFeatures`), `extensions/mock.ts` and `extensions/contract.ts`.
- **Removing one**: delete the folder and those lines; TypeScript points at any line left behind.

### 26.2 Analytics (an extension; STUDY-12 §16)

`extensions/analytics/` — a bunvex addition the owner may keep or remove. Sidebar: Observe, after History.

- **Realtime** (`/analytics/realtime`): the open WebSocket sessions are the live visitors. A world map shows
  one bubble per city, its area growing with the count, with a tooltip naming the city and how many. Beside
  it (above it on a phone): the distinct visitors of the last 30 minutes with a per-minute sparkline, the
  device split as a bar with the percentages in text, and the live events feed (a focusable scrolling list).
  Below: Pages, Referrers, Countries and Browsers, each a table with a bar behind the name (the bar is never
  the only number). Live through `watchAnalyticsRealtime`.
- **The map**: mapcn's `Map` (MIT, added with the shadcn CLI into `@bunvex/ui/components/map`) on MapLibre
  GL 6.11, with two changes so the dashboard stays offline and tells no third party it was opened: MapLibre's
  worker is bundled (Vite `?url`, never unpkg) and the default style is the tile-less blank one (never
  CARTO's hosted basemaps). The basemap is Natural Earth's 1:110m countries (public domain, via
  `world-atlas`, ISC), bundled, drawn in mapcn's theme-aware neutrals; rings crossing the antimeridian are
  unwrapped so they don't streak across the map; Antarctica is left out. Without WebGL 2 (tests, some VMs)
  the page says so and the Countries table stands in. The vendored `map.tsx` is formatted but not linted
  (`biome.json` override). A richer, online tile style could be a setting later.
- **Events, Sessions, Profiles**: full-bleed grids, newest first, paged as they scroll, a search in Bar 2,
  and the docked panel with the row's fields and its raw form (a literal) — it follows the current row once
  open. Events can be narrowed to one event name from the column (`?name=`).
- **Contract** (`extensions/analytics/data-source.ts`): optional `getAnalyticsRealtime`,
  `watchAnalyticsRealtime`, `listAnalyticsEvents`, `listAnalyticsSessions`, `listAnalyticsProfiles`, gated on
  `viewMetrics`; the contract part checks a consistent picture (30 per-minute values, device counts adding up
  to the visitors, sorted breakdowns, coordinates in range), newest-first lists that page, and a watch that
  never delivers synchronously. **Mock**: sessions over 30 days from weighted cities, with page views and a
  few custom events; `step` brings visitors, lets some go quiet and adds events (`analyticsIntervalMs`).
- **Chunks**: the Analytics screen and the map (MapLibre, the countries) load with the route only; the shell's
  entry never holds MapLibre (e2e). The map chunk is about 1.16 MB (≈ 320 kB gzip), MapLibre's worker a
  separate file.
- **Not yet** (server work): the client `track()` helper and automatic page views, the server-side GeoIP
  lookup that places a session, and retention of analytics events.
- **Map style** (2 Oct 2026): **Settings → Map style** (`settings-page.tsx`, `map-style.ts`) — the extension
  adds the page through the registry's `settings` entries, listed under an "Extensions" group of the Settings
  column only when the deployment offers Analytics. A MapLibre style URL (https, or http on localhost) is
  fetched once and checked (version 8, `sources`, `layers`), with a warning that each viewer's browser then
  contacts that provider and the map no longer works offline; "Use the built-in basemap" goes back. Kept in this
  browser per deployment (`bunvex:analytics-map-style:<scope>`); the Realtime map uses it, else the bundled
  countries.

### 26.3 Workflows and work pools (an extension; STUDY-12 §18)

`extensions/workflows/` — a bunvex addition the owner may keep or remove. Sidebar: Functions, after Schedules.

- **Runs** (`/workflows/runs`): every run, newest first — workflow, status (icon and word), current step,
  start, duration, steps, retries — with Status and Workflow filters in the section column (in the URL).
- **A run** (`?run=`, opens in place): the run's error on top when it failed; its steps as a **diagram** (React
  Flow, already the Schema's and Topology's dependency: one row per group of steps run together, side by side,
  an edge from each step of a group to each of the next; each node shows the kind, the function, the status
  in words, its tries and duration; a running step pulses, not under reduced motion; fixed, not draggable); a
  **timeline** (a bar per step on one axis from the run's start, the running one up to now); and the
  **journal** (each step's start, finish, tries, arguments and result or error, as literals). The selected step
  (`?step=`) is shared by the three; a node, a timeline row or a journal row selects it.
- **Actions** (a write-capable credential, behind a confirmation): **Cancel run** (a running one: its running
  and pending steps become canceled), **Rerun** (a new run with the same arguments, opened), **Restart from step
  N** (a new run that replays steps before N from this journal and runs again from N, opened). The mock records
  them in the audit log.
- **Work pools** (`/workflows/workpools`): per pool, running against `maxParallelism` (a bar; "full" in words
  when it is), pending, backing off, the last 24 hours, the retry policy in words, and completed / failed per
  minute over 30 minutes (a line chart with a legend and a table).
- **Contract** (`extensions/workflows/data-source.ts`): optional `listWorkflowRuns`, `getWorkflowRun`,
  `listWorkflowNames`, `listWorkpools` (reads, `viewData`) and `cancelWorkflowRun`, `rerunWorkflow`,
  `restartWorkflowFrom` (writes). The contract part checks runs newest first and filterable, a journal in
  index order whose groups never go back, statuses that agree (a finished run has no running step; a
  succeeded one only succeeded steps), pools within their parallelism; with writes on, cancel / rerun /
  restart (a restart keeps the replayed steps). **Mock**: four workflows (sequential steps, a parallel group,
  sleeps, an awaited event, a nested workflow) over two days, with retries and every outcome; three pools.
- Live: runs and pools refresh every 5 s while the screen is open (a source could push later).

## 27. The Overview (the owner's call, 1 Oct 2026; supersedes the Health screen of §9 slice 4 and §18.1's page)

Health becomes the **Overview** at `/` (nav "Overview"; `/health` redirects): the home page, Convex's Health
reshaped (STUDY-12 §6 item 3). Not an extension — a core screen (`screens/overview.tsx`, derivations in
`screens/overview-data.ts`, tested apart).

- **Summary**: the deployment (name · version · persistence), the client and HTTP actions URLs with copy, the
  **last deploy** and by whom (the newest `push_config` in the audit log), the **nodes** (→ Topology).
- **Now** (indicators with their last hour as sparklines, from the optional metrics methods): calls per minute
  (every function, summed over the top-k incl. the rest), failure rate (the worst function), latency p95 (the
  slowest of the 5 busiest), live connections (WebSockets on every node, from the topology; otherwise live
  subscriptions from the stats), documents (the tables' counts), file storage (`fileStats`). A window with
  no value reads "—"; a source without the method says so.
- **Needs attention** (`attention()`), critical first, each linking where to look: the deployment paused
  (→ Settings › General), a node down or behind the leader (→ Topology with the node), the store at ≥ 80 % of
  its connections (→ Topology), a function failing in the last 5 minutes (→ Functions › Statistics), scheduled
  runs ≥ 10 s late (→ Scheduled functions). Severity is said in words too.
- **Recent activity**: the latest audit events in words (→ History with the event) and the latest failed
  executions (→ Logs filtered to failures).
- **Get started**, when there are no tables or no functions: deploy (`bunx bunvex dev`), create a table
  (→ Database), and a copyable client snippet with the deployment's URL.
- **Metrics**: the charts of §18.1 (top functions, failure and cache rates, scheduler lag).
- **Engine**, collapsed: the commit clock with commits/s and the engine counters (`screens/engine.tsx`, the
  former Health content); they stream only while the section is open.

## 28. Feature flags (an extension, §26; a bunvex addition, STUDY-12 §17; 1 Oct 2026)

`extensions/flags/` — declaration (`/flags`, under Manage, shown when the source has `listFlags`), contract
types (`FlagsFeatures`), pure logic (`evaluate`, `bucketOf`, `pickFromRollout`, `flagProblem`, `ruleText`), the
mock part (five flags: a 25 % rollout with a staff rule, an A/B/C test, a JSON config that is off, a targeted
rule, an archived flag; their history; exposures following each flag's rollout), the contract part (shape;
writes when on), the screen and the editor.

- **Column**: the views (All flags, On, Off, Archived, with counts) and the Type filter; "New flag" on top.
- **Grid** (full-bleed): key, name, type, state (On / Off / Archived, in words), what it serves now, rules,
  updated. Search by key or name in Bar 2. The details follow the current row (click, arrows).
- **Details** (docked panel): the kill switch ("Turn off" asks first: everyone gets the off variant at once),
  Edit, Archive / Restore (asks first); tabs **Overview** (serving now — a rollout as a bar with its shares in
  words —, the variants, "Served, last hour" per variant), **Targeting** (the rules in words, in order; the
  default and the off variant; **who gets what**: an identity's attributes, `name=value` per line, and the
  variant it gets with why), **History**, **Code** (`useFlag("x")`, `ctx.flags.get("x")`).
- **Editor** (the same panel): key (new flags only, `^[a-z][a-z0-9_.-]{0,63}$`), name, description, type
  (fixed after creation), variants (true/false for boolean; names; names + JavaScript-literal JSON values), the
  off variant, the default (one variant or a percentage rollout), rules (conditions: attribute, operator,
  comma-separated values; serve a variant), "Turn it on now" for a new flag. Checked as typed (`flagProblem`),
  checked again by the source on save.
- **Who may change**: a credential that can write data and is not read-only (STUDY-12 FF2). Every change is in
  the flag's history and the audit log (`create_feature_flag`, `update_feature_flag`, `enable_…`, `disable_…`,
  `archive_…`, `restore_…`); the History screen words unknown actions generically (`describeEvent`'s fallback).
- URL: `?view=&type=&q=&flag=&tab=&editor=new|edit`.

## UX review 2 (the owner approved all 28 findings, 2 Oct 2026)

The second design review (after the design language of §23–§28) found 28 inconsistencies; the owner approved
every one. They land in five pull requests, one subsection each.

### UX review 2 — filters and forms (UX2-2, UX2-3, UX2-5, UX2-21, UX2-23, UX2-24)

- **One Bar 2 recipe** (UX2-2): inline controls, vertically centred, no labels above inputs (`BAR2` is
  `items-center`). Files' Bar 2 is the storage-ID lookup and Order; its custom upload-date range moved into
  the column under the Uploaded presets (as History's), so the date filter is no longer in two places.
- **No browser chrome in forms** (UX2-3): `@bunvex/ui` gains `ChoiceSelect` (a single choice in the design
  system's Select), `ChoiceRadios` (Base UI RadioGroup with a label) and `FilePicker` (a button, the file's
  name and a drop zone over a hidden `<input type="file">`). The flag editor and Snapshots use them; a test
  (`test/native-controls.test.ts`) fails on any `<select>` or native file/radio/checkbox input outside an
  explicit allow-list (the column's facet radios, Files' hidden upload input, the Schema toolbar's toggle, and
  — until the Authentication pull request — two Authentication selects).
- **No error before typing** (UX2-5): the new-flag form says nothing until something is typed; Create stays
  disabled meanwhile (as the filters since UX-2).
- **The Database bar keeps one row when narrow** (UX2-21): below a 42 rem table width (the panel open) "Index",
  "Order" and the buttons' first words go to screen readers only.
- **Facets** (UX2-23): many-valued facets are checkboxes with **Only** on hover/focus — Schedules' Function
  facet too (one function is filtered by the source, several over the loaded runs; "Cancel all" only with none
  or one picked); radios stay for exclusive ranges (days, size). A facet's "All" is named "All: <facet>".
- **History's actions** (UX2-24): short words ("Env var added", "Run canceled") grouped by area — Data, Files,
  Environment variables, Schedules, Deploys, Other — as labelled groups.

### UX review 2 — consistency components (UX2-6, UX2-7, UX2-8, UX2-11, UX2-12, UX2-13, UX2-20, UX2-22)

- **One tab pattern** (UX2-6): `TabsList` is underlined (`variant="line"`, 13 px) by default — Functions, the
  flag panel, the Topology node panel, the Database schema panel and the Authentication user panel alike.
- **One destructive trigger** (UX2-8): a delete or cancel on a row, a panel or a bar is `destructive-outline`
  (Files' Delete, env vars' Delete, Delete selected, Cancel run, Cancel all, Pause, Turn off); only the confirm
  button inside a confirmation dialog is the filled `destructive`.
- **Status badges** (UX2-12): `StatusBadge` gains state words — on, off, archived, verified, unverified,
  banned, active, revoked — so a flag's state is an icon and a word, never a solid pill (Authentication uses
  them in its pull request).
- **One time rule** (UX2-20, `shell/time.tsx`): grids show `YYYY-MM-DD HH:mm:ss`; log lines add milliseconds
  and drop the date for today; summaries show a relative time with the absolute one in the tooltip
  (`RelativeTime`); no `toLocaleString`.
- **Section column nav** (UX2-22): headings only when the column has more than one group or filters below
  (`SectionNav withFilters`); Analytics' pages are one group.
- **The phone button** (UX2-13): named after what the column holds — the screen's name with a chevron
  ("Settings ▾", "Files ▾", "Analytics ▾") when it holds navigation, "Filters" when only filters.
- **Logs' Export and Clear** (UX2-11): already one rule on `main` — labelled when the logs area is at least
  42 rem wide, icons when narrower, the same on the Logs screen and the Functions → Logs tab (checked at 1440:
  labelled in both); unchanged.
- **Copy buttons** (UX2-7) are only on Authentication's Sign in / Providers: its pull request.

### UX review 2 — Overview and pages (UX2-1, UX2-4, UX2-9, UX2-10, UX2-16, UX2-17, UX2-26, UX2-28)

- **The main nav is pinned** (UX2-1): from `md` it is `sticky`, as tall as the viewport, and scrolls on its
  own, so a long page never shows where the sidebar ends (an e2e test checks it after scrolling).
- **The empty Database** (UX2-4) uses a table's frame: the section column (search, Create table, an empty
  Tables list saying "No tables yet.") and Bar 1 ("Database · No tables yet"), the empty state centred where the
  grid goes; below `lg` (no column) the empty state keeps its own Create table.
- **Settings pages don't repeat their title** (UX2-9): a page renders its actions into Bar 1 through
  `BarActions` (Environment variables: "Copy all as .env", "Add a variable"); the body starts with its content.
- **Logs keep the message in view** (UX2-10): with the details panel open the columns run Time, Level,
  Message, Outcome, Function, Request; the Functions → Logs tab has no Function column (it is always the open
  function).
- **Overview** (UX2-16, UX2-17, UX2-26): the summary is one row of four — both URLs in one cell — and Bar 1 no
  longer repeats the deployment's name and version from the header; "Needs attention" runs across the page
  above the indicators, and Recent activity sits beside the Metrics charts; numbers in attention items use
  `formatCount`; a finished Get started step has a check and "Done", and the snippet's copy button is inside
  the code block's corner.
- **Topology's windows** (UX2-28): the node panel says "last minute" (the samples' interval counted once per
  sample, then said as a person would), not "last 59 s".

### UX review 2 — canvases and charts (UX2-14, UX2-15, UX2-25, UX2-27)

- **Readable canvases** (UX2-14): `fitOptions` (shell/flow-controls) fits a small graph (up to six nodes) at
  85–125 % and a big one never past 100 % — Schema and Workflows use it; a workflow without parallel steps runs
  left to right. Topology keeps "never past 100 %" (the owner found bigger cards too big, §22), and its cards'
  text goes from 11 to 12 px (labels 11 px).
- **The workflow timeline** (UX2-15): a long idle gap — no step running, over a fifth of the run and over a
  minute — is drawn short with a ⫽ marker saying how long it was ("Compress waits", on by default, can be
  turned off); each bar says its duration; bars are at least 4 px.
- **Charts** (UX2-25): `LineChart` bridges a missing stretch with a lighter dashed line instead of leaving
  fragments, and its direct labels stay inside the plot (pushed up from the bottom, still a line apart).
- **Analytics on a phone** (UX2-27): the visitors card, then the map (260 px), the breakdowns, and the live
  feed last — five items until "Show N more".
