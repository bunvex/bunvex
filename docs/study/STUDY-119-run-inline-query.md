# STUDY-119 — `run --inline-query` and the function tester (`/api/run_test_function`)

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-37](STUDY-37-cli-and-environment-variables.md) (`bunvex run`, DV-186),
  [STUDY-47](STUDY-47-log-streaming.md) (the `Tester` caller, DV-253), [STUDY-67](STUDY-67-http-function-api.md)
  (the HTTP API's body and format rules), STUDY-121 (the MCP server's `runOneoffQuery` uses the same route)

## 1. How Convex does it

### 1.1 The CLI

`npm-packages/convex/src/cli/lib/command.ts:412` (`addRunOptions`) declares `[functionName] [args]`, `-w,
--watch`, `--inline-query <query>` (declared in conflict with `--watch`), `--push`, `--identity`, a hidden
`--no-push` kept for old scripts (with commander it sets `push` back to false, so it undoes an earlier `--push`),
`--typecheck`, `--typecheck-components`, `--codegen`, `--component` and a hidden `--live-component-sources`.

`cli/run.ts:140` (`resolveRunTarget`) runs before any deployment is selected, in this order, each failure a
fatal crash with exit code 1:

1. an inline query and a function name: "`npx convex run` accepts either <functionName> or `--inline-query`,
   not both.";
2. neither: "`npx convex run` requires either <functionName> or `--inline-query`.";
3. the trimmed query is empty: "`--inline-query` must not be empty.";
4. with `--watch`: "`--inline-query` can't be combined with `--watch`. …" — never reached from the command
   line: commander refuses the pair first with "error: option '--inline-query <query>' cannot be used with
   option '-w, --watch'" (exit 1);
5. with `--identity`: "`--inline-query` can't be combined with `--identity`.".

`--push` is allowed: the code is pushed first (`pushToDeployment`, as `run --push`). On a prod deployment a
push is refused (`run.ts:74`).

`lib/runTestFunction.ts:38` (`inlineQueryToQuerySource`) turns the text into a module, from the trimmed text:

- text that contains `export default` and a call `query(` or `internalQuery(` (`\b(query|internalQuery)\s*\(`)
  is a module: it is kept, with the import line `import { query, internalQuery } from
  "convex:/_system/repl/wrappers.js";` and a blank line put first unless it already names that module;
- otherwise a single line that does not start with `const|let|var|if|for|while|switch|try|throw|return` is an
  expression: `return (<expr>);` (one trailing `;` dropped);
- otherwise the statements are kept as written;
- both are wrapped as `<import>\n\nexport default query({\n  handler: async (ctx) => {\n<body, indented 4>\n  },\n});`.

`runTestFunctionQuery` (`:59`) POSTs `/api/run_test_function` with
`{adminKey, args: {}, bundle: {path: "testQuery.js", source}, format: "convex_encoded_json", componentId?}`
through `deploymentFetch` (the admin key also in the `Authorization` header). A response whose `status` is not
`"success"` is an application failure. `runInlineQueryInDeployment` (`run.ts:201`):

- on success, each log line goes to stderr as the server wrote it (`logMessage`), and the value to stdout with
  `formatValue` (inspected on a terminal, else 2-space JSON), nothing for `null`;
- on an application failure: `Query failed: <JSON.stringify(response, null, 2)>`, exit 1;
- a non-2xx response is a `ThrowingFetchError`: `Error fetching POST  <url> <status> <statusText>: <code>:
  <message>` (two spaces after `POST`); a 403 prints the server's message alone, a 404 adds the URL.

`--component <path>` resolves the path to an id with `_system/frontend/components:list` (`run.ts:238`).

### 1.2 The server

`crates/local_backend/src/dashboard.rs:298` (`run_test_function`), route `POST /api/run_test_function`:

1. The body is `RunTestFunctionArgs {adminKey, bundle: ModuleJson {path, source, sourceMap?, environment?},
   args, format, componentId?}` (axum's `Json`: a body of the wrong shape is a 400 `BadJsonBody`; `format` is
   required).
2. `must_be_admin_from_key(adminKey)` — the key in the body; any valid key — then
   `require_operation(RunTestQuery)` (a read-only key has it).
3. The module path is parsed (`BadConvexModuleIdentifier`), the environment too (absent: from the path,
   `actions/` is Node), the component id.
4. `execute_standalone_module` (`crates/application/src/lib.rs:2697`):
   - a Node module: 400 `InvalidTestQueryEnvironment` "Test queries must use the Convex runtime.";
   - the module is analyzed **alone** (it cannot import the deployment's modules), with the deployment's
     variables at import: a failure is 400 `InvalidModules` "Could not analyze the given module:\n<error>";
   - any analyzed function other than the default export: 400 `InvalidTestQuery` "Only `export default` is
     supported."; no default function: "Default export is not a Convex function.";
   - the module is written into the transaction's `_modules` (never committed);
   - a query runs with `run_query_without_caching`; a mutation, action or HTTP action: 400
     `UnsupportedTestQuery` "Mutations are not supported in the REPL yet." (Actions, HTTP actions likewise).
5. The caller is `FunctionCaller::Tester`: the function log's `caller` is `Tester`.
6. The answer is a `UdfResponse` in the requested format: `{status: "success", value, logLines?}` or
   `{status: "error", errorMessage, errorData?, logLines?}` (empty `logLines` left out).

`convex:/_system/repl/wrappers.js` is a system module (`npm-packages/system-udfs/convex/_system/repl/
wrappers.ts`) re-exporting `query` and `internalQuery`.

## 2. What an app can observe

- `bunvex run --inline-query '<js>'` prints what the query returns, reading the deployment's data; it can
  never write (a query's `ctx.db` has no writers).
- Its exact refusals and messages above; exit 1 on every failure.
- Each run executes: two different modules sent with the same path and arguments get their own results.
- The function log shows the run as a `Query` of `testQuery` with caller `Tester`.
- Nothing is deployed: `testQuery` is not callable afterwards.

## 3. How bunvex does it

**Server** (`packages/server/src/test-function.ts`, the route in `server.ts`):

- The body is read with the HTTP API's serde-exact reader (`json-body.ts`, which now knows a nested struct) as
  `RunTestFunctionArgs` with its `ModuleJson`.
- The key comes from the body only (`adminCaller(adminKey)`), then `RunTestQuery`; errors as the other admin
  routes (401 `BadAdminKey`, 403 …).
- A non-empty `componentId` is refused: 400 `ComponentsNotSupported`, "bunvex does not have components yet."
  (DV-391, as `/api/shapes2` and `/api/delete_tables`).
- `standaloneQuery` checks the path (`badModulePath`, DV-312's code `BadBunvexModuleIdentifier`) and the
  runtime, then loads the module alone as a one-module `CodeVersion` (a `vm.SourceTextModule` that can link only
  the server's modules). The deployment's variables are its `process.env` at import, under the deployment's
  import seed and time. `bunvex:/_system/repl/wrappers.js` is one of those server modules (DV-390), exporting
  the server's own `query` and `internalQuery`. The analysis then applies Convex's rules and messages.
- `Functions.runStandaloneQueryJson` runs the query's body as any query's (argument check, limits, warnings,
  `process.env`, the paused-deployment check), through `engine.queryJson` **without a cache key**, logged with
  the `Tester` source. The response is the HTTP API's `UdfResponse` writer, so `format` is parsed and written
  as there (DV-307's names: `encoded_json`, `json`).
- Nothing is written: the module is not stored (Convex writes it into a transaction it never commits).

**CLI** (`packages/cli/src/inline-query.ts`, `run.ts`):

- `inlineQuerySource` applies Convex's three rules with bunvex's specifier; `runTestQuery` sends
  `{adminKey, args: {}, bundle: {path: "testQuery.js", source}, format: "encoded_json"}`.
- `bunvex run` takes `--inline-query <q>` / `--inline-query=<q>`, the hidden `--no-push` (undoes `--push`), and
  refuses `--component`, `--typecheck-components` and `--live-component-sources` (DV-391). Refusals and
  output are Convex's, with "`bunvex run`" for "`npx convex run`"; the `--watch` conflict prints commander's
  line, exit 1. Other parse errors keep `bunvex run`'s existing `bunvex run: …` form.
- The `Query failed` and `Error fetching POST  …` texts are Convex's.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| I1 (DV-390) | The function tester's builders are imported from `bunvex:/_system/repl/wrappers.js`, not `convex:/_system/repl/wrappers.js`; a module naming Convex's specifier does not resolve | Rule 5: no "convex" in shipped strings | owner, 2026-10-05 |
| I2 (DV-307) | The CLI sends `format: "encoded_json"` (Convex: `convex_encoded_json`) | DV-307's format names | already decided (DV-307) |
| I3 (DV-391) | `run --component`, `--typecheck-components`, `--live-component-sources`: "bunvex run: <flag>: bunvex does not have components yet." (exit 2); the route refuses a `componentId` with 400 `ComponentsNotSupported` | bunvex has no components yet (STUDY-62) | owner, 2026-10-05 |

Not new divergences: the messages name bunvex ("Test queries must use the bunvex runtime.", "Default export is
not a bunvex function.", "`bunvex run` accepts …") under DV-04; the module path code is DV-312's. The module
is not written into an uncommitted `_modules` row: no function can see `_modules`, so nothing differs.

DV-253 (the function log had no `Tester` caller because there was no function tester) is resolved: the route
logs as `Tester`. DV-186 no longer lists `--inline-query`.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

- `packages/server/test/run-test-function.test.ts`: success with values and log lines (`[LOG]`, `[WARN]`, empty
  `logLines` left out, `json` format); uncached (a write between runs, two modules at the same path); the
  `Tester` log entry; a write refused ("queries cannot write") with nothing written; a thrown error with its
  lines; a named function export refused, other exports allowed, a non-function default, a mutation, an action,
  an import of the deployment's module, an import that throws, the Node runtime, a bad path; the key: missing
  (`missing field \`adminKey\``), invalid, another instance's, a header instead of the body's key, a read-only
  key allowed; `format` required; GET is 405; a `componentId` refused.
- `packages/cli/test/run-inline-query.test.ts`:
  - **oracle**: `inlineQuerySource` equals the official `convex` package's `inlineQueryToQuerySource` (loaded
    from `node_modules` without its one network import), with the specifier mapped, on 16 cases and a
    fast-check property over token soups;
  - stdout/stderr for values, log lines, null, a whole module;
  - `Query failed: …` with the response, a write refused, the `Error fetching POST  …` text for a 400;
  - every refusal: both, neither, empty, `--identity`, `--watch` (both orders), a missing value, the three
    component flags, `--component` with a function name;
  - `--push` (deploys first) and `--push --no-push` (does not).
- `packages/cli/test/run.test.ts`: `bunvex run` with nothing now gives Convex's "requires either" (exit 1).

**Sabotage** (each restored; `git diff` clean after):

| # | Change | Failed |
|---|---|---|
| S1 | a named function export accepted (`endsWith(":default")` → `endsWith(":nothing")`) | server "the module", CLI "a failed run" |
| S2 | the tester's query run with the query cache's key | server "runs the default query", "uncached" |
| S3 | `return` dropped from the statement words | CLI oracle |
| S4 | `--identity` allowed with `--inline-query` | CLI "Convex's refusals" |
| S5 | the `Authorization` header's admin used before the body's key | server "the admin key in the body" |
| S6 | a mutation accepted (only actions refused) | server "the module" |
| S7 | `--no-push` ignored | CLI "--push deploys first; --no-push undoes it" |
| S8 | the run logged as `HttpApi` | server "logged with the Tester caller" |

No hot path changes: the route is new, and the other queries' path only gained an optional argument.

## 6. Open questions

None. One finding outside this study: a module that does not parse reports the `SyntaxError` with the server's
own frames (`code-version.ts`, `node:vm`) after it; pushes share that (`CodeVersion.load`), so it is left for
its own fix.
