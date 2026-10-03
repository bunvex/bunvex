# STUDY-37 — Deployment environment variables, and the CLI part 1 (`start`, `run`, `env`, `dev`)

- **Status:** accepted: all as recommended (owner, 2026-10-02)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - roadmap item 9 ([parity README](../parity/README.md));
  - [STUDY-34](STUDY-34-admin-keys.md) (admin keys, `bunvex admin-key`);
  - [STUDY-35](STUDY-35-push-and-deploy.md) (push, `bunvex deploy`, `auth.config` evaluated with the server's env until this item);
  - [STUDY-36](STUDY-36-codegen.md) (codegen, G4: `env` untyped until this item);
  - item 10 (Docker) builds on `bunvex start`.

## 1. How Convex does it

### 1.1 Deployment environment variables

**Storage** (`crates/model/src/environment_variables/`)
- The system table `_environment_variables` holds `{ name, value }` (`types.rs:15-19`). Its index is `by_name` on `["name"]` (`mod.rs:58-61`).
- `EnvironmentVariablesModel` offers `get(name)`, `get_all()`, `create` (refuses built-in names), `delete` and `edit`.

**Validation** (`crates/common/src/types/environment_variables.rs`, knobs)

| Check | Rule | Error code and message |
|---|---|---|
| Name | `^[a-zA-Z_]+[a-zA-Z0-9_]*$` (a leading `_` passes, whatever the message says) | `EnvironmentVariableNameInvalid`: "The environment variable name {s} is invalid. Environment variable names must begin with a letter and may only include characters a-z, A-Z, 0-9, and underscores." |
| Name length | at most 256 bytes | `EnvironmentVariableNameTooLong`: "The environment variable name {s} is too long. Environment variable names must be less than 256." |
| Value size | at most 8 KiB | `EnvironmentVariableValueTooLarge`: "The environment variable value is {len} bytes, which is too large. (max size: 8192" (the closing paren is missing in Convex too) |
| Count | `ENV_VAR_LIMIT` = 512 | `EnvVarLimitMet`: "The environment variable limit (512) has been met." |
| Total size | `ENV_VAR_TOTAL_SIZE_LIMIT` = 512 KiB of names plus values | `EnvVarTotalSizeLimitMet`: "The total size of all environment variables ({n} bytes) exceeds the limit (524288 bytes)." |
| Uniqueness | one variable per name | `EnvVarNameNotUnique` from the create and modify APIs. The update batch checks no uniqueness: the route sorts it (removals first, then sets by name and value; `EnvVarChange` derives `Ord`) and applies it in that order, so a removal and a set of one name leave the set (a delete and a create in the audit log), and two sets leave the greater value (Convex test `test_env_variable_delete_and_create`; bunvex matches since STUDY-65) |
| Built-in names | may not be set | `EnvVarNameForbidden`: "Environment variable with name \"{name}\" is built-in and cannot be overridden" |

**HTTP API** (`crates/local_backend/src/environment_variables.rs`, also under `/api/v1/`)
- **`POST /api/update_environment_variables`**: body `{"changes":[{"name","value"|null}]}`.
  - A `null` value deletes the variable.
  - Needs the `WriteEnvironmentVariables` operation. Answers 200 with an empty body.
  - It runs in one transaction (`application/src/lib.rs:1790-1876`):
    1. deletions first, then sets (each set deletes any old document and inserts a new one);
    2. the count and size limits, checked after the changes;
    3. the stored `auth.config.js` re-evaluated with the new variables (see below);
    4. the commit, with an audit-log entry.
- **`GET /api/list_environment_variables`**: needs `ViewEnvironmentVariables`. Answers `{"environmentVariables":{"NAME":"value",…}}`.
- **System queries:** `_system/cli/queryEnvironmentVariables` returns every document in `by_name` order; `:get` takes `{name}` and returns `{name, value}` or `null`.

**`process.env` inside functions**
- In the isolate, `process.env` is a `Proxy` (`udf-runtime/src/00_misc.ts:16-35`).
  - Each read of a string property is an op, `environmentVariables/get`. A name that does not parse throws the name error.
  - A missing variable is `undefined`, and the proxy lists no keys.
- **Queries and mutations** preload the variables at their snapshot (`udf/src/environment.rs:118-213`). Each read records a read of that name in the `by_name` index (`database/src/preloaded.rs:46-71`). So a query that read `X`, even a missing `X`, is invalidated when `X` changes. There is no cache-key part.
- **Actions** read every variable once, at their start: a snapshot, with no reactivity.
- **Node actions** see a fresh `process.env` (`node-executor/src/executor.ts:95-131`): an allowlist of the process's (`PATH, PWD, LANG, NODE_PATH, TZ, UTC`) plus the deployment's variables.
- **Built-ins:** `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL`, from `--convex-origin` / `--convex-site`. User variables are looked up first but can never take these names.

**`auth.config.ts` and the variables**
- At `start_push`, `auth.config.js` is evaluated with the deployment's variables (`deploy_config.rs:270-276`).
  - A missing variable throws `AuthConfigMissingEnvironmentVariable`: "Environment variable {name} is used in auth config file but its value was not set".
- `finish_push` re-reads the variables and fails with `RaceDetected` ("Environment variables have changed during push") if they changed (`deploy_config.rs:856-864`). The CLI retries.
- Every variable update re-evaluates the stored auth config in the same transaction (`lib.rs:2151-2186`). An update that breaks it fails the same way.
- **Newer:** variables declared with validators in `convex.config.ts` (components), with "required" checks.

### 1.2 `npx convex env` (`cli/env.ts`, `cli/lib/env.ts`)

**`set NAME value`**, or `set NAME=value`
- Passing both forms is an error with its own message.
- The value comes from the argument, then `--from-file`, then piped stdin, then a hidden prompt.
- Prints `✔ Successfully set NAME`.
- **Without a name:** `--from-file` or stdin is parsed as dotenv.
  - CLI-managed names are skipped (deployment URLs and keys).
  - A value that differs from the stored one needs `--force`.
  - The summary reads "Successfully set N environment variable(s) from <source> (a new, b updated, c unchanged)".

**`get NAME`**
- Prints the value on stdout.
- When the variable is missing it prints `✖ Environment variable "NAME" not found` on stderr, and the exit code is still 0.

**`remove NAME`** (aliases `rm`, `unset`)
- Prints `✔ Successfully unset NAME`, even when the variable is missing.

**`list [--names-only]`**
- Prints `NAME=value` lines in name order, each value quoted for a dotenv file when needed. With no variables it prints `No environment variables set`.

**Mechanics**
- Reads go through the system queries over a WebSocket; writes go through `update_environment_variables`.
- `env default` (project defaults) is cloud-only.

### 1.3 `npx convex run` (`cli/run.ts`, `cli/lib/run.ts`)

**Arguments**
- `run <functionName> [args]`.
- The function name: `api.a.b` and `internal.a.b` become `a:b`; `a/b` becomes `a/b:default`; the extension is stripped.
- `args` is a JSON5 object, `{}` by default.

**The call**
- `POST /api/function` with `{path, args, format: "convex_encoded_json"}`.
  - The endpoint runs any kind of function, internal ones included, and needs an admin key (`public_api.rs:216-265`).
- `--identity <json5>` acts as a user.
  - Missing fields are filled in: `issuer` `https://convex.test`, a hashed `subject`, `tokenIdentifier`.
  - The identity goes as `Authorization: Convex <key>:<base64 identity>`.

**Output**
- Log lines go to stderr: `[CONVEX ?(path)] [LEVEL] msg`.
- A non-null result goes to stdout: `util.inspect` on a TTY, else pretty JSON.
- Errors exit 1: `Failed to run function "X":\n<message>`. A missing function lists the available ones, from `_system/cli/modules:apiSpec`.

**Flags**
- `--watch` subscribes over a WebSocket and prints each new result.
- `--push` pushes once first, refused for prod.
- `--inline-query`, `--component`.

### 1.4 `npx convex dev` (`cli/dev.ts`, `cli/lib/dev.ts`)

**The loop**
1. Push: codegen, bundle, `start_push`, codegen again, typecheck, `wait_for_schema`, `finish_push`.
2. Print `✔ HH:MM:SS Convex functions ready! (Xs)`.
3. On the first success only, run `--run <fn>` or start `--start <cmd>`.
4. Wait for a file change that touches what the push read, plus 500 ms of quiet, and push again.

**When a push fails**
- A transient error backs off from 500 ms, doubling to 16 s with jitter.
- An app error (bundling, typecheck, schema) waits for the next file change. With `--once` it exits 1.
- After an env-var error it also waits on the variables, and after a schema error on the table named in it.

**Flags**
- `--once`, `--until-success`, `--typecheck`, `--codegen`.
- `--tail-logs always|pause-on-deploy|disable`.
  - Logs are polled from `/api/stream_function_logs` and paused while a push runs.
- Cloud configuration flags, and `--local` options for the downloaded local backend.

### 1.5 The self-hosted backend's start (`crates/local_backend/src/config.rs`, `self-hosted/`)

**`convex-local-backend` flags**
- `db_spec` is a positional: a SQLite path or a database URL, plus `--db`.
- Bind: `--interface 0.0.0.0`, `--port 3210`, `--site-proxy-port 3211`.
- Origins: `--convex-origin` / `--convex-site`, http(s) URLs that become the built-in variables.
- Identity: `--instance-name` (default `carnitas`) and `--instance-secret` (required: 32 hex-encoded bytes).
- Storage: `--local-storage <dir>` or `--s3-storage`.
- Also: `--redact-logs-to-client`, `--do-not-require-ssl`, `--disable-beacon`.
- `keygen admin-key` prints a key.

**The Docker scripts**
- `read_credentials.sh`:
  - `INSTANCE_SECRET` and `INSTANCE_NAME` come from the env, else from files in `$DATA_DIR/credentials`, else are generated (`openssl rand -hex 32`, `convex-self-hosted`);
  - both are written back to their files.
- `run_backend.sh` picks the database from `POSTGRES_URL` / `MYSQL_URL` / `DATABASE_URL`, else SQLite in `$DATA_DIR`. It uses S3 when the six bucket variables are set.
- `generate_admin_key.sh` prints a key from the same credentials.

## 2. What an app can observe

1. `process.env.X` in a function returns the deployment's value, or `undefined`.
   - A query that read it re-runs when it changes.
   - An action sees the values from its start.
   - The built-ins are always there.
2. The validation errors and limits above, from the CLI and the dashboard.
3. `auth.config.ts` reads the deployment's variables. A missing one fails the push (or the env update) with Convex's message.
4. The CLI's commands, arguments, output (stdout vs stderr) and exit codes: `env set|get|list|remove`, `run`, `dev`.
5. A self-hosted deployment is started with a port pair (3210 / 3211), an instance name and secret, a database and a storage directory.

## 3. How bunvex does it

**What exists**
- Codegen and deploy (STUDY-35/36), and admin keys with operations (`WriteEnvironmentVariables` / `ViewEnvironmentVariables` already exist in `DEPLOYMENT_OPS`).
- The server is configured by env: persistence, blob stores, origins, ports.
- Pushed code runs in `vm` contexts (STUDY-35), so their `process` global is ours to define.
- The dashboard already has an environment-variables screen, behind `listEnvironmentVariables` / `updateEnvironmentVariables`.

### PRs

**1. Environment variables (core + server)**
- **Storage:** an `_environment_variables` system table with `by_name`, and Convex's validation, limits and messages (the exact texts, the missing paren included).
- **HTTP:**
  - `POST /api/update_environment_variables`: one transaction; deletions first; limits after the changes; auth config re-evaluated.
  - `GET /api/list_environment_variables`.
- **System queries:** `_system/cli/queryEnvironmentVariables` and `:get`.
- **`process.env` in a code version's contexts:** a `Proxy`. A read in a query or mutation goes through the transaction: a system read of `by_name` at that name, so the read set, the query cache and subscriptions follow it as in Convex.
  - Actions and `"use node"` actions read all variables once, at their start.
  - The built-ins are the server's two origins (E2).
- **Auth config:**
  - `start_push` evaluates `auth.config.js` with the deployment's variables and the built-ins. This replaces the "server's process env" stopgap of 2026-10-02.
  - `finish_push` checks that the variables have not changed (`RaceDetected`).
  - An update re-evaluates the stored auth config.

**2. `bunvex env set|get|list|remove`**
- Convex's argument forms, sources (argument, `--from-file`, stdin, prompt), output and exit codes.
- The dotenv batch path, with `--force` and the CLI-managed names skipped (`BUNVEX_SELF_HOSTED_*`).
- Reads use `list_environment_variables` over HTTP, which needs no WebSocket client; the output is the same.

**3. `POST /api/function`, and `bunvex run`**
- The endpoint runs any kind of function, internal ones included, for an admin.
- `run`:
  - Convex's name forms and JSON5 args (Bun's `JSON5` is not available everywhere, so a small JSON5 reader, or JSON plus a clear message; E8);
  - `--identity`, with logs on stderr and the result on stdout;
  - the "available functions" list from the push analysis (`_system/cli/modules:apiSpec`);
  - `--push` (one deploy first);
  - `--watch` (E5).

**4. `bunvex start`: the self-hosted server as a command (E1)**
- Flags after `convex-local-backend`:
  - `--port` (3210) and `--site-proxy-port` (3211);
  - `--cloud-origin` / `--site-origin` (E2 names);
  - `--instance-name` / `--instance-secret`;
  - `--data-dir`;
  - `--redact-logs-to-client`.
- The database comes from the env, as today (`PERSISTENCE`, `POSTGRES_URL`, …). SQLite in the data directory is the default.
- Storage: the local blob store under the data directory, or S3 from the env.
- **Credentials:**
  - like `read_credentials.sh`, from the env, else files in `<data-dir>/credentials`, else generated and saved;
  - or keep bunvex's present rule (DV-160: the secret may live in the database). That is part of E1.
- Prints the URLs, and how to get an admin key.

**5. `bunvex dev`**
- Against the configured deployment (`BUNVEX_SELF_HOSTED_*`), the loop of §1.4:
  - push with codegen and typecheck, then `✔ HH:MM:SS bunvex functions ready! (Xs)`;
  - watch the functions directory (`fs.watch`, recursive) with the 500 ms quiet period;
  - Convex's error classes and backoff;
  - `--once`, `--until-success`, `--run`, `--start`, `--typecheck`, `--codegen`.
- Log tailing needs `/api/stream_function_logs`, which comes with item 12, so `--tail-logs` defaults to `disable` until then (E7).
- With no deployment configured, `dev` could start one in process (E6).

**Codegen:** once variables exist, `_generated/server` keeps `env` untyped. Convex types it only from `convex.config.ts` declarations, which need components; that is still G4/DV-176. With no declarations, Convex's `Env` holds just the two built-ins, so typing those two is possible now (E2 decides their names).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| E1 | `bunvex start` is a CLI command that runs the self-hosted server. Convex ships a binary (`convex-local-backend`) and Docker scripts. Its flags mirror the binary's, and the Docker image (item 10) runs `bunvex start`. **Credentials (recommended):** the env, else `<data-dir>/credentials` files, else generated and saved there, as Convex's `read_credentials.sh`. Keep accepting the store's stored secret for `bunvex admin-key` (DV-160) | bunvex is one Bun process; the CLI is what an app installs | accepted (owner, 2026-10-02) |
| E2 | The built-in variables are `BUNVEX_CLOUD_URL` and `BUNVEX_SITE_URL`, not `CONVEX_CLOUD_URL` / `CONVEX_SITE_URL` | rule 5: no "convex" in shipped strings. An app reading the Convex names gets `undefined` | accepted (owner, 2026-10-02) |
| E3 | Deployment variables reach pushed code only. Functions registered in an embedded server (`createServer({ functions })`) see the host's real `process.env` | embedded functions run in the host's own context, where replacing `process.env` would break the server itself | accepted (owner, 2026-10-02) |
| E4 | `run --identity` fills `issuer` with `https://bunvex.test` (Convex: `https://convex.test`) | rule 5 | accepted (owner, 2026-10-02) |
| E5 | `@bunvex/cli` may import `@bunvex/client` (and `protocol`), for `run --watch` and `dev`'s waits on variables and tables. **Alternative:** poll over HTTP | Convex's CLI uses its WebSocket client for these; ARCH-01's rule today allows the CLI only `server`, `core` and `values` | accepted (owner, 2026-10-02) |
| E6 | `bunvex dev` without a configured deployment starts a local one in process, with SQLite under `.bunvex/`. Convex downloads and runs its local backend, or configures a cloud one | the closest equivalent of Convex's local deployments; no download | accepted (owner, 2026-10-02) |
| E7 | `dev --tail-logs` defaults to `disable` until log streaming exists (item 12); then Convex's `pause-on-deploy` | the endpoint does not exist yet | accepted (owner, 2026-10-02) |
| E8 | `run`'s args are JSON5, parsed by a small reader of bunvex's own (no dependency) | Convex uses the `json5` package; the CLI has no external dependencies | accepted (owner, 2026-10-02) |
| E9 | Not built: `env default` (cloud), variable validators and "required" variables declared in `convex.config.ts` (components), `run --component` / `--inline-query`, dev's cloud and `--local-*` flags | no cloud, no components yet | accepted (owner, 2026-10-02) |

## 5. Tests

**Variables**
- Each validation rule and limit, with Convex's message.
- A batch is all or nothing; deletions come before sets.

**`process.env` in pushed code**
- A query that read `X` re-runs when `X` changes: a subscription sees the new value, and the cache is not served stale.
- Reading a missing `X` and then setting it re-runs the query too.
- An action sees its start's values; `"use node"` gets the allowlist plus the variables.
- The built-ins can be read, and setting one fails.

**Auth config**
- At push, a missing variable gives Convex's message.
- An env update that breaks the stored config fails, and changes nothing.
- A finish after a variable changed fails with `RaceDetected`.

**CLI**
- `env` is tested end to end against a deployable server: every form, stdout vs stderr, exit codes.
- `run`: name forms, args, identity, logs on stderr, errors, the list of available functions, `--push`.
- `start`: the flags and defaults. Credentials are generated once and reused; an existing `--data-dir` restarts with the same data; an admin key from `bunvex admin-key --data-dir` works.
- `dev --once` and `--until-success`. A file change triggers a re-push; a type error waits for the next change.

**Sabotage checks** for the read-set dependency, the race check and the batch atomicity.

## 6. Open questions

- **Docker flags:** should `bunvex start` read Convex's Docker variable names too (`CONVEX_CLOUD_ORIGIN`, `CONVEX_SITE_ORIGIN`)? Rule 5 forbids them in strings, so `BUNVEX_CLOUD_ORIGIN` / `BUNVEX_SITE_ORIGIN` (already read by the server) is the answer unless the owner says otherwise.
