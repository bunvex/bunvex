# Self-hosting bunvex with Docker

A bunvex deployment in a container, brought up the way a Convex self-hosted backend is: the image runs
`bunvex-local-backend` (the backend executable, see below) through the same scripts as Convex's image. By default it
keeps everything (the database, files, pushed code and its credentials) in a Docker volume, in SQLite. Point it at
Postgres or MySQL when you need to.

## Start it

From this directory:

```sh
docker compose up
```

The API listens on `http://127.0.0.1:3210` and HTTP actions on `http://127.0.0.1:3211` (set `PORT` and
`SITE_PROXY_PORT` to change the host ports).

Then get an admin key for the CLI:

```sh
docker compose exec backend ./generate_admin_key.sh
```

## Use it from your app

In your app's `.env.local` (keep it out of source control):

```sh
BUNVEX_SELF_HOSTED_URL='http://127.0.0.1:3210'
BUNVEX_SELF_HOSTED_ADMIN_KEY='<your admin key>'
```

Then:

```sh
bunvex dev          # push the functions in bunvex/, and again on every change
bunvex deploy       # push once
bunvex run messages:list
bunvex env set API_KEY 'secret'
```

## The dashboard

`docker compose up` also starts the dashboard, in its own container from its own image, at
`http://127.0.0.1:6791` (`DASHBOARD_PORT` changes the host port). Its sign-in page comes
with the deployment's URL filled in; paste the admin key from `generate_admin_key.sh`. No key is passed to the
container: the dashboard keeps it in the page's memory, and a reload asks again.

The browser talks to the backend directly, so `BUNVEX_DEPLOYMENT_URL` must be the backend's URL as the browser
reaches it (default `http://127.0.0.1:$PORT`). Without Docker, `bunvex dashboard serve --deployment-url <url>`
serves the same app (`--help` for its options). [docs/dashboard.md](../docs/dashboard.md) covers the dashboard:
running it, signing in, its settings, and what it shows live.

The dashboard's security headers let only its own pages frame it
(`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`). To embed it in another site's page, which then signs
it in (see [the dashboard's README](../apps/dashboard/README.md#embedding-the-dashboard)), build the image with
that site's origins, which are fixed at build time:

```sh
docker build -f docker/dashboard.Dockerfile --build-arg VITE_BUNVEX_EMBED_ORIGINS="https://admin.example.com" -t bunvex-dashboard .
```

Only the listed origins may frame it then (`frame-ancestors 'self' https://admin.example.com`). Set
`BUNVEX_DASHBOARD_IMAGE=bunvex-dashboard` for `docker compose` to run that image.

## Configure it

Set these in the shell or in a `.env` file next to `docker-compose.yml`:

| Variable | What it does |
|---|---|
| `PORT`, `SITE_PROXY_PORT` | The host ports (default 3210, 3211). |
| `BUNVEX_CLOUD_ORIGIN`, `BUNVEX_SITE_ORIGIN` | The public URLs of the API and HTTP actions: file URLs and the built-in `BUNVEX_CLOUD_URL` / `BUNVEX_SITE_URL` (default `http://127.0.0.1:<port>`). |
| `POSTGRES_URL`, `MYSQL_URL` | Use Postgres or MySQL instead of SQLite. Without a database in the URL, it connects to the instance name's (`bunvex_self_hosted` by default). |
| `PERSISTENCE`, `PERSISTENCE_URL` | Or name the driver: `sqlite`, `postgres`, `mysql`. |
| `DO_NOT_REQUIRE_SSL` | Allow an unencrypted database connection (a local database). |
| `S3_STORAGE_FILES_BUCKET`, `S3_STORAGE_MODULES_BUCKET`, `S3_STORAGE_EXPORTS_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `S3_ENDPOINT_URL`, `AWS_S3_FORCE_PATH_STYLE` | Keep files, pushed code and exports in S3 (each use case whose bucket is set). |
| `S3_STORAGE_SEARCH_BUCKET`, `S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET` | The search and vector index segments and uploaded snapshot imports in S3. Setting any of the five buckets turns S3 on; a use case without its bucket stays in the volume (`storage/search`, `storage/snapshot_imports`). |
| `AWS_S3_DISABLE_SSE`, `AWS_S3_DISABLE_CHECKSUMS` | `true` for an S3-compatible store that refuses them: uploads ask for server-side encryption (`AES256`) and CRC32 part checksums by default. Only the exact value `true` turns one on. |
| `INSTANCE_NAME`, `INSTANCE_SECRET` | The instance's name and secret (32 bytes, hex). By default, generated on the first start and kept in the volume. The backend reads the secret from its environment, never from its command line, which every user of the host can read. |
| `REDACT_LOGS_TO_CLIENT` | Keep functions' log lines and errors' details from clients: a failing function answers only `[Request ID: …] Server Error` (a `BunvexError`'s data is still sent). Off by default, as Convex's self-hosted backend, which suits development; **set it in production**, so that clients never see stack traces, messages or log lines meant for you. |
| `DOCUMENT_RETENTION_DELAY` | How long old document versions are kept, in seconds (default here: 2 days). |
| `DASHBOARD_PORT`, `BUNVEX_DEPLOYMENT_URL` | The dashboard's host port (default 6791) and the backend URL its sign-in page is filled in with (in place of Convex's `NEXT_PUBLIC_DEPLOYMENT_URL`). `BUNVEX_ADMIN_KEY` on the `dashboard` service would fill in the key too (in place of Convex's `NEXT_PUBLIC_ADMIN_KEY`): only on a machine nobody else reaches. |
| `DISABLE_METRICS_ENDPOINT` | `true` (the default here) answers `/metrics` with 404; `false` serves the Prometheus metrics there, on both ports, with no auth. |

**Tuning.** Every limit and timing parameter of Convex's
[`knobs.rs`](https://github.com/get-convex/convex-backend/blob/main/crates/common/src/knobs.rs) that applies to
bunvex is an environment variable under the same name, with the same default. Add the ones you set to the
service's `environment:` in `docker-compose.yml`. A value that does not parse is logged and the default
used; an override is logged at start.

**Screening outbound requests (SSRF).** An action's `fetch` can reach any address the container can,
including private ones and cloud metadata. `--http-proxy <url>` (Convex's `--convex-http-proxy`) sends
actions' `fetch`, auth providers' discovery and JWKS, and log streams (but Sentry's) through a screening
proxy such as [Smokescreen](https://github.com/stripe/smokescreen), which refuses private addresses with a
407; each request carries the instance name as `Proxy-Authorization`. Add it to the service's `command:`
(the entry script passes its arguments on). Without it, bunvex screens those requests itself
(`--deny-addresses`: `metadata` by default refuses link-local and cloud metadata addresses, `private` also
loopback and private networks, `none` nothing). `metadata` stays the default because a self-hosted deployment
often calls services on its own network (another container of the compose file, an internal API). **In
production, use `--deny-addresses private`** unless your actions must reach such a service: then an action whose
URL comes from a user cannot reach your database, your admin ports or the host.

**Where functions run (the function sandbox).** `BUNVEX_FUNCTION_SANDBOX` chooses the executor, and
`--function-sandbox` on the command line wins over it:
- `vm` (the default): functions run in the backend's own process, in `node:vm` contexts. They get their own
  globals, but this is not a security boundary: run only code you trust. Under `vm`, four things differ from Convex,
  whose functions each run in an isolate of their own:
  - **A synchronous loop is not stopped.** The 1 s limit of a query or mutation is checked at each database call and
    at the end, so code that never yields (`for (;;) {}`) blocks the whole backend: every function, the sync
    WebSockets and the HTTP API. A query or mutation an execution worker runs is the exception: the queries and
    mutations of your deployed code run on worker threads once one has started, and one that never yields is stopped
    at its limit ("Function execution timed out"), its worker replaced, while the backend goes on answering. Actions,
    the first calls after a start or a deploy, and a mutation that creates a table, returns or writes
    `db.vars.commitTs`, or runs while a schema change is validated still run on the backend's own thread.
  - **No memory cap per call.** A function that would fail on Convex past 64 MiB keeps running, and a large one can
    take the backend's memory.
  - **An unhandled promise rejection does not fail the function.** It is printed to the backend's log, and the
    function goes on: a mutation that Convex would fail commits its writes. Await or catch every promise.
  - **Module-level variables are shared.** A module is evaluated once per deployed version, and its top-level
    variables live between calls (on Convex, only for functions that opt into `experimental_reuseContext`). Each
    execution worker evaluates it once more, so a query or mutation sees the variables of the worker it ran on. Do not keep one user's data in a module variable.
- `process`: each call runs in a separate process, with a real timeout and a 96 MiB memory cap per call
  (`ISOLATE_MAX_USER_HEAP_SIZE` + `ISOLATE_MAX_HEAP_EXTRA_SIZE`), and an unhandled rejection fails the call, as on
  Convex. It costs about 55–140 µs more per call and 40–280 µs more per database call. This release runs it only
  with `BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`, which adds no OS isolation, so it is not a security boundary yet;
  `auto`, `namespaces` and `landlock` (Linux only) refuse to start until they are built. `"use node"` actions are
  not available under it yet. Not on Windows.

A value outside these lists stops the backend at start. `bunvex dev` passes its environment to the local
backend it starts, and never sets the variable itself.

## Observability and tuning

Each variable below is read by the backend in the container; add the ones you set to the service's
`environment:` in `docker-compose.yml` (compose passes only the variables listed there).

- **Tracing (OpenTelemetry).** Off unless an endpoint is set. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is the
  traces URL as is; else `OTEL_EXPORTER_OTLP_ENDPOINT` is the base and `/v1/traces` is appended. Also read:
  `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_(TRACES_)TIMEOUT`
  (ms, default 10000), `OTEL_EXPORTER_OTLP_(TRACES_)PROTOCOL` (only `http/json` is spoken), `OTEL_TRACES_SAMPLER`
  / `OTEL_TRACES_SAMPLER_ARG` (default `parentbased_always_on`), `OTEL_SERVICE_NAME` (default `bunvex`),
  `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_BSP_MAX_QUEUE_SIZE` (2048), `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` (512),
  `OTEL_BSP_SCHEDULE_DELAY` (5000 ms), `OTEL_BSP_EXPORT_TIMEOUT` (30000 ms); `OTEL_SDK_DISABLED=true` or an
  `OTEL_TRACES_EXPORTER` without `otlp` turns it off.
- **Request timeout.** `HTTP_SERVER_TIMEOUT_SECONDS` (default 300): a request with no response head by then is
  answered 408, on every route. It is one of the knobs of **Tuning** above.
- **Database call timeouts.** `POSTGRES_TIMEOUT_SECONDS` (30) and `MYSQL_TIMEOUT_SECONDS` (19) bound one database
  call. This image and the executable read them, and so does a server embedding `@bunvex/server`
  (`persistenceConfigFromEnv`). `PG_CA_FILE` and `MYSQL_CA_FILE` add a CA certificate for the TLS connection.
- **Outbound requests.** The image takes the flags (`--http-proxy`, `--deny-addresses`, see **Screening
  outbound requests** above). `BUNVEX_HTTP_PROXY` and `BUNVEX_DENY_ADDRESSES` are their variable forms for a
  server embedded with `createServer` from `@bunvex/server` (default: no proxy, and `metadata`); the executable
  does not read them.
- **The CLI's update check.** `bunvex dev` and `bunvex deploy` ask the npm registry once a day for a newer
  release; `BUNVEX_DISABLE_VERSION_CHECK` (any value), `NO_UPDATE_NOTIFIER` or `CI` turns it off. It is set
  where the CLI runs, not in the container.
- **SQLite's page cache.** `BUNVEX_SQLITE_CACHE_SIZE` (bytes, default `2048000`, SQLite's 2 000 KiB, as Convex)
  sizes the cache SQLite keeps in the backend's memory, on top of the OS's own page cache. What a bigger one buys,
  measured on a 2-vCPU VPS:
  - **Memory:** the cache fills up to its size as the store is read and written, then stays there. With 256 MiB
    the process holds ~280–365 MB more than with 2 000 KiB once the database file is that large.
  - **Read speed:** on the backend's read path (queries, with the index cache in front of SQLite and mutations
    committing), 256 MiB was within the noise of 2 000 KiB: +3 % reads a second without writes, −6 % under them
    (the writes drop the readers' cache). A store far bigger than memory is bound by the disk at any size.
  - So the default suits most hosts. Raise it only if a measurement of your own workload shows a gain.

  The value is a whole number of bytes, rounded up to a KiB; one that does not parse, `0`, or more than SQLite
  takes stops the backend at start, saying so. `0` is refused by design: SQLite has no "off",
  and `cache_size = 0` keeps its minimum, the slowest setting. It applies to
  SQLite stores only. It is the backend's total: with execution workers, the backend's own connection keeps half
  and the workers share the other half.
- **Execution workers (off by default).** With `MAX_ISOLATE_WORKERS` set to a count (Convex's name), the queries and
  mutations of your deployed code run on up to that many worker threads, so they use more than one core; the
  backend's own thread still commits every mutation. Unset or `0`, every function runs on the backend's own thread,
  the default until the workers are hardened. A worker
  starts when a call finds none free, and each holds its share of the page cache
  (above) and of the index cache. On Postgres and MySQL each worker opens connections of its own, within
  `POSTGRES_MAX_CONNECTIONS` / `MYSQL_MAX_CONNECTIONS` (128), which stay the backend's total: the backend keeps a
  quarter (at least 8), and the workers share the rest, at least 2 each, so a small pool starts fewer workers, and
  one under 10 none.
- **Queries per connection.** `BUNVEX_MAX_QUERIES_PER_CONNECTION` (default 4096) is the most queries one sync
  connection may hold. Each `useQuery` is one, and so is each loaded page of a paginated query. A client that asks
  for more is disconnected with "Too many queries on this connection"; raise the value if your app really needs more,
  or set `0` for no cap (Convex has none). It bounds the memory one socket can make the backend hold, about 11 KB a
  query.
- **Metrics.** `DISABLE_METRICS_ENDPOINT=false` serves Prometheus metrics at `/metrics` (see the table above).
- **Logs.** `bunvex logs` follows the functions' log lines; log streams send them, with audit and other events, to
  a webhook, Datadog, Axiom, Sentry or PostHog.
- **Streaming export.** The `list_snapshot`, `document_deltas` and `json_schemas` APIs that change-data-capture
  connectors read.

## Upgrade it

Export first (`bunvex export --path ./backups --include-file-storage`), then rebuild or pull the new image and
`docker compose up -d`: the volume keeps the database, files, pushed code and credentials. A release that cannot
read the store refuses it untouched; then move the data by export and import.
[docs/upgrading.md](../docs/upgrading.md) has the steps, and how to move between Convex and bunvex.

## Without Docker: the executable

Each release on GitHub has `bunvex-local-backend-<target>.zip` for macOS (arm64, x64), Linux (arm64, x64) and
Windows (x64): the backend as one file that needs nothing installed. To run it:

```sh
export INSTANCE_SECRET=$(openssl rand -hex 32)
./bunvex-local-backend keygen admin-key --instance-name bunvex-self-hosted
./bunvex-local-backend --instance-name bunvex-self-hosted
```

Both read the secret from `INSTANCE_SECRET`. `--instance-secret <hex>` works too, and wins over the variable,
but puts the secret on the command line, where any user of the machine reads it (`ps`, `/proc/<pid>/cmdline`).

The database is `bunvex_local_backend.sqlite3` in the current directory; for Postgres,
`--db postgres postgres://…` (without a database in the URL, the instance name's, `-` replaced by `_`). `--help` lists the other options (ports,
public origins, storage). To build it yourself: `bun scripts/build-binary.ts --host` (into `dist/bin/`).

## Build the image

The compose file builds it from this repository. To build it alone, from the repository root:

```sh
docker build -f docker/Dockerfile -t bunvex-backend .
docker build -f docker/dashboard.Dockerfile -t bunvex-dashboard .
```

`docker/smoke.sh` brings a deployment up, deploys and runs a function from the host, and restarts it
(`SMOKE_POSTGRES=1` for Postgres). `docker/smoke-dashboard.sh` brings the backend and the dashboard up and signs
in to the dashboard in Chromium.
