# Self-hosting bunvex with Docker

A bunvex deployment in a container, brought up as a Convex self-hosted backend is
([STUDY-38](../docs/study/STUDY-38-docker.md)): the image runs `bunvex-local-backend` (the backend executable,
see below) through the same scripts Convex's image uses. By default it keeps everything (the database, files, pushed
code and its credentials) in a Docker volume, in SQLite. Point it at Postgres or MySQL when you need to.

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
| `POSTGRES_URL`, `MYSQL_URL` | Use Postgres or MySQL instead of SQLite. The URL names the database. |
| `PERSISTENCE`, `PERSISTENCE_URL` | Or name the driver: `sqlite`, `postgres`, `mysql`, `mongodb`. |
| `DO_NOT_REQUIRE_SSL` | Allow an unencrypted database connection (a local database). |
| `S3_STORAGE_FILES_BUCKET`, `S3_STORAGE_MODULES_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT_URL`, `AWS_S3_FORCE_PATH_STYLE` | Keep files and pushed code in S3 (each use case whose bucket is set). |
| `INSTANCE_NAME`, `INSTANCE_SECRET` | The instance's name and secret (32 bytes, hex). By default, generated on the first start and kept in the volume. |
| `REDACT_LOGS_TO_CLIENT` | Keep functions' log lines and errors' details from clients. |
| `DOCUMENT_RETENTION_DELAY` | How long old document versions are kept, in seconds (default here: 2 days). |

**Screening outbound requests (SSRF).** An action's `fetch` can reach any address the container can,
including private ones and cloud metadata. As Convex's `--convex-http-proxy`, `--http-proxy <url>` sends
actions' `fetch`, auth providers' discovery and JWKS, and log streams (but Sentry's) through a screening
proxy such as [Smokescreen](https://github.com/stripe/smokescreen), which refuses private addresses with a
407; each request carries the instance name as `Proxy-Authorization`. Add it to the service's `command:`
(the entry script passes its arguments on). Without it, bunvex screens those requests itself
(`--deny-addresses`: `metadata` by default refuses link-local and cloud metadata addresses, `private` also
loopback and private networks, `none` nothing, as Convex — DV-325;
[STUDY-80](../docs/study/STUDY-80-outbound-requests.md)).

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
`--db postgres postgres://…/<database>` (the URL names the database). `--help` lists the other options (ports,
public origins, storage). To build it yourself: `bun scripts/build-binary.ts --host` (into `dist/bin/`).

## Build the image

The compose file builds it from this repository. To build it alone, from the repository root:

```sh
docker build -f docker/Dockerfile -t bunvex-backend .
```

`docker/smoke.sh` brings a deployment up, deploys and runs a function from the host, and restarts it
(`SMOKE_POSTGRES=1` for Postgres).
