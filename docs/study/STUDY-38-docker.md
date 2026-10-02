# STUDY-38 — The Docker image and docker-compose

- **Status:** draft (K1–K6 await the owner)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`self-hosted/`)
- **Related:**
  - roadmap item 10 ([parity README](../parity/README.md));
  - [STUDY-37](STUDY-37-cli-and-environment-variables.md) (`bunvex start`, E1; `bunvex admin-key --data-dir`);
  - [STUDY-34](STUDY-34-admin-keys.md);
  - [STUDY-32](STUDY-32-file-storage.md) (S3 per use case);
  - [STUDY-25](STUDY-25-persistence-lifecycle.md) (database selection).

## 1. How Convex does it

**The image** (`self-hosted/docker-build/Dockerfile.backend`)
- It is built in stages:
  1. Rust builds `convex-local-backend` and `generate_key`.
  2. The final stage is `ubuntu:noble` with `curl`, CA certificates, and Node and npm (for Node actions).
- It sets `WORKDIR /convex`, `VOLUME /convex/data`, `EXPOSE 3210 3211` and `ENTRYPOINT ["./run_backend.sh"]`.
- It is published as `ghcr.io/get-convex/convex-backend:<rev>` and `:latest`.

**`run_backend.sh`**
- **Paths:** `DATA_DIR=/convex/data`, `TMPDIR`, `STORAGE_DIR=$DATA_DIR/storage`, `SQLITE_DB=$DATA_DIR/db.sqlite3`.
- **Credentials:** it sources `read_credentials.sh`.
- **Database:** `POSTGRES_URL`, else `MYSQL_URL`, else `DATABASE_URL` (deprecated, with a warning), else SQLite.
- **Storage:**
  - S3 only when `AWS_REGION` and all five `S3_STORAGE_{EXPORTS,SNAPSHOT_IMPORTS,MODULES,FILES,SEARCH}_BUCKET` are set;
  - when only some are set, it prints "Warning: Some AWS/S3 environment variables are missing. Falling back to local storage." and lists them.
- **The exec:** `convex-local-backend` with `--instance-name`, `--instance-secret`, `--port 3210`, `--site-proxy-port 3211`, `--convex-origin "$CONVEX_CLOUD_ORIGIN"` and `--convex-site "$CONVEX_SITE_ORIGIN"`. It adds `--disable-beacon`, `--redact-logs-to-client` and `--do-not-require-ssl` when their variables are set.

**`read_credentials.sh`**
- `INSTANCE_SECRET` comes from the env, else `$DATA_DIR/credentials/instance_secret`, else `openssl rand -hex 32`.
- `INSTANCE_NAME` comes from the env, else its file, else `convex-self-hosted`.
- Both are written back to their files.

**`generate_admin_key.sh`:** reads the same credentials, then prints `generate_key "$INSTANCE_NAME" "$INSTANCE_SECRET"`.

**`docker/docker-compose.yml`**
- **The `backend` service:**
  - `ports` `${PORT:-3210}:3210` and `${SITE_PROXY_PORT:-3211}:3211`;
  - the volume `data:/convex/data`;
  - `stop_signal: SIGINT` and `stop_grace_period: 10s`;
  - a healthcheck, `curl -f http://localhost:3210/version`, every 5 s with a 10 s start period;
  - environment passed through: the knobs (`APPLICATION_MAX_CONCURRENT_*` default 16, `DOCUMENT_RETENTION_DELAY` default 172800 = 2 days, `DISABLE_METRICS_ENDPOINT` default true), the database and S3 variables, `INSTANCE_NAME` / `INSTANCE_SECRET`, `REDACT_LOGS_TO_CLIENT`, `DO_NOT_REQUIRE_SSL`, and `CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` (default `http://127.0.0.1:${PORT}` / `${SITE_PROXY_PORT}`).
- **The `dashboard` service:** port 6791, `NEXT_PUBLIC_DEPLOYMENT_URL`, and it starts once the backend is healthy.

**The documented flow** (`self-hosted/README.md`)
1. Run `docker compose up`.
2. Run `docker compose exec backend ./generate_admin_key.sh`.
3. Put `CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY` in `.env.local`.
4. Run `npx convex dev`.

## 2. What an app can observe

1. **Bringing it up:** one `docker compose up` brings a deployment up on 3210 / 3211, with data in a named volume. It keeps its data and credentials across restarts.
2. **Getting a key:** `docker compose exec backend ./generate_admin_key.sh` prints an admin key on stdout.
3. **Configuration:** the database, S3, the instance and the public origins are set by environment variables in the compose file.
4. **Health:** the container is healthy once `/version` answers.

## 3. How bunvex does it

**`docker/Dockerfile`** (the repository root is the build context)
- **Base:** `oven/bun:1-slim` (Debian), with `curl` and CA certificates.
- **Install:** the workspace's packages are copied and installed with `bun install --production --frozen-lockfile`. bunvex runs its TypeScript sources as they are, so there is no compile step.
- **Paths:** `WORKDIR /bunvex`, `VOLUME /bunvex/data`, `EXPOSE 3210 3211`.
- **Entrypoint:** `run_backend.sh`, which ends in `exec bun packages/bunvex/bin/bunvex.ts start --data-dir /bunvex/data --port 3210 --site-proxy-port 3211 …`.
  - `bunvex start` already does `read_credentials.sh`'s job (STUDY-37 E1).
  - The origins come from `BUNVEX_CLOUD_ORIGIN` / `BUNVEX_SITE_ORIGIN` (K2), with the same defaults as Convex.
  - The database and S3 variables are read by the server, as outside Docker.
- **`generate_admin_key.sh`:** runs `bunvex admin-key --data-dir /bunvex/data`, so Convex's command works as it is: `docker compose exec backend ./generate_admin_key.sh`.

**`docker/docker-compose.yml`:** Convex's `backend` service with bunvex's variables, the same ports, volume, stop signal and healthcheck. No dashboard service yet (K3).

**`docker/README.md`:** Convex's flow, in bunvex's words: `docker compose up`, `generate_admin_key.sh`, `.env.local` with `BUNVEX_SELF_HOSTED_*`, then `bunvex dev`.

**Publishing:** a GitHub Actions workflow builds the image on every PR. It pushes `ghcr.io/bunvex/bunvex-backend:latest` and `:<sha>` from `main` (K5).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| K1 | The image runs `bunvex start` from the workspace's TypeScript sources on `oven/bun`. Convex ships compiled binaries on Ubuntu, with Node for Node actions | bunvex is a Bun program and has no compile step; `"use node"` actions run in the same process (DV-169) | pending |
| K2 | The origins are `BUNVEX_CLOUD_ORIGIN` / `BUNVEX_SITE_ORIGIN` (already the server's names), not `CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN`. Paths are `/bunvex/data` rather than `/convex/data` | rule 5 | pending |
| K3 | No `dashboard` service until the dashboard runs on a real deployment (item 12) | the dashboard app today shows mock data | pending |
| K4 | Storage: S3 per use case, when that use case's bucket is set (STUDY-32), rather than Convex's all-or-nothing on five buckets. The entry script warns when `AWS_REGION` is missing while a bucket is set | bunvex uses two buckets (files, modules); requiring five, three of them unused, would block S3 | pending |
| K5 | The image is published to `ghcr.io/bunvex/bunvex-backend` (`:latest` and `:<sha>`) by a workflow on `main` | Convex's compose file pulls `ghcr.io/get-convex/convex-backend`; the compose file needs an image to pull. Publishing is outward-facing, so the owner decides when to turn it on | pending |
| K6 | The knobs bunvex has no counterpart for are left out of the compose file: `DISABLE_METRICS_ENDPOINT`, `RUST_LOG` / `RUST_BACKTRACE`, `CONVEX_RELEASE_VERSION_DEV`, the Node action limits | there is nothing for them to set | pending |

## 5. Tests

**An end-to-end smoke test** (`docker/smoke.sh`)
1. Build the image and start the compose project on free ports.
2. Wait for health.
3. Get a key with `generate_admin_key.sh`.
4. Run `bunvex deploy` for an example app from the host, then `bunvex run`.
5. Restart the container, check that the data and the key survive, then tear down.

**CI:** a workflow job runs the smoke test on PRs that touch `docker/` or the packages (K5).

## 6. Open questions

- Whether to keep Convex's `DATA_DIR` / `TMPDIR` / `SQLITE_DB` variables. bunvex reads `DATA` for the data directory, and the SQLite file is always `bunvex.sqlite` in it.
