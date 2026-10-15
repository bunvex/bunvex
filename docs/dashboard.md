# The dashboard

The dashboard shows a bunvex deployment's data, functions, logs, schedules, files, health and settings, and lets
you edit them. It is bunvex's own app (its screens are [STUDY-12](study/STUDY-12-dashboard.md)'s), and it reads a
deployment the way Convex's self-hosted dashboard does ([STUDY-149](study/STUDY-149-dashboard-real-data.md)): the
same system functions over the WebSocket, the same HTTP routes, the same credential (an admin key), and the same
freshness, screen by screen. It is a separate app, as Convex's is: the backend never serves it.

> [!WARNING]
> **bunvex is an alpha** ([Status](../README.md#status)). The dashboard edits your data for real: a document
> deleted there is deleted.

## 1. Running it

**With a local deployment** (`bunvex dev` with nothing configured, as Convex's local deployments): a long-running
`bunvex dev` also serves the dashboard, signed in to the project's deployment, at `http://127.0.0.1:6790` (the first
free port from 6790), and stops it when it stops. The app is the release's `dashboard.zip`, downloaded on first use
(the version of `--local-backend-version`, else the latest release's) and kept in `~/.cache/bunvex/dashboard/`.
`bunvex dev --once` and `--until-success` serve none.

```sh
bunvex dev                  # in one terminal
bunvex dashboard            # in another: opens it in the browser
bunvex dashboard --no-open  # prints its URL instead
```

`bunvex dashboard` checks that the dashboard on the saved port is this deployment's before opening it; when `dev`
is not running it says "You are not currently running the dashboard locally. Make sure `bunvex dev` is running and
try again." On a self-hosted deployment it says it is not supported, as Convex's `npx convex dashboard` does: use
the dashboard you run beside the backend (below).

**With Docker** ([docker/README.md](../docker/README.md#the-dashboard)): `docker compose up` starts the backend
and the dashboard, each in its own container from its own image (as Convex's `convex-dashboard`; built from the
repository until `ghcr.io/bunvex/bunvex-dashboard` is published, `BUNVEX_DASHBOARD_IMAGE` to use another). The
dashboard listens on `http://127.0.0.1:6791`.

**Without Docker**: `bunvex dashboard serve` serves the same app from any machine with the CLI:

```sh
bunvex dashboard serve --deployment-url http://127.0.0.1:3210
```

| Option | What it does |
|---|---|
| `--port <port>` | The port (default 6790). |
| `--hostname <address>` | The address to listen on (default `127.0.0.1`; `0.0.0.0` for every interface). |
| `--deployment-url <url>` | The URL the sign-in page is filled in with (default `BUNVEX_DEPLOYMENT_URL`). |
| `--admin-key <key>` | The admin key the sign-in page is filled in with (default `BUNVEX_ADMIN_KEY`). |
| `--dir <path>` | Serve a dashboard build from this directory instead of the release's `dashboard.zip`. |
| `--version <version>` | The release whose `dashboard.zip` to serve (default the latest). |

`bunvex dashboard serve` is a bunvex addition (AD-40): Convex's CLI only serves its local dashboard from
`npx convex dev`.

## 2. Signing in

The dashboard opens on a sign-in page that asks for the **deployment URL** (the backend as the browser reaches
it, `http://127.0.0.1:3210` for the Docker defaults) and an **admin key**:

- a self-hosted deployment's key comes from `docker compose exec backend ./generate_admin_key.sh` (or the
  executable's `keygen admin-key`, or `bunvex admin-key`);
- the local dashboard needs none: it signs in by itself with the credentials its server hands out at
  `/api/current_deployment`, as Convex's local dashboard does.

The key is checked against the deployment (`GET /api/check_admin_key`, three tries 500 ms apart). A read-only key
signs in read-only: what a key may do is what `check_admin_key` answers. The key is kept in the page's memory only: a reload asks again, and
**Sign out** forgets it. **Use the demo data** opens the screens on sample data without a deployment.

The dashboard can also be signed in by a page that shows it in an `<iframe>`, from parent origins you allow
([apps/dashboard/README.md](../apps/dashboard/README.md#embedding-the-dashboard)); none are allowed by default.

## 3. Configuration

| Setting | Where | What it does |
|---|---|---|
| `BUNVEX_DEPLOYMENT_URL` | the `dashboard` service, `bunvex dashboard serve` | The deployment URL the sign-in page is filled in with (Convex's `NEXT_PUBLIC_DEPLOYMENT_URL`). The compose file defaults it to `http://127.0.0.1:$PORT`. |
| `BUNVEX_ADMIN_KEY` | the same | The admin key the sign-in page is filled in with (Convex's `NEXT_PUBLIC_ADMIN_KEY`). Anyone who can open the page gets the key: set it only on a machine nobody else reaches. |
| `DASHBOARD_PORT` | the compose file | The dashboard's host port (default 6791). |
| 6790 | `bunvex dev`, `bunvex dashboard serve` | The local dashboard's port, or the first free one after it; saved in `.bunvex/local/default/dashboard.json` for `bunvex dashboard`. |
| 6791 | the image | The port the dashboard's container listens on. |

Both values are read when the page is served, so one build serves any deployment. They only fill in the form: the
browser talks to the backend directly (the backend allows any origin, as Convex's does), so the URL must be one the
browser can reach.

**The `Host` check.** A dashboard serving a local deployment hands out its admin key at `/api/current_deployment`.
bunvex answers that route only on a loopback address and only to a `Host` of `127.0.0.1:<port>` or
`localhost:<port>`, so a web page that rebinds its own name to 127.0.0.1 cannot read the key (DV-476; Convex's
local dashboard answers any `Host`). Open the local dashboard at `127.0.0.1` or `localhost`: under any other name
it shows the sign-in page. The Docker image and `bunvex dashboard serve` without a local deployment do not offer the
route at all (404, as Convex's image).

## 4. When the dashboard cannot be downloaded

Convex's `npx convex dev` stops when it cannot download its local dashboard. `bunvex dev` warns and keeps running
(DV-486): offline, with the release service failing, or with a release that has no `dashboard.zip`, it serves the
dashboard already in the cache, or runs without one. `bunvex dashboard` then says why ("`bunvex dev` is running
without the local dashboard: it could not be downloaded (…). Restart `bunvex dev` once it can be.").

## 5. Links from the CLI

While `bunvex dev` serves the local dashboard, the CLI points at the screen to look at, where Convex's CLI prints a
link to its cloud dashboard (DV-477):

| Where | The link |
|---|---|
| `bunvex dev`, when it writes `.env.local` | "View the bunvex dashboard at `http://127.0.0.1:6790/`" |
| `bunvex export` | "Export is available at …/settings/snapshots"; with an export already running, "Check its progress at …" |
| `bunvex import` | with an import already running, "You can view its progress at …/settings/snapshots." |
| a push that adds a staged index | "See progress: …/database/`<table>`?panel=indexes" under each one |
| a push waiting more than 10 s on its indexes or its schema check | "see progress here: …" |
| a push refused for an environment variable the auth config needs | "Go to: …/settings/environment-variables to set it up." |
| the MCP server's `status` tool | `dashboardUrl` |

With no local dashboard running, and on every self-hosted deployment, these print no link (the CLI does not know
where a self-hosted dashboard is).

## 6. What is live and what is polled

As Convex's dashboard ([STUDY-149 §1.2](study/STUDY-149-dashboard-real-data.md#12-per-screen-mechanism-freshness-and-calls)):

| Screen | Freshness |
|---|---|
| Data: the table list, documents, sizes, indexes, schema | live (a subscription) |
| Data: inferred types | every 60 s |
| Functions: the list, the runner's query, its argument validator | live |
| Functions: a function's charts | once per time window |
| Functions: a mutation's invalidations | every 8 s |
| Logs | a long poll: a line shows within one round trip of its execution |
| Health: calls, failure rate, cache hit rate, concurrency, invalidations | every 8 s |
| Health: scheduler lag | every 60 s |
| Schedules, Files | live, paused automatically past 100 updates in 10 s (Pause / Go live, Refresh while paused) |
| History (audit log), environment variables, deployment state | live |
| Topology | every 5 s (the server samples its counters every 5 s; a minute of history) |

While the deployment cannot be reached, "Connection issue" covers the screens and the polls stop; when it comes
back the polls ask again at once and the subscriptions resume.

## 7. Known gaps

- The custom test query has no type checking or completions (Convex ships its server's declarations to the
  browser).
- No bulk edit of documents yet (bulk edit: in progress), and the Data screen's index list leaves out search,
  vector and staged indexes. Going to a system table's document by its id is not offered.
- The environment variables screen does not open a given variable from a link (Convex's `?var=`).
- Cloud-only screens are absent, as in Convex's self-hosted dashboard: insights, backups, custom domains, team,
  billing and usage. bunvex keeps its own additions that work on a deployment (the Overview's summary,
  Snapshots in Settings, the command palette, the Logs screen's histogram and export, Topology).
- Some of bunvex's own screens open on the demo data only, and are hidden on a deployment (or say it does not
  offer them): Subscriptions and the system tables (their server side exists; the dashboard does not read it
  yet), and Authentication's user management, the clients, Analytics, Feature flags and Workflows (no server
  side yet). The Files screen's storage used, views by type and size filters need sizes per kind,
  which a deployment does not report ([additions.md](parity/additions.md)).
- Topology shows the deployment's one process, the leader. It shows the clients connected to it (the dashboard's
  own socket among them), its query cache, its commits per second and the store's lease. A credential needs
  ViewMetrics to see it. There are no followers until bunvex runs more than one node (STUDY-24). The deployment
  does not report its memory limit, the store's size or connections, or who the clients are, so those show as
  "—" or are left out ([STUDY-131 §11](study/STUDY-131-debugging-and-observability.md#11-ad-04s-server-side-the-topology-endpoint-built-2026-10-14)).
- No telemetry and no legacy deployment list (`?a=<port>&d=<name>`), which Convex keeps for old CLIs.
