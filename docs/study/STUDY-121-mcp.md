# STUDY-121 — `mcp start`: the Model Context Protocol server

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-119](STUDY-119-run-inline-query.md) (`/api/run_test_function`, which `runOneoffQuery` uses),
  [STUDY-43](STUDY-43-data-command.md) (`tableData`), [STUDY-47](STUDY-47-log-streaming.md) (the log stream),
  [STUDY-52](STUDY-52-shape-inference.md) (`/api/shapes2`), [STUDY-37](STUDY-37-cli-and-environment-variables.md)

## 1. How Convex does it

### 1.1 The command

`npm-packages/convex/src/cli/mcp.ts` defines `npx convex mcp start`. It is served with the official SDK,
`@modelcontextprotocol/server` 2.x (`Server`, `serveStdio(factory, {legacy: "serve", onerror})`), over stdio.

- **Its options:**
  - `--project-dir`;
  - `--disable-tools <names>` (comma separated; an unknown name fails at start with `Failed to start MCP
    server: Error: Disabled tool <name> not found (valid tools: <sorted names>)`, exit 1);
  - `--cautiously-allow-production-pii`;
  - `--dangerously-enable-production-deployments`;
  - the hidden, deprecated `--disable-production-deployments` (a no-op, in commander conflict with the
    dangerous flag);
  - the deployment selection flags.
- **The server:** `{name: "Convex MCP Server", version: "0.0.1"}`, with the tools capability.
- **`tools/list`:** each enabled tool's name, description and `zodToJsonSchema(inputSchema)` (draft-07,
  `additionalProperties: false`).
- **`tools/call`**, in this order:
  - a cloud login check ("Not Authorized: Run `npx convex dev` to login to your Convex project.");
  - "No arguments provided";
  - `Tool <name> not found`;
  - `inputSchema.parse(arguments)` (a zod error's message on failure);
  - the handler, run behind a mutex (the handlers `chdir`).
- **The answer:** `{content: [{type: "text", text: JSON.stringify(result)}]}`. On an error, `{content: [{type:
  "text", text: JSON.stringify({error: message})}], isError: true}`, where the message is a `RequestCrash`'s
  printed message or the `Error`'s message.

### 1.2 Deployments and guards

`lib/mcp/requestContext.ts`:

- **A deployment selector** is `<kind>:<base64(JSON {projectDir, deployment})>`, opaque to the client.
- **`decodeDeploymentSelector`** is used by `run` and the four env tools. A `prod` selector is refused unless
  `--dangerously-enable-production-deployments`: "This tool cannot be used with production deployments. Use a
  read-only tool like `insights` instead, or enable production access with
  --dangerously-enable-production-deployments.".
- **`decodeDeploymentSelectorReadOnly`** is used by `data`, `logs` and `runOneoffQuery`. A `prod` selector is
  refused unless one of the two flags is set: "This read-only tool may expose PII from production. Enable with
  --cautiously-allow-production-pii, or use --dangerously-enable-production-deployments for full access.".
- **`decodeDeploymentSelectorUnchecked`** is used by `tables`, `functionSpec` and `insights`.
- **Self-hosted.** A self-hosted deployment (`CONVEX_SELF_HOSTED_*`) has the kind `unspecified`, so the guards
  never apply to it.

### 1.3 The tools

All in `lib/mcp/tools/*`:

- **`status {projectDir?}`.** `projectDir` falls back to `--project-dir`; with neither: "No project directory
  provided. …".
  - It returns `availableDeployments`: `[{kind, deploymentSelector, url, dashboardUrl?}]`, plus the cloud
    `prod` deployment for a cloud project.
  - Unless production is enabled, a `prod` entry gets `readOnly: !piiAllowed`.
- **`data {deploymentSelector, tableName, order, cursor?, limit?≤1000}`.** It reads `_system/cli/tableData` with
  `numItems: limit ?? 100` and returns `{page, isDone, continueCursor}`.
- **`tables`.** It reads `_system/frontend/getSchemas` and parses the active schema's JSON as `{tables:
  [{tableName, indexes, searchIndexes, vectorIndexes, documentType}]}`. It also reads `GET /api/shapes2`.
  The answer is `{tables: {<name, sorted>: {schema?, inferredSchema?}}}`.
- **`functionSpec`.** `_system/cli/modules:apiSpec`, as JSON.
- **`run {deploymentSelector, functionName, args}`.**
  - The arguments are parsed as JSON5 ("Failed to parse arguments as JSON: …").
  - The function name is resolved by `parseFunctionName`.
  - It calls `ConvexHttpClient.function` as an admin.
  - The log lines are captured from a `DefaultLogger` as `<level>: <args joined by " ">`.
  - The answer is `{result, logLines}`; a failure is "Failed to run function "<name>":\n<error>".
- **`envList`** returns `{variables}`; **`envGet {name}`** returns `{value | null}`; **`envSet {name, value}`**
  and **`envRemove {name}`** return `{success: true}` (through `/api/update_environment_variables`).
- **`runOneoffQuery {deploymentSelector, query}`.** The module goes as it is to `/api/run_test_function`.
  - The answer is `{result, logLines}`.
  - A failed run is `Query failed: <JSON>`.
  - A refused request is the fetch error's `handle` message.
- **`logs {deploymentSelector, status?, cursor?, entriesLimit?, tokensLimit?=20000, jsonl?}`.**
  - It reads `GET /api/stream_function_logs?cursor=` and filters Completions by error for
    `success`/`failure`.
  - `limitLogs` keeps the last `entriesLimit` entries, then entries while the running estimate (`JSON length ×
    0.33`) is within `tokensLimit`.
  - The entries come back as JSONL or as `formatLogsAsText`.
- **`insights`.** OCC and read-limit insights from Convex's cloud (Big Brain).

## 2. What an app can observe

An AI tool configured with `npx convex mcp start` (bunvex: `bunvex mcp start`) sees the tool list and
schemas, the answers and the error texts above. On a production deployment, the guards decide which tools
work.

## 3. How bunvex does it

`packages/cli/src/mcp.ts` (the command, the server) and `mcp-tools.ts` (the tools):

- **The SDK and the server.** It uses Convex's SDK, `@modelcontextprotocol/server` 2.3.1, with `zod` 4. That
  makes `@bunvex/cli`'s first third-party runtime dependencies; `check:deps` and CONTRIBUTING have no rule
  against them, and both are declared.
  - `serveStdio(factory, {legacy: "serve"})`, and `Server` with the same handlers.
  - The JSON Schemas come from zod 4's `z.toJSONSchema(schema, {target: "draft-7"})`, which gives the same
    shape (`$schema` draft-07, `additionalProperties: false`).
  - Calls run behind a promise queue.
- **Deployments.** A call reaches the deployment its project directory configures, with the command's
  `--url` / `--admin-key` / `--env-file` first, as every command (`resolveTarget`, `acquireTarget`).
  - A self-hosted deployment has kind `prod`; the local deployment has kind `local` and is started if needed.
  - The guard follows the configured deployment, not the selector's kind, since bunvex has no dev/prod pair to
    choose from (DV-395).
- **The tools.** Convex's names, inputs, outputs and messages, in bunvex's words:
  - "bunvex project", `bunvex/`, `bunvex:/_system/repl/wrappers.js` (DV-390);
  - log lines `[BUNVEX ?(…)]`, as the client prints them;
  - the fetch errors in Convex's `Error fetching <METHOD>  <url> <status> <text>: <code>: <message>` form.
- **Server.** `_system/frontend/getSchemas` is new: `{active?, inProgress?}` from `_schemas` (`ViewData`;
  "Unexpectedly found both pending and validated schemas"). bunvex does not store empty search and vector index
  lists in the schema JSON, so `tables` puts `[]` back.
- **Output.** stdout carries the protocol; the command's other output (a local deployment starting) goes to
  stderr.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| M1 (DV-392) | No `insights` tool; `--disable-tools insights` is a no-op; the production guard suggests `tables` instead of `insights` | Não dá pra fazer: Convex's cloud data | owner, 2026-10-05 |
| M2 (DV-393) | No login check: the URL and admin key are the auth | Não dá pra fazer: no cloud login | owner, 2026-10-05 |
| M3 (DV-394) | Server name `Bunvex MCP Server` | Rule 5 | owner, 2026-10-05 |
| M4 (DV-395) | A self-hosted deployment is production for the guards; a local one is not; the guard reads the configured deployment | No cloud prod; self-hosted holds real data | owner, 2026-10-05 |

Not divergences:

- **The deployment selection flags.** bunvex has `--url`, `--admin-key` and `--env-file`, as its other
  commands; Convex's cloud flags (`--prod`, `--preview-name`, `--deployment-name`, `--deployment`) do not exist
  in bunvex (DV-186).
- **`status`** gives no `dashboardUrl`. Convex gives none for a self-hosted deployment either.
- **System queries** are read once through `/api/query` instead of a one-shot WebSocket subscription; the
  value is the same.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/cli/test/mcp.test.ts` starts the command as a process and speaks newline-delimited JSON-RPC on its
stdin and stdout (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`). The deployment is a
real server, pushed with `bunvex deploy`.

- **initialize and `tools/list`.** The server's name; the eleven tools in Convex's order; the data tool's JSON
  Schema; no "convex" in any description.
- **`status`.** Kind `prod` and `readOnly` by default, `readOnly: false` with the PII flag, absent with
  production enabled; the selector's payload; the missing project directory message.
- **The guards.** `run` and the env tools refused, the PII tools refused, `tables` and `functionSpec` allowed.
  With the PII flag the read-only tools pass and `run` is still refused. A forged `local` selector is still
  refused.
- **A local deployment** (a local config pointing at the running server): kind `local`, no guard.
- **One test per tool**, with production enabled:
  - `run`: Convex's logger lines, JSON5 arguments, `api.…` names, argument and function errors;
  - `data`: a page, `isDone`, the cursor, zod's `limit` check;
  - `tables`: the declared schema with its index, and the inferred shape;
  - `functionSpec`;
  - the env round trip, and a refused name with the fetch error text;
  - `runOneoffQuery`: a value and lines, `Query failed`, a refused module;
  - `logs`: text, the JSONL failure filter, `entriesLimit` and `tokensLimit`.
- **`--disable-tools`.** Hidden and uncallable; `insights` accepted; an unknown name exits 1 with Convex's
  message.
- **Call errors.** "No arguments provided", a bad selector, and the deprecated flag's conflict; concurrent
  calls all answer.
- **`limitLogs`.** Its cases as a unit.

**Sabotage** (each restored; `git diff` clean after):

| # | Change | Failed |
|---|---|---|
| S1 | the guards never apply | "the guards on production" |
| S2 | every deployment is local | "status", "the guards" |
| S3 | the PII guard inverted | "the guards" |
| S4 | `--disable-tools` ignored | "--disable-tools" |
| S5 | `insights` not accepted | "--disable-tools" |
| S6 | `getSchemas` without the active schema | "tables" |
| S7 | `entriesLimit` ignored | "logs", "limitLogs" |
| S8 | the `failure` filter keeps everything | "logs" |

The serial queue has no sabotage check: from outside, a client cannot tell queued calls from parallel ones.

No hot path: the command is a separate process.

## 6. Open questions

None.
