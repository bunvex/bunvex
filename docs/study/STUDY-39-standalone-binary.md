# STUDY-39 — The standalone executable (Convex's precompiled `convex-local-backend`)

- **Status:** draft (B1–B4 await the owner; the owner asked for it "as Convex does", 2026-10-02)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - [STUDY-37](STUDY-37-cli-and-environment-variables.md) (`bunvex start`, E1; `bunvex dev`'s local deployment, E6);
  - [STUDY-38](STUDY-38-docker.md) (the Docker image).

## 1. How Convex does it

**The binary**
- `convex-local-backend` is the backend as one Rust executable: `self-hosted/advanced/running_binary_directly.md`.
- A user downloads it from GitHub Releases, generates a secret (`openssl rand -hex 32`) and an admin key (`generate_key`), and runs `./convex-local-backend --instance-name … --instance-secret …`.
- The database lives in the current directory, or in Postgres / MySQL with `--db … <url>`.

**Building and releasing** (`.github/workflows/precompile.yml`)
- A push to the `release` branch, or a manual run, triggers it.
- It builds `convex-local-backend` for five Rust targets on their own runners: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`.
- Each is zipped as `convex-local-backend-<target>.zip`, beside a `dashboard.zip`, and attached to a prerelease `precompiled-<date>-<sha7>`.

**Promotion** (`promote_local_backend.yml`, manual)
- It checks that the tag is a `precompiled-*` release, not a draft, with every zip uploaded.
- Then it marks it the latest release.

**The CLI** (`cli/lib/localDeployment/download.ts`)
- `npx convex dev` with a local deployment downloads the latest release's zip for the host's platform.
- It unzips it and runs it.

## 2. What a user can observe

1. **Download:** a zip per platform on the repository's Releases, holding one executable that needs nothing else installed.
2. **The guide's steps:** run it in a directory, get an admin key, push code to it, restart it on the same data.
3. **Release cadence:** prereleases from the `release` branch; the latest one is promoted by hand.

## 3. How bunvex does it

**The executable**
- `bun build --compile` turns the `bunvex` CLI into one file per platform, from Bun's cross-compiling targets: `bun-darwin-arm64`, `-x64`, `bun-linux-arm64`, `-x64`, `bun-windows-x64`.
- The entry is `packages/bunvex/bin/standalone.ts`.
  - It carries the persistence drivers and their database clients (`postgres`, `mysql2`, `mongodb`), which the bundler cannot reach through their computed imports.
  - It registers them in a small registry in `@bunvex/core` that the loaders check first.

**Building:** `scripts/build-binary.ts` builds every target, or one, or the host's, into `dist/bin/bunvex-<target>.zip` with Convex's target names. `bunvex --version` prints the build's name.

**Workflows**
- `binaries.yml`: on PRs, every target is built, and the Linux (SQLite and Postgres) and macOS ones are run end to end by `scripts/smoke-binary.sh`.
- `release-binaries.yml`: a push to `release`, or a manual run, creates the prerelease `precompiled-<date>-<sha7>`.
- `promote-binaries.yml`: Convex's checks, then the release becomes the latest.

**Fixes the bundle needed**
- `sorted-btree`'s default export: inside a bundle a lazily loaded module imports CommonJS the Node way, so a `btree.ts` helper takes the class either way.
- The typecheck runs the app's `tsc` with `process.execPath`, which is bunvex itself in the executable. It now sets `BUN_BE_BUN=1`, so the executable acts as Bun.
- `dev --start` uses `cmd /c` on Windows.

**Measured**
- Builds: 18 s for the five targets, cross-compiled on one machine.
- Zips: 25–39 MB. The executable is 60 MB on macOS arm64.
- The guide's flow (start, admin key, deploy with codegen, run, restart) passes on macOS arm64 on SQLite and Postgres, and on Linux arm64 in a container with no Bun installed.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| B1 | The executable is the whole `bunvex` CLI, so `bunvex start` runs the server and the same file deploys, runs and generates code. The zip is `bunvex-<target>.zip`. Convex's is the backend alone (`convex-local-backend-<target>.zip`); its CLI is npm's | bunvex's server and CLI are one program; one file covers the guide's every step | pending |
| B2 | No `dashboard.zip` in the release until the dashboard runs on a real deployment (item 12) | as STUDY-38 K3 | pending |
| B3 | The Windows executable is built and released but not yet run in CI. Linux and macOS are | a Windows smoke run is to come (the script is bash) | pending |
| B4 | `bunvex dev` does not download the executable for a local deployment: it runs one in its own process (STUDY-37 E6) | the CLI already is the server | pending |

## 5. Tests

- **`scripts/smoke-binary.sh`:**
  - `--version`;
  - start in an empty directory, checking the database it chose;
  - `admin-key`;
  - `deploy` (with codegen) and `run` with the same executable;
  - a restart keeping the data and the key;
  - `SMOKE_POSTGRES_URL` for Postgres.
- **Sabotage checks:**
  - Without the `btree.ts` helper, the executable fails at start ("Object is not a constructor").
  - Without the registered drivers, it fails on Postgres ("PERSISTENCE=postgres needs @bunvex/persistence").
