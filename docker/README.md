# Self-hosting bunvex with Docker

A bunvex deployment in a container, brought up as a Convex self-hosted backend is
([STUDY-38](../docs/study/STUDY-38-docker.md)): the image runs `bunvex-local-backend` (the backend executable,
see below) through the same scripts Convex's image uses. By default it keeps everything (the database, files, pushed
code and its credentials) in a Docker volume, in SQLite. Point it at Postgres, MySQL or MongoDB when you need to.

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

## Configure it

Set these in the shell or in a `.env` file next to `docker-compose.yml`:

| Variable | What it does |
|---|---|
| `PORT`, `SITE_PROXY_PORT` | The host ports (default 3210, 3211). |
| `BUNVEX_CLOUD_ORIGIN`, `BUNVEX_SITE_ORIGIN` | The public URLs of the API and HTTP actions: file URLs and the built-in `BUNVEX_CLOUD_URL` / `BUNVEX_SITE_URL` (default `http://127.0.0.1:<port>`). |
| `POSTGRES_URL`, `MYSQL_URL` | Use Postgres or MySQL instead of SQLite. Without a database in the URL, it connects to the instance name's (`bunvex_self_hosted` by default), as Convex. |
| `PERSISTENCE`, `PERSISTENCE_URL` | Or name the driver: `sqlite`, `postgres`, `mysql`, `mongodb`. |
| `DO_NOT_REQUIRE_SSL` | Allow an unencrypted database connection (a local database). |
| `S3_STORAGE_FILES_BUCKET`, `S3_STORAGE_MODULES_BUCKET`, `S3_STORAGE_EXPORTS_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `S3_ENDPOINT_URL`, `AWS_S3_FORCE_PATH_STYLE` | Keep files, pushed code and exports in S3 (each use case whose bucket is set). |
| `S3_STORAGE_SEARCH_BUCKET`, `S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET` | The search and vector index segments ([STUDY-111](../docs/study/STUDY-111-search-segments.md)) and uploaded snapshot imports in S3, as Convex's buckets of the same names. Read once S3 is on, which the entry script turns on only when one of the files, modules or exports buckets is set; without their bucket these two stay in the volume (`storage/search`, `storage/snapshot_imports`). |
| `AWS_S3_DISABLE_SSE`, `AWS_S3_DISABLE_CHECKSUMS` | `true` for an S3-compatible store that refuses them: uploads ask for server-side encryption (`AES256`) and CRC32 part checksums by default, as Convex's. Only the exact value `true` turns one on. |
| `INSTANCE_NAME`, `INSTANCE_SECRET` | The instance's name and secret (32 bytes, hex). By default, generated on the first start and kept in the volume. |
| `REDACT_LOGS_TO_CLIENT` | Keep functions' log lines and errors' details from clients. |
| `DOCUMENT_RETENTION_DELAY` | How long old document versions are kept, in seconds (default here: 2 days). |
| `DISABLE_METRICS_ENDPOINT` | `true` (the default here, as Convex's file) answers `/metrics` with 404; `false` serves the Prometheus metrics there, on both ports, with no auth ([STUDY-114](../docs/study/STUDY-114-prometheus-metrics.md)). |

**Tuning.** Every limit and timing parameter of Convex's
[`knobs.rs`](https://github.com/get-convex/convex-backend/blob/main/crates/common/src/knobs.rs) that applies to
bunvex is an environment variable under the same name, with the same default (the list:
[STUDY-147 §3.1](../docs/study/STUDY-147-knob-env-overrides.md#31-the-knobs-classified)). Add the ones you set
to the service's `environment:` in `docker-compose.yml`. A value that does not parse is logged and the default
used; an override is logged at start.

**Screening outbound requests (SSRF).** An action's `fetch` can reach any address the container can,
including private ones and cloud metadata. As Convex's `--convex-http-proxy`, `--http-proxy <url>` sends
actions' `fetch`, auth providers' discovery and JWKS, and log streams (but Sentry's) through a screening
proxy such as [Smokescreen](https://github.com/stripe/smokescreen), which refuses private addresses with a
407; each request carries the instance name as `Proxy-Authorization`. Add it to the service's `command:`
(the entry script passes its arguments on). Without it, bunvex screens those requests itself
(`--deny-addresses`: `metadata` by default refuses link-local and cloud metadata addresses, `private` also
loopback and private networks, `none` nothing, as Convex — DV-325;
[STUDY-80](../docs/study/STUDY-80-outbound-requests.md)).

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
  `OTEL_TRACES_EXPORTER` without `otlp` turns it off. A bunvex addition
  ([STUDY-131](../docs/study/STUDY-131-debugging-and-observability.md) §9, AD-26).
- **Request timeout.** `HTTP_SERVER_TIMEOUT_SECONDS` (default 300, as Convex's): a request with no response head
  by then is answered 408, on every route ([STUDY-147](../docs/study/STUDY-147-knob-env-overrides.md) §3.3). It is
  one of the knobs of **Tuning** above.
- **Database call timeouts.** `POSTGRES_TIMEOUT_SECONDS` (30), `MYSQL_TIMEOUT_SECONDS` (19) and
  `MONGODB_TIMEOUT_SECONDS` (30) bound one database call. They are read when the server is configured from the
  environment (`persistenceConfigFromEnv`, when embedding `@bunvex/server`); this image and the executable use
  those defaults and do not read the variables yet.
- **Outbound requests.** The image takes the flags (`--http-proxy`, `--deny-addresses`, see **Screening
  outbound requests** above). `BUNVEX_HTTP_PROXY` and `BUNVEX_DENY_ADDRESSES` are their variable forms for a
  server embedded with `createServer` from `@bunvex/server` (default: no proxy, and `metadata`); the executable
  does not read them.
- **The CLI's update check.** `bunvex dev` and `bunvex deploy` ask the npm registry once a day for a newer
  release; `BUNVEX_DISABLE_VERSION_CHECK` (any value), `NO_UPDATE_NOTIFIER` or `CI` turns it off. It is set
  where the CLI runs, not in the container.
- **Metrics.** `DISABLE_METRICS_ENDPOINT=false` serves Prometheus metrics at `/metrics` (see the table above).
- **Logs.** `bunvex logs` follows the functions' log lines
  ([STUDY-47](../docs/study/STUDY-47-log-streaming.md)); log streams send them, with audit and other events, to a
  webhook, Datadog, Axiom, Sentry or PostHog ([STUDY-59](../docs/study/STUDY-59-log-streams.md),
  [STUDY-70](../docs/study/STUDY-70-provider-sinks.md)).
- **Streaming export.** The `list_snapshot`, `document_deltas` and `json_schemas` APIs that change-data-capture
  connectors read ([STUDY-60](../docs/study/STUDY-60-streaming-export.md)).

## Upgrade it

Export first (`bunvex export --path ./backups --include-file-storage`), then rebuild or pull the new image and
`docker compose up -d`: the volume keeps the database, files, pushed code and credentials. A release that cannot
read the store refuses it untouched; then move the data by export and import.
[docs/upgrading.md](../docs/upgrading.md) has the steps, and how to move between Convex and bunvex.

## Without Docker: the executable

Each release on GitHub has `bunvex-local-backend-<target>.zip` for macOS (arm64, x64), Linux (arm64, x64) and
Windows (x64): the backend as one file that needs nothing installed, as Convex's precompiled
`convex-local-backend` ([STUDY-40](../docs/study/STUDY-40-local-backend-and-local-deployments.md)). As
Convex's "running the binary directly" guide:

```sh
export INSTANCE_SECRET=$(openssl rand -hex 32)
./bunvex-local-backend keygen admin-key --instance-name bunvex-self-hosted --instance-secret "$INSTANCE_SECRET"
./bunvex-local-backend --instance-name bunvex-self-hosted --instance-secret "$INSTANCE_SECRET"
```

The database is `bunvex_local_backend.sqlite3` in the current directory; for Postgres,
`--db postgres postgres://…` (without a database in the URL, the instance name's, `-` replaced by `_`). `--help` lists the other options (ports,
public origins, storage). To build it yourself: `bun scripts/build-binary.ts --host` (into `dist/bin/`).

## Build the image

The compose file builds it from this repository. To build it alone, from the repository root:

```sh
docker build -f docker/Dockerfile -t bunvex-backend .
```

`docker/smoke.sh` brings a deployment up, deploys and runs a function from the host, and restarts it
(`SMOKE_POSTGRES=1` for Postgres).
