# STUDY-40 — The local backend executable, local deployments in `bunvex dev`, and the npm package

- **Status:** accepted: all as recommended (owner, 2026-10-02)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`convex` 1.46.0)
- **Related:**
  - [STUDY-39](STUDY-39-standalone-binary.md): the executable and its release. The owner answered B1 on 2026-10-02: the backend alone, `bunvex-local-backend-<target>.zip`, as Convex. On B4: make `bunvex dev` work as Convex's now that there is an executable.
  - [STUDY-37](STUDY-37-cli-and-environment-variables.md): `bunvex start` (E1), and `dev`'s in-process local deployment (E6), which this replaces.
  - [STUDY-38](STUDY-38-docker.md): the image.

## 1. How Convex does it

### 1.1 `convex-local-backend` (`crates/local_backend/src/config.rs`, `main.rs`)

**Flags** (clap):

| Flag | Default | Notes |
|---|---|---|
| `<db_spec>` (positional) | `convex_local_backend.sqlite3` | A SQLite path, or a Postgres/MySQL server URL |
| `-d, --db` | `sqlite` | `postgres-v5`, `mysql-v5` |
| `-i, --interface` | `0.0.0.0` | |
| `-p, --port` | `3210` | |
| `--site-proxy-port` | `3211` | |
| `--convex-origin` / `--convex-site` | `http://127.0.0.1:<port>` / `<site-port>` | A pair; each must be http(s) |
| `--instance-name` | `carnitas` | Requires `--instance-secret` |
| `--instance-secret` | none | Required: "--instance-secret is required. Generate one with `openssl rand -hex 32`" |
| `--local-storage` / `--s3-storage` | `convex_local_storage` / false | One or the other |
| `--do-not-require-ssl`, `--disable-beacon`, `--redact-logs-to-client`, `--convex-http-proxy`, `--local-log-sink` | | |

- **Hidden flags:** `--beacon-tag`, `--beacon-fields`, `--sentry-identifier`, `--control-plane-*`.
- **The `keygen admin-key` subcommand:** `keygen admin-key --instance-name <n> --instance-secret <hex>` prints one admin key on stdout.
- **Signals:** SIGINT drains requests and exits.

The binary never generates a secret. The Docker scripts do that (`read_credentials.sh`), and so does the CLI for a local deployment.

### 1.2 Local deployments in `npx convex dev` (`cli/lib/localDeployment/*`)

**Which deployment**
- With no deployment configured and no account (or not on a terminal), the CLI uses an **anonymous** local deployment named `anonymous-<basename(cwd)>`. With an account, a local one is `local-<team>-<project>`.
- `.env.local` gets:
  - `CONVEX_DEPLOYMENT=<type>:<name>`, under the comment ``# Deployment used by `npx convex dev` ``;
  - the client's URL variables, named after the framework found in `package.json`: `VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` for Vite, `NEXT_PUBLIC_CONVEX_URL` for Next, `EXPO_PUBLIC_`, `REACT_APP_`, `PUBLIC_` for SvelteKit, else `CONVEX_URL`;
  - and `.env.local` is added to `.gitignore` unless something there already covers it.

**The executable**
- **Version:** the latest, from a version service (`version.convex.dev`). `--local-backend-version` pins one.
- **Download:** `https://github.com/get-convex/convex-backend/releases/download/<version>/convex-local-backend-<target>.zip`.
- **Cache:** unzipped and made executable in `~/.cache/convex/binaries/<version>/` (`%LOCALAPPDATA%\convex` on Windows). There is no checksum.
- **Upgrades:** when a deployment's stored version is older, the CLI asks "Upgrade now?". It is yes without a terminal, or with `--local-force-upgrade`.

**State**
- Since 1.46 it lives in the project: `<cwd>/.convex/local/default/`, with a `.convex/.gitignore` of `/*`.
- That directory holds `config.json`, `convex_local_storage/` and `convex_local_backend.sqlite3`.
- `config.json` is `{ ports: {cloud, site}, backendVersion, adminKey, instanceSecret, deploymentName }`.
- The secret is 32 random bytes, and the admin key comes from the executable's `keygen admin-key`.

**Running it**
- The command line is `<bin> --port <cloud> --site-proxy-port <site> --instance-name <name> --instance-secret <secret> --local-storage <state>/convex_local_storage <state>/convex_local_backend.sqlite3`.
- It runs as a child of `dev`, with stdio ignored, and gets SIGTERM when `dev` exits.
- **Health:** `/instance_name` is polled every 500 ms, for up to 30 s (`CONVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS`). Another instance's name on that port is an error.
- **Ports:** the saved ones, else the first free ones from 3210. `--local-cloud-port` and `--local-site-port` must be free.
- **Already running:** if that same deployment still answers on its port after 5 s, the CLI says "A local backend is still running on port N. Please stop it and run this command again."
- **One-off commands** (`run`, `env`, …): they start the deployment just for the command when it is not running (`withRunningBackend`).
- **Anonymous mode** also serves a local dashboard, `dashboard.zip` from the same release, on port 6790.

### 1.3 The `convex` npm package

**Contents**
- One package holds the library (`convex/server`, `/react`, `/browser`, `/values`, `/nextjs`, …) and the CLI: `bin: { convex: bin/main.js }`, run as `npx convex`.
- It is built to `dist/` with ESM, CJS and `.d.ts` (tsc, plus esbuild per file). The CLI is one esbuild bundle (`dist/cli.bundle.cjs`) for Node 20.
- The TypeScript sources ship too. `engines` is `node >= 20`.

**Releasing:** `prepack` checks the version and builds; `postpack` strips the internal types. No `npm publish` workflow is in the repository.

## 2. What a user can observe

1. **The release:** `bunvex-local-backend-<target>.zip` on the repository's Releases. One executable with Convex's flags, and `keygen admin-key`, as the self-hosting guide uses it.
2. **`bunvex dev` with nothing configured:**
   - It downloads the latest executable once and runs a deployment for the project in `.bunvex/local/default/`.
   - It writes `.env.local`, with the deployment and the client's URL variable, then pushes and watches.
   - The deployment stops when `dev` stops, and the next `dev` resumes it.
3. **One-off commands** against that deployment work while `dev` runs, or start it for the command.
4. **Installing:** `npm`/`bun add bunvex`, then the `bunvex` command.

## 3. How bunvex does it

**`bunvex-local-backend`** (L1)
- It is a program of its own (`packages/server/src/local-backend.ts`, entry `packages/bunvex/bin/local-backend.ts`), compiled per platform as STUDY-39 compiles the CLI.
- **Flags:** Convex's, with bunvex's names where rule 5 asks (`--cloud-origin` / `--site-origin`). Also `--db sqlite|postgres|mysql|mongodb`, and the `<db_spec>` positional. A Postgres/MySQL URL names its database (DV-110).
- **`--instance-secret` is required**, with Convex's message. `--instance-name` defaults to `bunvex-self-hosted`, as the store's default (Convex: `carnitas`).
- **Subcommands and `--version`:** `keygen admin-key`, and `--version`.
- **The release** (`release-binaries.yml`) carries `bunvex-local-backend-<target>.zip`. `bunvex-<target>.zip` (the CLI as one file) goes away.

**`bunvex start` and Docker** (L2)
- The image runs the executable through Convex's scripts: `read_credentials.sh` (the env, else the volume's files, else generated), then `run_backend.sh` execs `bunvex-local-backend`.
- `generate_admin_key.sh` calls `bunvex-local-backend keygen admin-key`.
- The image can carry the compiled executable alone, without the workspace, which also makes it smaller.
- `bunvex start` (DV-178) goes away. `bunvex admin-key` (DV-160) stays, because it also reads a running store.

**Local deployments in `bunvex dev`** (L3–L6)
- **Selection:** with no `BUNVEX_SELF_HOSTED_*` and no `BUNVEX_DEPLOYMENT`, `dev` creates a local deployment. bunvex has no accounts, so this behaves as Convex's anonymous mode, without the account prompts.
- **Name:** `local-<basename(cwd)>` (L3).
- **`.env.local`:**
  - `BUNVEX_DEPLOYMENT=local:<name>` under the comment ``# Deployment used by `bunvex dev` ``;
  - the client's URL variables by framework (`VITE_BUNVEX_URL`, `NEXT_PUBLIC_BUNVEX_URL`, …, else `BUNVEX_URL`, and the `*_SITE_URL` ones);
  - `.env.local` is added to `.gitignore` when nothing there covers it.
- **The executable** (L4):
  - the latest `precompiled-*` release of `bunvex/bunvex`, from GitHub's API (there is no version service), or `--local-backend-version`;
  - downloaded to `~/.cache/bunvex/binaries/<version>/` (`%LOCALAPPDATA%\bunvex` on Windows);
  - Convex's upgrade prompt and `--local-force-upgrade`.
  - `BUNVEX_LOCAL_BACKEND_BINARY=<path>` uses a given executable instead (L5), for tests, offline work and this repository's own development.
- **State:** `.bunvex/local/default/`, with its `.gitignore`, holding:
  - `config.json` (`ports`, `backendVersion`, `adminKey`, `instanceSecret`, `deploymentName`);
  - `bunvex_local_storage/`;
  - `bunvex_local_backend.sqlite3`.
- **Running:** Convex's command line, child process, health check (`/instance_name`, 500 ms, 30 s, `BUNVEX_LOCAL_BACKEND_STARTUP_TIMEOUT_SECS`), ports (`--local-cloud-port`, `--local-site-port`), the "still running" check, and SIGTERM on exit.
- **The other commands:** `deploy`, `run`, `env` and `codegen` read `BUNVEX_DEPLOYMENT=local:…` and start the deployment for the command when it is not running.
- **No local dashboard** until item 12 (L6).
- The in-process local deployment of STUDY-37 E6 goes away.

**The npm package** (L7)
- **Now:** reserve the name. Publish `bunvex@0.0.1` (a README saying what bunvex is and that it is not released yet), under the owner's account. The `@bunvex` scope is already the owner's organization on npm.
- **Later, as a roadmap item:** the real package, as Convex's.
  - `bunvex` with the library's subpaths and the `bunvex` command, built to JS and `.d.ts`. That closes STUDY-36 G5: no `allowImportingTsExtensions`.
  - Released with changesets (already in the repository).
  - The CLI needs Bun, since the server it embeds uses Bun's APIs, so it runs as `bunx bunvex`. `engines.bun` is set, and the library's client and React parts stay usable from Node bundlers.

**What happened, and the plan for the names** (owner, 2026-10-02)

npm refused `bunvex@0.0.1`: "403 Package name too similar to existing package convex". npm blocks names close to popular packages, and `bunvex` is two letters from `convex`. The owner asked npm's support to allow it (a request from `danielmartinsdev`, 2026-10-02). The `@bunvex` scope is already the owner's.

Until npm answers, two ways in, with one documented at a time:
- **`@bunvex/*`** (published first): `@bunvex/server`, `@bunvex/values`, `@bunvex/react`, …, and `@bunvex/cli`, whose binary is still `bunvex`. That gives `bunx bunvex dev` with `@bunvex/cli` installed, or `bunx @bunvex/cli dev`.
- **`bunvex`**, once allowed: the umbrella that re-exports the `@bunvex/*` packages, as today in the repository. Apps may move from one to the other at any time.
- **One copy of each module:** every package is released at the same version (a changesets "fixed" group), and `bunvex` depends on exact versions. An app then never holds two copies of `@bunvex/server` or `@bunvex/react`. Two copies would not recognize each other's functions (the registry's `WeakSet`) or React provider.
- **Codegen:** it imports from whichever the app depends on (`bunvex` when its `package.json` has it, else `@bunvex/*`).
- **A preview first:** `0.1.0-alpha.*`, published from the TypeScript sources, which Bun runs from `node_modules`. It is enough to try the whole flow in a new directory with Bun. It needs `allowImportingTsExtensions`, which `codegen --init` writes (STUDY-36 G5), and frameworks such as Next.js need to transpile the dependencies.
- **The built package** (JS and `.d.ts`) remains the roadmap item.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| L1 | `bunvex-local-backend`'s flags are Convex's, but with `--cloud-origin` / `--site-origin` (Convex: `--convex-origin` / `--convex-site`). `--db` takes `sqlite`, `postgres`, `mysql`, `mongodb` (Convex: `postgres-v5`, `mysql-v5`). The default instance name is `bunvex-self-hosted` (Convex: `carnitas`) | rule 5; bunvex's driver names; the store's default name | accepted (owner, 2026-10-02) |
| L2 | `bunvex start` is removed. The Docker image runs `bunvex-local-backend` through Convex's scripts (`read_credentials.sh`, `run_backend.sh`, `generate_admin_key.sh`) | the executable is now the backend, as in Convex; one way to run it | accepted (owner, 2026-10-02) |
| L3 | A local deployment is named `local-<basename(cwd)>`, and `dev` needs no account or prompt to create one (Convex: anonymous mode, `anonymous-<basename>`) | bunvex has no accounts | accepted (owner, 2026-10-02) |
| L4 | The latest executable comes from GitHub's releases API (the newest `precompiled-*` marked latest). Convex asks a version service | there is no version service | accepted (owner, 2026-10-02) |
| L5 | `BUNVEX_LOCAL_BACKEND_BINARY` uses a given executable instead of downloading one | tests, offline work, and running this repository's own build | accepted (owner, 2026-10-02) |
| L6 | No local dashboard until item 12 | as STUDY-38 K3 | accepted (owner, 2026-10-02) |
| L7 | Reserve `bunvex` on npm now with a placeholder `0.0.1`; publish the real package later as its own item. The CLI runs on Bun (`bunx bunvex`); Convex's runs on Node (`npx convex`) | the server inside the CLI is a Bun program | accepted (owner, 2026-10-02) |

## 5. Tests

**`bunvex-local-backend`**
- Flags: defaults, pairs, the secret check and its messages.
- `keygen admin-key` gives a key the server accepts.
- `scripts/smoke-binary.sh` reworked as Convex's guide: secret, `keygen`, run, deploy with the CLI, restart.

**`bunvex dev` with a local deployment**, using `BUNVEX_LOCAL_BACKEND_BINARY` to point at a build:
- the first run: state, `config.json`, `.env.local` and `.gitignore`;
- the pushes;
- stopping `dev` stops the backend, and the next run resumes the same data and ports;
- the "still running" check;
- an occupied port;
- the upgrade prompt;
- `run` against a stopped local deployment.

**Download:** against a local HTTP server that serves a release's API answer and zip.

**Docker:** `docker/smoke.sh`, unchanged in what it checks.
