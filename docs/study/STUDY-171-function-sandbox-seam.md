# STUDY-171 — The function executor seam and its knobs (STUDY-168 PR 1), the wire and the child runtime (PR 2), queries and mutations over the bridge (PR 3), two `vm` bugs (§10)

- **Status:** PR 1 implemented (#738); PR 2 (§7) implemented (#743); PR 3 (§8) implemented (#750); §9 (#751) and §10 (this PR) fixed; AD-44 accepted
  (owner, 2026-10-19)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend, the reference commit
  ([upstream.md](../parity/upstream.md))
- **Related:** [STUDY-168](STUDY-168-process-sandbox.md) (the design: §9 decisions, §10 configuration, §12 plan; draft
  PR #735), DV-164 (one `vm` context per code version), STUDY-80 (`--deny-addresses`, the knob style followed here),
  STUDY-147 (Convex's knobs as environment variables)

The owner approved building STUDY-168's option C, a sandboxed process per call, as an opt-in executor. This is the
first of its 12 PRs: one factory that every load of app code goes through, and the knobs that choose the executor.
Only today's `vm` executor exists after it. **Nothing changes for an app or an operator** who does not set the new
knobs. One who asks for `process` gets a start-up error that says it is not available yet.

## 1. How Convex does it

- **One executor, nothing to choose.** The local backend always builds an in-process function runner
  (`crates/local_backend/src/lib.rs:232-245`, `InProcessFunctionRunner::new`), which runs every function in a V8
  isolate. No flag in `crates/local_backend/src/config.rs` chooses the runner or the Node executor.
- **Knobs** are environment variables read once through `env_config` (`crates/cmd_util/src/env.rs:23-48`): unset
  gives the default, a bad value logs a warning and gives the default.
- **The memory cap** is `ISOLATE_MAX_USER_HEAP_SIZE` (64 MiB) plus `ISOLATE_MAX_HEAP_EXTRA_SIZE` (32 MiB)
  (`crates/common/src/knobs.rs:1153-1159`, their sum at `:1169-1173`). Over it, an isolate fails with "JavaScript
  execution ran out of memory (maximum memory usage: 64 MB)" (`crates/isolate/src/termination.rs:346`).

## 2. What an app can observe

Nothing new. With the knobs unset, or set to `vm`, a function runs exactly as before: same contexts, same errors,
same limits. The only observable change is for an operator: a start with `process`, or with a value outside the
lists, fails with a message.

## 3. How bunvex does it

### 3.1 The seam

`packages/server/src/function-executor.ts`:
- `Executor` is `{ load(sources, opts): Promise<CodeVersion> }`: what STUDY-168 §12.1 says a remote version must
  look like to its callers (`functions`, `moduleHashes`, `rooms`, `router`, `crons`, …). It returns a `CodeVersion`
  for now; PR 2 (the child runtime) widens the type to what the stand-ins expose.
- `vmExecutor` is today's `CodeVersion.load`, unchanged.
- `loadCode(sources, opts)` is the one factory. The 8 call sites that called `CodeVersion.load` now call it:

  | File | Call site | What it loads |
  |---|---|---|
  | `push.ts` | `evaluateAuthConfig` | `auth.config.js`, at push |
  | `push.ts` | `evaluateDefault` | a schema or definition module's default export, at push |
  | `push.ts` | `evaluateComponents` | each component definition's functions, at push |
  | `push.ts` | `PushService` (`startPush`) | the app's modules, at push |
  | `code-store.ts` | `loadComponentCode` | a component's stored code, at start |
  | `code-store.ts` | `loadLatestCode` | the deployed code, at start |
  | `server.ts` | `deployCode` | an embedded server's `deployCode` |
  | `test-function.ts` | `standaloneQuery` | the function tester's module |

  Tests and benchmarks keep calling `CodeVersion.load` directly: they test the `vm` executor itself.
- **What is not there yet, on purpose.** `loadCode` does not choose between executors: with one, there is nothing to
  choose. A `process` executor carries per-server state (its pool, its op dispatcher on the server's `Functions`),
  so PR 3 threads the executor the start chose from `createServer` to these callers, through their existing
  dependencies (`PushService`'s deps, `loadLatestCode`'s arguments). The push-time evaluations (auth config, schema,
  definitions) read `module.namespace`, which only a `vm` version has; PR 2 gives the executor a way to evaluate a
  default export.

### 3.2 The knobs (AD-44)

| Setting | Env | Flag (`bunvex-local-backend`) | `createServer` option | Values |
|---|---|---|---|---|
| Executor | `BUNVEX_FUNCTION_SANDBOX` | `--function-sandbox` | `functionSandbox` | `vm` (default), `process` |
| Isolation layers (`process` only) | `BUNVEX_FUNCTION_SANDBOX_ISOLATION` | — | `functionSandboxIsolation` | `auto` (default), `namespaces`, `landlock`, `none` |

- **Parsed as `--deny-addresses` is** (`address-screen.ts`), not as Convex's numeric knobs: a value outside the list
  is an error at start, never the default. An empty value is unset.
- **Precedence.** The flag, then the environment, then the default. `bunvex-local-backend` reads its `io.env` (the
  process's environment) and hands `createServer` the result, so the server's own read of `process.env` does not
  apply there. An embedded server reads `process.env` when the option is not given.
- **`process` fails at start**, in `functionSandboxConfig`, before the store opens (the local backend) or before
  anything starts (`createServer`): "the function sandbox 'process' is not available yet in this release: functions
  run in 'vm' only. Unset BUNVEX_FUNCTION_SANDBOX and --function-sandbox, or set them to 'vm'". The local backend
  exits 1 with it. The isolation value is checked even under `vm`, so a typo surfaces now, not when `process` ships.
- **No isolation flag.** The owner's decision names one flag, `--function-sandbox`. STUDY-168 §10.2 also proposed
  `--function-sandbox-isolation`; it can come with PR 8, when the layers exist.
- **The memory knobs** (`ISOLATE_MAX_USER_HEAP_SIZE`, `ISOLATE_MAX_HEAP_EXTRA_SIZE`) are left to the PR that builds the
  cap (PR 9). Reading them now would log Convex's "Overriding … from environment" for a limit that nothing enforces.
- **`bunvex dev`** passes its environment to the backend it starts, so `BUNVEX_FUNCTION_SANDBOX=process bunvex dev`
  reaches it (and fails, for now). The CLI has no flag, and its default is `vm`.
- **Docker.** `docker/docker-compose.yml` passes both variables through; `run_backend.sh` is unchanged.
- **Windows.** No support for `process`, now or later (owner, 2026-10-19).

## 4. Divergences

None. Convex has no executor choice; the default behaves as before.

| # | Divergence | Why | Decision |
|---|---|---|---|

## 4b. Additions (beyond Convex)

| # | Addition | Why | Decision |
|---|---|---|---|
| AD-44 | The function sandbox knobs: `BUNVEX_FUNCTION_SANDBOX=vm\|process` (`--function-sandbox` wins), `BUNVEX_FUNCTION_SANDBOX_ISOLATION=auto\|namespaces\|landlock\|none`; `process` an elastic pool of one-call processes with a 96 MiB cap per call; fail at start when the host cannot sandbox | a real boundary and real limits for app code (STUDY-168) | accepted (owner, 2026-10-19); this PR: the knobs and the seam, `process` refused at start |

## 5. Tests

`packages/server/test/function-executor.test.ts` (11 tests):
- both knobs: the defaults, every value, the errors with the lists, an empty value as unset;
- `functionSandboxConfig`: `vm` runs, `process` refused under every isolation, a bad isolation refused under `vm`;
- `createServer`: `process` refused from the option and from the environment, the option over the environment, a
  bad environment value refused;
- `bunvex-local-backend`: the flag's values and errors; `process` exits 1 with the message before the SQLite file
  exists, from the flag, from the environment, and from the flag over `vm` in the environment; `--function-sandbox
  vm` over `BUNVEX_FUNCTION_SANDBOX=process`; the backend's choice over the server process's own environment;
- `loadCode` loads what `CodeVersion.load` loads, and no source file but `function-executor.ts` calls
  `CodeVersion.load` (the five files with call sites are the ones that call `loadCode`).

The rest of the suite runs unchanged: the existing pushed-code suites (`deployCode`, `PushService`, components,
the function tester) now go through `loadCode`.

### Sabotage

| Break | Failing tests (of 11) |
|---|---|
| `process` accepted at start (the throw in `functionSandboxConfig` removed) | 3: "at start: … process is refused", "createServer refuses process …", "process fails at start …" |
| A bad value falls back to the default (`oneOf` returns `def`) | 5: both knobs' tests, "at start: …", "refuses a bad value in the environment", "a bad isolation still fails" |
| The environment over the flag in the local backend | 2: "process fails at start …" (the third case), "--function-sandbox vm wins …" |
| `createServer` stops checking | 2: "createServer refuses process …", "refuses a bad value in the environment" |
| One call site back on `CodeVersion.load` (`loadLatestCode`) | 1: "every load of app code in the server goes through it" |

Each was restored and checked against a saved copy (`cmp`) before the next.

### Measurements

The seam adds one function call per code *load* (a push, a start), none per function call: a function runs the
`FunctionDef` the version handed out, as before. Short runs on the shared Mac (8 cores; other sessions were running,
so the noise is large):

- **Load time**, 500 loads of a small module, `CodeVersion.load` and `loadCode` interleaved in one process: p50
  0.236 ms against 0.234 ms, p90 0.380 ms against 0.380 ms. No difference.
- **Per call**, `packages/server/bench/env-vars.ts` (20 000 uncached queries of pushed code per line), three runs
  each:

  | Line | Before (load average 19) | After (load average 6) |
  |---|---|---|
  | pushed, variables preloaded | 16.4–18.7 µs | 11.6–12.2 µs |
  | embedded, no variables | 10.0–11.7 µs | 6.3–6.4 µs |
  | pushed, reads one variable | 14.0–16.9 µs | 11.1–12.2 µs |

  The per-call path did not change; the gap between the columns is the machine's load (the embedded line, which
  touches nothing of this PR, moved as much as the others).

## 6. Open questions

None for PR 1. PR 2's are in §7.9, PR 3's in §8.12.

## 7. PR 2: the wire protocol and the child runtime

STUDY-168 §12.3's PR 2: a new package, `packages/sandbox` (`@bunvex/sandbox`, private until a published package
depends on it), with the child that loads a code version in a separate process and the host's side of it. **Nothing
reaches it by default**: no server code imports the package, and `process` still fails at start (§7.6).

### 7.1 How Convex does it (re-read at `d8bdde0`)

- **Analysis in the isolate.** `analyze` (`crates/isolate/src/environment/analyze.rs:273`) evaluates every module,
  then `udf_analyze` (`:585`), `http_analyze` (`:765`) and `cron_analyze` (`:996`) read the namespaces in the
  isolate and hand Rust their results. bunvex's `CodeVersion.load`/`analyze` (`code-version.ts`) follows them.
- **Push-time evaluations cross as JSON.** The auth config's default export is `JSON.stringify`ed in the isolate,
  `AuthConfigUnserializableError` if that fails (`environment/auth_config.rs:274-299`); the schema's `export()` is
  called in the isolate and its string parsed in Rust (`environment/schema.rs:262-293`). Rust never holds a live
  JS object.
- **Values cross as JSON text, checked after decoding.** A function's result is JSON text that Rust parses, then
  measures against `FUNCTION_MAX_RESULT_SIZE` (16 MiB, `knobs.rs:445-446`; `crates/isolate/src/helpers.rs:125-160`:
  "return value is too large"). The arguments' cap is `FUNCTION_MAX_ARGS_SIZE` (16 MiB, `knobs.rs:439-440`). What
  crosses a process boundary of Convex's own is capped higher, to fit a 16 MiB value and the rest:
  `MAX_BACKEND_RPC_REQUEST_SIZE` / `_RESPONSE_SIZE`, 32 MiB, "16MiB for FUNCTION_MAX_RESULT_SIZE + 4MiB for log lines
  + 4MiB for smaller fields" (`knobs.rs:1675-1682`).
- **Convex's own child process.** The local Node executor spawns `node` with an IPC socket path and polls its
  health every 100 ms, 50 times, before "Node executor server failed to start and become healthy"
  (`crates/node_executor/src/local.rs:47-48, 116-126, 163-198`): a 5 s start-up limit. Its `"use node"` modules are
  analyzed in that process (`executor.rs:384-431`, `ExecutorRequest::Analyze`).

### 7.2 The protocol (`protocol.ts`, `frames.ts`)

- **Transport: one socket, length-prefixed JSON frames.** The child's fd 3 is a socketpair end (Bun's `stdio`
  `"pipe"` beyond index 2), used both ways. Each frame is a 4-byte little-endian length and UTF-8 JSON. STUDY-168
  measured Bun's IPC channel (JSON) fastest; it is not used, because it reads and parses a message of any size
  before the host sees it (a 64 MiB message from a child went through, measured here). With a length first, the host
  refuses an oversized frame from its 4-byte header, before reading the body. The cost is the same: a small round
  trip took 19.5 µs p50 over Bun's IPC and 22–24 µs over the framed socket on this Mac (3000 round trips each,
  `results` not kept: a scratch run). stdin and stdout stay free (the child's stdout is the server's, as an
  in-process load's console is; its stderr is forwarded and its tail kept for a crash's message).
- **Values** inside a message use the value JSON format (`toJsonValue`/`fromJsonValue`: `$integer`, `$bytes`, …).
  In this PR only a cron's arguments are values; PR 3's calls carry the rest.
- **Messages.** Host → child: `load` (a push's modules and `LoadOptions`, the seed as numbers and the import time
  limit resolved) and `evaluate` (one module's default export, for `authConfig` or `schema`). Child → host: `hello`
  (protocol version, pid), `loaded`, `evaluated`, `failed`. Requests carry an `id`; the child answers each once, and
  may answer out of order (they run concurrently). PR 3's `call`/`op`/`result`/`done` are requests of the same shape;
  no message type is reserved for them now.
- **The handshake.** The child's first message is `hello` with `PROTOCOL_VERSION` (1). A child that speaks another
  version, sends anything before it, or says nothing within 5 s (`HANDSHAKE_TIMEOUT_MS`, Convex's Node executor's
  start-up limit) is killed.
- **Size caps.** The observable limits stay Convex's: a value's `valueSize` against 16 MiB, checked on the decoded
  value (PR 3). The frame cap, `MAX_MESSAGE_BYTES` = 7 × 16 MiB + 1 MiB (113 MiB), is a backstop that no message
  carrying a legal value reaches: JSON spends at most 7 bytes per byte `valueSize` counts (an empty bytes value
  counts 2 and is sent as `{"$bytes":""},`; a control character counts 1 and is sent as `\u0001`). A smaller cap,
  such as Convex's 32 MiB RPC cap, would refuse some values Convex's isolate accepts (16 MiB of control
  characters), a divergence; this one refuses only a broken or hostile child. The child does not cap the host's
  frames (a push's modules are bounded by the push's own 128 MiB request limit).
- **What the host checks.** `parseChildMessage` checks every field's type and every enum, and a cron schedule's
  fields per its type; a wrong one is "sent a message that is not valid: <path>: expected …". It checks the shape,
  not the truth: a child can only misdescribe the app code it was given. A module path such as `__proto__` is a key
  like any other (`Object.fromEntries`).

### 7.3 The child and the host (`child.ts`, `host.ts`)

- **The child runs the `vm` executor's own loader.** It imports `@bunvex/server/executor` (a new subpath export of
  the seam, `function-executor.ts`) and calls `vmExecutor.load` and `vmExecutor.evaluateDefault`. So it gets the same
  two contexts per version, the same deterministic `Date`/`Math.random` (`installDeterminismIn`), the same RegExp
  statics removal, the same linking of `bunvex/*` to the server's real builders and validators (no shim: every name
  a `_generated/server.js` imports is the real one), the same import phase (seed, time, `ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS`)
  and the same analysis. STUDY-168 §12.3 planned a `bunvex/server` shim and an analysis written again in the child,
  and named "analysis must match `CodeVersion.analyze` exactly" its risk; running the loader itself removes that risk.
  The wall is the process (and, from PR 8, the OS), not `vm`; `vm` inside it is what gives the app Convex's globals.
- **What the child sends back** (`version.ts`): `CodeVersion.analysis` (what the push reports and stores), its
  `moduleHashes` and `moduleLoads`, each function's kind, visibility and whether it is a `"use node"` one, and each
  room's kind. Maps travel as lists of pairs, so their order survives. The child keeps the `CodeVersion` for PR 3's
  calls; the frame maps stay in it (PR 4 formats stacks there).
- **Errors** cross by class: `InvalidModulesError` (its detail), `FunctionExportError`, the new
  `MissingEnvironmentVariableError`, and any other `Error` by its message (a loader limit, such as "Too many
  dependencies modules!", which has no frames of the app's). The host rebuilds the same class with the same words,
  so the push maps them as it maps in-process ones.
- **The child's environment** is the loader's two knobs when the host has them set (`MAX_USER_MODULES`,
  `ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS`), nothing else: never the server's variables, secrets or `PATH`. The
  deployment's variables reach the import phase in the request, as `LoadOptions.env` does in-process. Its working
  directory is the package's `src/`, so no `bunfig.toml` of the server's directory (a preload) applies to it.
- **Failure.** The host kills the child (SIGKILL, through its `Subprocess`, so by its own pid) and fails every
  waiting request, and every later one, with a `SandboxError` whose `reason` says why:

  | Reason | When | Message (after "the function sandbox's process ") |
  |---|---|---|
  | `crash` | it exits on its own | "exited unexpectedly (exit code 3): <stderr tail>", or "(signal SIGKILL)" |
  | `badMessage` | not JSON, not UTF-8, the wrong shape, an answer to no request, a second hello | "sent a message that is not valid: <why>" |
  | `oversize` | a frame header over the cap | "sent a message of N bytes, over the limit of M bytes" |
  | `handshakeTimeout` | no hello in time | "did not start within 5000 ms" |
  | `protocol` | another protocol version | "speaks protocol 999, not 1" |
  | `stopped` | `close()` | "was stopped" |

  When the host's stream breaks (a frame that is not JSON), the child exits 70 after writing why to stderr; the host
  reports it as a crash with that line. No child is restarted here: the pool (PR 9) replaces dead ones, and maps a
  dead call to Convex's internal error.
- **The socket** is the host's to close (Bun hands the parent's end over when `stdio` is read): it is closed once the
  child has exited and both readers are done.

### 7.3b `module.namespace` and the push-time evaluations

The push read `module.namespace.default` of a `vm` version in two places (`evaluateAuthConfig`, `evaluateDefault`,
`push.ts`), which no remote version can give. `Executor` now has `evaluateDefault(source, opts, use)`:
- the `vm` executor returns the live export, as before. `failOnMissingEnv` replaces the push's own `onMissingEnv`
  closure: a read of an unset variable fails the evaluation with `MissingEnvironmentVariableError`, which the push
  turns into `AuthConfigMissingEnvironmentVariable` exactly as before (same message; the push's tests unchanged).
  `isSchemaDefinition` moved from `push.ts` to the seam, where the child uses it too;
- in the child, `use` picks Convex's form (§7.1): `authConfig` sends `JSON.stringify(default)` (`undefined` and
  `unserializable` as such), `schema` sends `schemaToJson(default)`, or `undefined` (none or `null`), `notSchema`,
  `schemaExportFailed`. The host (`evaluatedValue`) hands the push `JSON.parse` of the JSON, `schemaFromJson` of the
  schema's export (as a stored schema is rebuilt at start), `undefined`, or a value that is not a schema for both
  failures: the push checks a schema's export right after its default (`schemaExport`, then
  `checkIndexReferences`), and answers both with `InvalidSchemaExport`, so the result is the same.
- An auth config that `JSON.stringify` refuses (a bigint) throws "auth config file can only contain strings", Convex's
  `AuthConfigUnserializableError` words. Under `vm` the live value reaches `parseAuthConfig`; PR 3 maps this one
  (process mode only, and closer to Convex).
- `bunvex.config`'s evaluation (`definition-eval.ts`) keeps its own `vm` module; STUDY-168 §12.2 lists it as later work
  for a cloud.

### 7.4 Analysis parity

`test/analysis-parity.test.ts` runs a corpus of 557 loads and evaluations both in-process and in one child, and
compares:
- a load's in-process `CodeVersion` fields (`analysis`, `moduleHashes`, `moduleLoads`, each function's kind,
  visibility and `"use node"`, each room's kind) with what the host decodes from the child; or both failures'
  class and message;
- an evaluation's result as the push reads it: an auth config's JSON, or a schema's `schemaToJson` and the push's
  checks on it (`documentTypeError`, `stagedDocumentError`, `indexReferenceError`), the rebuilt one against the live
  one.

The corpus (`test/fixtures/parity-corpus.json.gz`, 242 KB) is written by `scripts/sandbox-parity-corpus.ts`:
- **every example app** (22): its modules, schema and auth config, bundled as `bunvex deploy` bundles them
  (`bundleFunctions`), the auth config with no variables and with each one it reads set. A test fails when an
  example is missing, so a new example needs the corpus written again;
- **the server's pushed-code suites** (STUDY-168 §12.4's list, 19 files, 167 tests) run with
  `scripts/sandbox-parity-recorder.ts` preloaded, which records every `CodeVersion.load` and every push-time
  evaluation. 711 recorded, 557 once each; 14 left out because they do not replay (a test's temporary
  `node_modules`, and the auth config's callback, whose evaluation is in the corpus). They include failures of every
  kind the loader has: syntax and link errors, throws at import, import time-outs, bad exports, `"use node"` misuse,
  bad routers and crons.

All 557 match. One difference was found and is the test's, not the child's: an import that times out keeps its
caller's frames that are not the server's; in-process the caller is the test file, in production it is `push.ts`
(dropped, as in the child). The test drops its own frames before comparing.

### 7.5 Measurements

Short runs on the shared Mac (load average 7–8), `packages/sandbox/bench/startup.ts`:

| | p50 | p90 |
|---|---|---|
| Spawn to `hello` (20 children) | 38.6 ms | 40.2 ms |
| First load in a fresh child (`vector-search`, 5 modules) | 26.4 ms | 28.1 ms |
| A warm load, every example app, 10 rounds: in-process `CodeVersion.load` | 0.6 ms | 0.9 ms |
| The same in a child, round trip on the host's clock | 0.6 ms | 1.1 ms |
| The same, the child's own time | 0.5 ms | 0.9 ms |
| Child RSS (macOS), idle / after one load | 48.6 MiB / 63.6 MiB | 50.9 / 65.7 MiB |

- **The analysis costs the same in a child** once it is warm; the round trip adds about 0.1 ms. A push to a fresh
  child costs about 65 ms (spawn, then a cold load), against STUDY-168 §4.5's prototype at 24 ms unsandboxed: the
  child imports the server's loader (2 MB of the server's modules, `code-version.ts` reaching `functions.ts`), about
  30 ms of that.
- **Memory is the finding for PR 9.** A bare `bun` process is 9.4 MiB of RSS here; importing the loader brings it
  to 38 MiB, and the socket and a loaded app to 49–64 MiB. Against a 96 MiB cap per call, that leaves an app far less
  than Convex's 64 MiB heap. macOS RSS overstates what a Linux cgroup charges (shared pages), so PR 9 measures it in
  the cgroup; if it holds there, the child needs a slimmer import graph (the loader and the builders without
  `functions.ts`'s runtime), or the cap counts the runtime's baseline out.

### 7.6 Does `process` still fail at start? Yes

The child can load and analyze, but nothing can run a function in it until PR 3 (stand-ins, `ctx` over the bridge),
and nothing threads an executor from `createServer` to the call sites yet (§3.1). Starting with `process` now would
push code that cannot be called. So `functionSandboxConfig` still refuses it with `PROCESS_SANDBOX_UNAVAILABLE`, and
PR 1's tests for that are unchanged. The plan for PR 3: lift the refusal for `isolation=none` once queries and
mutations run, and keep `auto`, `namespaces` and `landlock` refused until PR 8 builds them.

How PR 3 can reach the package: the dependency is `sandbox → server` (the child runs the server's loader), so the
server cannot import it. The proposal is to pass the `process` executor in: `bunvex-local-backend` (the `bunvex`
package, which may depend on both) builds it and hands it to `createServer`, and an embedded `createServer` that asks
for `process` without one fails at start with a message naming `@bunvex/sandbox`.

### 7.7 Divergences and additions

None new. Under the default `vm`, nothing changes. The `process` mode is AD-44's; its frame cap is set so it refuses
no value Convex accepts (§7.2), and its auth config form is Convex's (§7.3b).

### 7.8 Tests and sabotage

`packages/sandbox/test/`:
- `analysis-parity.test.ts` (560): the corpus (§7.4), its coverage of every example and of the suites, and that the
  one child served all of it without dying;
- `host.test.ts` (15): a load, concurrent requests answered by id, the loader's error classes and words across the
  wire, the deployment's variables in the import phase, the child's environment; and every failure of §7.3's table,
  with fake children (`fixtures/children/`) that never say hello, speak another protocol, crash with a message on
  stderr, send a frame that is not JSON, the wrong shape, an answer to no request, a 200 MiB header with no body; the
  real child killed by its pid mid-load (both waiting requests fail), the real child's answer over a small cap, and
  the host breaking the stream;
- `protocol.test.ts` (20): frames split at every chunk size, the cap from the header and at its exact value, UTF-8,
  the cap's arithmetic; the shape checks; a version and a default export through the wire.

`packages/server/test/push.test.ts` runs unchanged over the new `evaluateDefault`; `function-executor.test.ts` gains
one test (12): no server source but the loader and the seam reads a module's namespace.

| Break | Failing tests |
|---|---|
| The `"use node"` flag lost (`node: false`) | 18 (the parity entries with `"use node"` modules) |
| The deployment's variables not passed to the child's load (`env: {}`) | 1: "the deployment's variables reach the import phase" (none of the corpus's loads reads one at import; that test was added for this) |
| The frame cap not checked | 3: the 200 MiB header, the real child over a small cap, the frame unit test |
| No handshake timer | 1: "it never says hello" |
| The child's exit not watched | 3: the crash, the real child killed, the broken stream |
| The version's shape not checked | 4: the wrong-shape child, the cron schedule and two shape tests |
| `InvalidModulesError` rebuilt as a plain `Error` | 59: the error-class test, the variables test and 57 parity entries |
| A cron's arguments not decoded | 2: a parity entry (`1n` arguments) and the wire test |
| The child given the server's whole environment | 1: "its environment holds only the loader's knobs" |
| The `vm` executor forgets an unset variable it saw | 4: the host's error-class test and 3 push tests (`bunvex dev`, deploy2, the dashboard links) |
| The push reads the schema's `module.namespace` again (`loadCode` in `push.ts`) | 1: "a module's namespace is read in the executor only" |

Each was restored from a saved copy and checked with `diff`/`cmp` before the next.

### 7.9 Open questions and later PRs

- **The child's memory baseline** (§7.5): measured on Linux in a cgroup by PR 9, before the 96 MiB cap is enforced.
- **A compiled `bunvex-local-backend`** (`bun build --compile`) has no `child.ts` on disk: the child must be the same
  executable started in a child mode (PR 9 or 11).
- **Batching** (STUDY-168 §13.4) puts several values in one message; PR 3 splits a batch that would pass the frame cap.

## 8. PR 3: queries and mutations over the bridge

STUDY-168 §12.3's PR 3: `BUNVEX_FUNCTION_SANDBOX=process` runs pushed queries and mutations in a child, every `ctx`
operation answered on the host's own transaction. **The default does not change**: `vm` stays the default, and
under it nothing runs differently. The three `vm` bugs its parity test found are fixed on their own (§9, #751).

### 8.1 How Convex does it (re-read at `d8bdde0`)

- **Everything that touches state is a syscall** into Rust, inside the function's transaction
  (`crates/isolate/src/environment/udf/syscall.rs:127-145`, `async_syscall.rs:748-791`): the read set, the writes
  and OCC stay in `UdfPhase { tx }`; JS sees values only.
- **Some syscalls are synchronous**: `1.0/queryStream` (a query's start: its JSON parsed, its index looked up, an id
  handed back), `1.0/db/normalizeId`, `1.0/getSnapshotTs` (which calls `observe_time`, `syscall.rs:110-124`).
  `process.env.X` is the op `environmentVariables/get`, one name at a time (`npm-packages/udf-runtime/src/
  00_misc.ts:16-30`, `crates/isolate/src/ops/environment_variables.rs`), its read in the read set
  (`PreloadedEnvVars`).
- **The query chain is built in JS** (`npm-packages/convex/src/server/impl/query_impl.ts`): the range builder, the
  filter builder and each operator run in the app's code; the query's JSON goes to `queryStream` when it starts.
  Consecutive async reads (`get`, `queryStreamNext`, `queryPage`, `storageGetUrl`) are batched in one round trip
  (`async_syscall.rs:230-290`).
- **Values cross as JSON**, serialized in the isolate (`convexToJson`): a value that is not one fails there, in the
  app's call, with the JS library's message.
- **User time** is the isolate's wall time minus its pauses in async syscalls (`crates/isolate/src/timeout.rs:
  95-115`); past it, "Function execution timed out (maximum duration: 1s)" (`termination.rs:350`), and the isolate is
  terminated even in a loop that never yields.

### 8.2 The design

```
 host (server)                                         child (Bun, its own process)
 Functions.invoke(standIn) ── ctx, db ──► stand-in ──► call {fn, args, exec clock, snapshot, env, catalog} ──►
   real ctx.db / auth / scheduler / meta ◄── op {name, args, report} ◄──  the real handler, a ctx of ops
   (in the call's async context)          ── reply {value | error, created tables} ──►
                                        ◄── done {value | thrown, report}
```

- **Stand-ins.** The child's load (§7) describes each function, now with its validators' JSON. The host's version
  (`RemoteCodeVersion`, `executor.ts`) makes a `FunctionDef` per function with the validators rebuilt
  (`validatorFromJson`), and registers it in `REMOTE_FUNCTIONS` (builders.ts). `Functions.invoke` builds the `ctx`
  as for any function and, for a stand-in, calls its runner with that `ctx` and the transaction instead of the
  handler. So the engine runs the stand-in as any function: arguments and results checked by the host's own code
  (`checkArgs`, `checkReturns`, the 16 MiB caps, `notAQuery`), under its permit, its user timer, its deterministic
  execution, its environment, its audit lines, in its transaction.
- **The call's messages are read in its own async context.** The host's reader only queues a call's messages; the
  stand-in's loop (`HostCall.run`) takes them and starts each operation from inside the call, so every
  `AsyncLocalStorage` the engine keeps (the execution, the timer, `process.env`, the handle scope, the nested-call
  queue, the sub-function lines) is the call's, with no `AsyncResource`.
- **Each operation runs on the real `ctx`**: `ctx.db.get/insert/patch/replace/delete`, `db.system.get`, the query
  terminals, `ctx.auth.getUserIdentity`, `ctx.storage` (`getUrl`, `getMetadata`, and in a mutation
  `generateUploadUrl`, `delete`), `ctx.scheduler` (`runAfter`, `runAt`, `cancel`), `ctx.runQuery`,
  `ctx.runMutation`, `ctx.meta`, `createFunctionHandle`. Read set, OCC, commit, query cache, limits and the
  scheduler stay the engine's.
- **Checks on every message** (`host-call.ts`): the call must be running (an `op` or `done` for any other id kills
  the child); the operation must be one its function's kind may send (a query has no scheduler and no
  `runMutation`), and no write from a `db` that is a reader (a query run by a mutation); at most 4 arguments; every
  value decoded strictly (an unknown tag is a bad message). A query's own `db` is its transaction, which has the
  writes and refuses them ("queries cannot write"), as under `vm`: that op is answered by the engine, not killed.
- **Size limits.** The observable ones stay the host's checks of the decoded values (Convex's 16 MiB arguments and
  result, `FUNCTION_MAX_ARGS_SIZE` / `FUNCTION_MAX_RESULT_SIZE`; a document's 1 MiB; the transaction's limits), with
  their messages. The frame cap (§7.2) bounds every message the child sends.
- **One child per code version**, as §7.9 planned for this PR; PR 9 builds the elastic pool of one-call processes.
  A child that dies is replaced at the version's next call; its in-flight calls fail as a system error
  (`ExecutorFailure`, the client's internal-error message, which a function cannot catch, as Convex's for a
  terminated isolate). A version is retired when another is installed (`Executor.installed`), its child stopped once
  its last call ends; the function tester's is released after its run; a version never installed is stopped when
  collected (`FinalizationRegistry`); `close()` stops them all at the server's shutdown. Every child is stopped
  through its own `Subprocess` (its pid).

### 8.3 Values and errors across the wire (`wire.ts`)

Under `vm` the engine gets the app's own objects and checks them in its own order (`copyValue`, `toJsonValue`,
`extractCommitTs`, the validators). To keep each message and its order, the codec carries more than values:
- values with tags of their own (`{"$n":"5"}` an int64 of any size, `{"$f":"NaN"}`, `{"$b":…}` bytes, `{"$u":0}`
  `undefined`, `{"$t":0}` the commit timestamp placeholder); a plain object with a `$` key as entries, so no field
  is read as a tag; `__proto__` a key like any other;
- **what is not a value** (a class instance, a function, a symbol) as its kind and class name: the host builds an
  object of that class name from no realm of its own, as the app's objects are under `vm` (its context's realm), so
  `Point {…} is not a supported value type (present at path .v …)` comes out the same. A `Set` or `Map` also carries
  its entries (at most `MAX_WIRE_ENTRIES`, 16384), and a `Date` its time; the host builds a real one with the app's
  class name, so `Set[1] …` and `scheduler.runAt(new Date(…))` come out the same too (STUDY-18 §9);
- function references by their name or path, or the error reading them threw; cycles as cycles.

Errors:
- an operation's error reaches the app with the engine's class, name and message; if it leaves the handler as it
  came, the host throws its **own original** (`{k:"op"}`), with the stack the child's app context gave it;
- the app's own errors are rebuilt in a realm of their own (`vm.createContext`), as a `vm` function's are not the
  server's `Error`; a `BunvexError` as the server's, with its data (its class is the base of the app's);
- a thrown non-error (`throw "x"`, `throw {a:1}`, `throw undefined`) as the value;
- a query object returned: the engine's `notAQuery` error, made on the host.

### 8.4 The synchronous APIs

| API | Under `vm` | Under `process` |
|---|---|---|
| `db.query(t)` and each link (`withIndex`, `withSearchIndex`, `fullTableScan`, `order`, `filter`, `limit`) | run at the app's call; `db.query` records the table's read (or a missing table's), `withIndex` the index's `_index` read | The child runs core's synchronous checks in their order and words (a copy of `QueryImpl`'s, `child-db.ts`), with the engine's own builders (`IndexRangeBuilder`, `SearchFilterBuilder`, `filterBuilder`) and `compileRange` against the index's fields when the call's catalog has the index ready, so a bad range throws at `withIndex`. Each link is reported with the next message (`WireReport.links`) and the host makes the same link on its real chain **before** that message's operation: each `db.query` and `withIndex` runs once on the host, its reads recorded as under `vm`. The terminal names the last link. |
| `normalizeId`, `db.system.normalizeId` | the catalog's table numbers | The call carries the namespace's catalog (each table's number and its indexes' fields and enable time), by epoch: sent once per catalog object and child, and again once it is out of the last 4 the child keeps (the host counts them as the child does, `EpochWindow`). Tables this transaction creates come back with every answer. |
| `process.env.X` | a read, in the read set | The call carries the variables (the deployment's, then the built-ins, as the engine's reader resolves them), by epoch: sent once per variables object (the engine's snapshot cache) and child, within the same window. The child checks the name as the engine does (`checkEnvVarName`), and reports each read, in order; the host reads them on its transaction (the read set: the same intervals, a name read twice twice). |
| `ctx.meta.getSnapshotTs()` | the snapshot, `observeTime()` | The call carries the snapshot; the child marks the time observed, and every message reports it (the host calls `observeTime()`). |
| `Date.now()`, `performance.now()`, `Math.random()`, `crypto.*`, timers, `fetch` | core's deterministic globals, per execution | The same code (core's `determinism.ts`, installed in the child before any load): the call carries its execution's clock (`now`, `performance.now()`'s start and elapsed time); the child makes an execution from it (`executionFromClock`) with its own seed drawn on first use, as `runDeterministic`'s. A nested call of the same host execution joins the child's same execution (the same clock and random stream, as under `vm`). |

What still differs is the iterator's start: `q[Symbol.asyncIterator]()` throws its start checks (a bad index name)
at the first `next()`, not at the call; a `for await` fails at the same statement either way.

### 8.5 User time

- The child runs the handler under core's own timer (`withUserTimer`), each operation's wait paused as a store call
  is (`pausingUserTime`), checked before and after each operation: its timeout and its refusals (a timer in a query)
  throw in the child exactly where they throw under `vm`.
- Every message reports the time run since the last (`ran`); the host's timer is paused for the whole call and
  charged with it (`chargeUserTime`, core). So the 1 s limit counts the function's JavaScript, not the round trips:
  1500 sequential inserts pass a 60 ms limit though their wall time is well past it (`bridge-limits.test.ts`).
  Starting a replacement child is not user time either.
- **The backstop.** While none of a call's operations is on the host, the host arms a timer for the call's remaining
  user time plus 50 ms (`BACKSTOP_SLACK_MS`, STUDY-168 §13.1). A function that never yields (`for (;;) {}`) is then
  stopped: its child killed, the call failed with "Function execution timed out (maximum duration: …)", as Convex
  terminates its isolate. Under `vm` such a function blocks the server for good. The other calls of that child fail
  as a system error (one child per version: §8.2); the next call gets a new child.
- The host's work on an operation (the engine staging an insert) is not user time under `process`, as Convex's
  syscalls are not; under `vm` it is, the engine running in the function's own clock.

### 8.6 Wiring

- **Note (a).** `bunvex-local-backend` (`packages/bunvex/bin/local-backend.ts`) provides the executor:
  `provideProcessExecutor(createProcessExecutor)`, as it provides the persistence drivers. `createServer` takes the
  provided factory when the start asks for `process`; without one it fails at start ("needs its executor … call
  provideProcessExecutor(createProcessExecutor) from @bunvex/sandbox"), and the local backend checks it before its
  store opens. `check-deps` lets `bunvex` import `sandbox`, and `sandbox` import `protocol` (function references).
- **Isolation.** `process` starts only with `BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`, which is said at start
  (`PROCESS_SANDBOX_WARNING`: not a security boundary yet). `auto` (the default), `namespaces` and `landlock` fail
  at start until PR 8 builds them: an operator who asked for isolation never runs without it (the owner's
  fail-at-start decision). Windows is refused (AD-44).
- **The executor reaches every load** through the callers' existing dependencies: `PushService`'s `executor`,
  `loadLatestCode` / `loadComponentCode` / `standaloneQuery` an `executor` argument, `deployCode` and the auth
  config's re-evaluations `createServer`'s. Push-time evaluations (the auth config, schemas) run in one child the
  executor keeps for them.
- **Note (b).** Under `process` an auth config that `JSON.stringify` refuses is the push's
  `AuthConfigUnserializableError`, "auth config file can only contain strings" (Convex's code and words,
  `auth_config.rs:286-290`, its docs link left out as DV-04 does).
- **Note (c).** A compiled executable carries no `child.ts` yet: `createProcessExecutor` fails at start saying so,
  never at a push (PR 9/11 make the child the same executable).

### 8.7 What is not available yet under `process`, and how it fails

| What | How it fails | Its PR |
|---|---|---|
| Actions (`"use node"` ones too) | when called: "Actions are not available yet under the function sandbox 'process' …: unset BUNVEX_FUNCTION_SANDBOX to run them in 'vm'" (the function's error) | 5, 10 |
| HTTP actions | each analyzed route answers with the same words for "HTTP actions" (the router keeps its routes: a wrong path is still a 404) | 6 |
| Components | the push fails (`InvalidModules`, "Components are not available yet …"); a start with components installed fails to load the code, saying so | 7 |
| Rooms (AD-42) | the push fails ("Rooms …"); `ctx.rooms` in a mutation throws on use | later |
| Log lines (`console.*` in a function) | the child prints them to the server's stdout; the client and the log streams get none | 4 |
| Source-mapped stacks | the child formats them in the app's context (its frame maps), so most frames already read as the app's; a value error thrown in a write's synchronous part shows `at async` (STUDY-150's `fix` cannot see it was synchronous) | 4 |

Actions and HTTP actions fail when called, not at the push: a push of an app that has some still serves its queries
and mutations, which is what this PR makes testable; components and rooms change what the push installs, so they
refuse it.

### 8.8 Divergences and additions

None new against Convex. Against `vm`, `process` is closer to Convex in three places, each Convex's behaviour: a
function that never yields is stopped at its user time; the engine's work on an operation is not user time; and
the iterator's start checks throw at `next()` (Convex's `queryStream` is synchronous: this one is the only place
`process` is further from Convex than `vm`, §8.4). The kill granularity (one child per version) is STUDY-168 Q3's,
decided with the pool (PR 9). AD-44 is updated: queries and mutations run under `process`, with `none` isolation.

### 8.9 Parity

**The bridge's own differential test** (`test/bridge-parity.test.ts`, 183 tests): the same module deployed to a
`vm` server and a `process` server, and for every case what the client gets compared (the value, or the error's
first line and its data; ids, creation times and request ids normalized): 106 query cases, 53 mutation cases, 6 of
the validators', and 18 read sets (the intervals each query read, by `table.index`, ids and times normalized: so a
result is invalidated by the same writes). Every one matches. It found:
- in the child (PR 2's): the deterministic globals were not installed before the first load, so a code version's
  contexts copied the real `setTimeout` and `fetch` (in a function, and at import); fixed here;
- in `vm`: `Object.prototype` names in `process.env`, the commit timestamp placeholder in a pushed function's
  objects, and every cached query result expiring after 17 s; fixed on their own (§9, #751), which this branch
  merges;
- in the bridge itself: the user timer not paused during the call, a child's start counted as user time, an env
  read reported once per name instead of once per read, and `db.query` / `withIndex` reads recorded only when the
  query ran.

**The suites under both executors** (`BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`, with
`test/process-preload.ts` providing the executor for in-process servers):

| Suite | `vm` | `process` | Every `process` failure |
|---|---|---|---|
| Server pushed-code suites (PR 2's 19 files, `cors`, `component-tree`) | 186 / 186 | 117 / 186 | 46 components, 10 actions, 8 HTTP actions, 4 log lines, 1 frame line |
| `examples/` end to end | 76 / 76 | 58 / 73 (3 not run) | 8 actions, 6 HTTP actions, rooms-cursors's push refused (1 failure, its 3 tests not run) |
| CLI suites that push (`deploy`, `dev`, `env`, `error-stacks`, `run`, `run-inline-query`, `mcp`, `dashboard-links`, `external-packages`, `component-push`) | 107 / 107 | 86 / 107 | 10 components, 7 log lines, 3 actions (`"use node"` packages), 1 HTTP action |
| `packages/differential` against Convex's binary (`d8bdde0`) | 176 / 176 | 120 / 176 | 34 actions, 12 HTTP actions, 7 log lines, 2 frame lines, 1 component |

Each failure was read: a test whose query and mutation steps all pass and that then calls an action, an HTTP action
or a component fails at that step with §8.7's message; a log-line failure is a test that reads `logLines` or the
log stream; the frame lines are the one of §8.7 (`at async` for a value error thrown in a write's synchronous part).
**No query or mutation outcome differs** from `vm` or, in the differential suite, from Convex's binary: every
generated and fixed program's query and mutation calls agree. Every example without actions passes.

### 8.10 Measurements

`bench/calls.ts`: pushed code, called in-process through `Functions` (no HTTP), one call at a time, each with its
own argument (no cache hit); 2000 calls per line after 300 (100 × `db.get`: 500). p50 / mean / p99, µs.

**Mac** (8 cores, shared, load average 5–6; two runs, the second):

| Function | vm | process |
|---|---|---|
| empty query | 19 / 24 / 58 | 74 / 87 / 276 |
| 1 × `db.get` | 25 / 30 / 63 | 113 / 124 / 211 |
| 10 × `db.get` | 55 / 63 / 144 | 500 / 528 / 1440 |
| 100 × `db.get` | 349 / 447 / 2853 | 4358 / 4453 / 8639 |
| page of 100 | 236 / 262 / 907 | 470 / 558 / 2536 |
| insert mutation | 42 / 53 / 186 | 150 / 173 / 597 |

**Linux VPS** (AMD EPYC 9354P, 2 vCPUs, Ubuntu 24.04, Bun 1.4.3; idle; the second of two runs, then pinned with
`taskset -c 0`, host and child on one vCPU):

| Function | vm | process | vm, pinned | process, pinned |
|---|---|---|---|---|
| empty query | 58 / 99 / 1210 | 199 / 276 / 1500 | 57 / 133 / 2235 | 204 / 294 / 2250 |
| 1 × `db.get` | 74 / 95 / 369 | 488 / 706 / 2444 | 78 / 187 / 2429 | 308 / 380 / 2376 |
| 10 × `db.get` | 165 / 206 / 1562 | 2122 / 3328 / 11383 | 180 / 371 / 3638 | 1175 / 1443 / 5061 |
| 100 × `db.get` | 1154 / 1264 / 4946 | 28808 / 29989 / 60567 | 1076 / 1376 / 6398 | 9180 / 9584 / 18651 |
| page of 100 | 609 / 609 / 1460 | 1329 / 1520 / 4298 | 637 / 804 / 3581 | 1138 / 1347 / 5249 |
| insert mutation | 136 / 156 / 256 | 610 / 815 / 2665 | 131 / 332 / 4393 | 399 / 524 / 2852 |

- **Per operation** (from 100 × `db.get`): about 40 µs on the Mac, about 280 µs on the VPS unpinned and about 80 µs
  pinned. STUDY-168 §5.2's prototype: about 30 µs on the Mac, 240 µs unpinned and 40 µs pinned on a VPS of the same
  CPU. The difference is the frames on a socket of the child's own (PR 2 measured them slower than Bun's IPC channel,
  which the prototype used) and this PR's per-operation work (the codec, the checks, an async hop each way). The
  wakeup latency between two vCPUs dominates unpinned, as STUDY-168 §4.3 found.
- **Per call** (empty query): +55 µs on the Mac, +140 µs on the VPS (the prototype: +80 µs unpinned).
- **A page of 100** is one round trip: +230 µs on the Mac, +700 µs on the VPS, mostly the 100 documents' JSON.
- **Next**: Convex batches consecutive reads in one round trip (`async_syscall.rs:230-290`); batching the child's
  concurrent operations (STUDY-168 §13.4) and pinning (PR 9) are the levers, measured there.

### 8.11 Tests and sabotage

`packages/sandbox/test/`:
- `bridge-parity.test.ts` (183): §8.9;
- `bridge-limits.test.ts` (12): user time counted in the child (1500 inserts within a 60 ms limit); the timeout's
  message as under `vm`; the function log's user time is the child's; a result that read the snapshot's time
  expires from the cache and one that did not stays (both executors); a function that never yields stopped at its
  limit, the next call served by a new child; a call waiting on the stopped child fails as the internal error; a
  child that forges operations (an unknown one, one for another call, a value with an unknown tag, too many
  arguments, a write from a reader's `db`) is killed and nothing is written; a write from a query's own transaction
  refused by the engine;
- `wire.test.ts` (25): values round-trip exactly (special floats, any int64, bytes, `undefined`, lone surrogates,
  `$` keys, `__proto__`, cycles, the commit timestamp placeholder); what is not a value (from another realm, as an
  app's) fails `copyValue` and prints as `stringifyValueForError` does, the same; function references; what the
  host refuses; the new messages' shape checks.

Changed: `host.test.ts` and `analysis-parity.test.ts` (the validators' JSON in a version's description, the protocol
version), `function-executor.test.ts` (`process` starts with `none` and its executor; refused with any other isolation
or without one, before the store opens), `code-store.test.ts` (an import-time value read through a query, so it runs
under either executor), `commit-ts.test.ts` (a placeholder in another realm's objects).

| Break | Failing tests |
|---|---|
| The child's time not charged (`chargeUserTime` a no-op) | 1: the function log's user time |
| The engine's timer not paused during the call | 1: 1500 inserts within a 60 ms limit |
| No backstop | 2: a function that never yields; a call waiting on its child |
| No allowlist (a reader's write let through) | 1: a write from a query run by a mutation |
| Chain links made at the terminal only | 62: most query cases and read sets |
| `process.env` reads not reported | 1: the `env` read set |
| An operation's error rebuilt instead of the host's original | 3: `nestedMissing`, `insertMissing`, `patchNoValue` |
| Determinism not installed in the child | 2: `timer`, `fetch` |
| `withIndex`'s range not compiled in the child | 3: the synchronous range errors |
| `normalizeId` ignoring table numbers | 2: `normalizeId`, `normalizeSystem` |
| Strict decoding off | 2: an unknown tag; the `badTag` forgery |
| What is not a value decoded as this realm's (a `Set` as a `Set`) | 6: the codec's `Set` / `Map` cases, `insertSet`, `insertMap`, `scheduleSet` |
| `getSnapshotTs` not marking the time observed | 1: the cache expiry of a time read |
| An `op` for an unknown call accepted | 1: the `otherCall` forgery |
| `vm`: `hasCommitTs` back to this realm's objects only | 2: `commitTsScheduled`, the `system` read set |
| `vm`: app metrics on the deterministic clock | 1: a result that read no time stays cached |
| `vm`: the built-ins read with their prototype | 1: `envConstructor` |

Each was applied to the file, the three bridge test files run, and the file restored from a saved copy and compared
before the next.

### 8.12 Open questions and later PRs

- **No new divergence**, so no question for the owner from this PR. One finding for later, not this PR's: under both
  executors a `Set` or `Map` written as a value prints as `Set {…}` (its realm is the app's context, so the values
  package's `instanceof Set` misses it), where Convex prints `Set[1]`. Fixed by STUDY-18 §9 (#754), for both
  executors.
- **The pool (PR 9)**: one-call processes, so a timeout or a crash fails only its call; replacing a child off the
  call's path (a warm spare); the child's memory baseline (§7.5) against the 96 MiB cap.
- **Logs and stacks (PR 4)**: console lines and audit lines as operations; a value error thrown in a write's
  synchronous part keeps the app's frame (the host can tell the error was synchronous).
- **Batching** (§8.10) of the child's concurrent operations, and the iterator's start checks at the call (§8.4).

## 9. Three `vm` bugs the bridge's parity test found

STUDY-168 PR 3's differential test (§8.9, `packages/sandbox/test/bridge-parity.test.ts`: the same pushed
module on a `vm` server and a `process` server, every answer and read set compared) showed three places where the
default `vm` executor differs from Convex. They are fixed here, on their own, because they change the default path.
No divergence is recorded: each was a bug against Convex's behaviour.

| Bug | How Convex does it | Before | Now |
|---|---|---|---|
| `process.env.constructor` (any `Object.prototype` name) | one name at a time, `environmentVariables/get` (`npm-packages/udf-runtime/src/00_misc.ts:16-30`): unset unless set | the built-ins were a plain object read by name: `constructor` was `Object` (a function, not a value: the query failed), `__proto__` `{}`; an action's variables the same | unset (`ownVar`, functions.ts), in queries, mutations and actions; set, it reads as itself |
| `db.vars.commitTs` inside a pushed function's objects | the placeholder is refused in scheduled arguments, resolved in a mutation's result (STUDY-53) | `hasCommitTs` and `resolveCommitTs` looked only into this realm's plain objects, and a pushed function's come from its context (STUDY-35): its scheduled arguments took the placeholder (the job was scheduled with it), and a mutation that returned it failed its answer (`reformat` met the `$commitTs` token) | a plain object of any realm (`isPlainObject`, commit-ts.ts): refused, resolved |
| The query cache's expiry | a result expires after `MAX_CACHE_AGE_MS` only if the query read the time (`observe_time`) | `AppMetrics` took the deterministic `Date.now` (its default clock, read when `createServer` makes it) and recorded every query inside its execution, which marked every result as time-dependent: every cached result expired after 17 s | `AppMetrics` reads core's `wallClock`: a result that read no time stays cached |

**Tests:** `push.test.ts` (the five prototype names unset in a query and an action, set as itself),
`commit-ts.test.ts` in the server (a pushed mutation's result resolved, deep too; the placeholder refused in scheduled
arguments, deep too) and in values (`hasCommitTs`, `resolveCommitTs` on another realm's objects), `meta.test.ts` (a
query that reads no time stays cached past `MAX_CACHE_AGE_MS`, in-process and over HTTP).

**Sabotage:** each fix undone alone fails its test: the built-ins' lookup (1), an action's (1), `hasCommitTs` (2),
`resolveCommitTs` (2), `AppMetrics` on `Date.now` (1).

**The cache, before and after** (a pushed query that reads no time, 120 calls over HTTP, the cache clock moved 1 s
per call, no writes): before, 104 runs (13 % hits); now, 1 run (99 % hits). The skewed clock overstates the old
miss rate (a result is stamped with the real time, so past 17 s of skew every check expires it); in real time, the
old code ran a hot query again once every 17 s, where Convex (and now bunvex) runs it once.

## 10. Two `vm` bugs the logs parity test found

STUDY-168 PR 4's differential test (§8.9's `bridge-parity.test.ts`, now comparing the whole error message and the
log lines, built in the next PR) showed two places where the default `vm` executor differs from Convex. They change
the default path, so they are fixed here, on their own, as §9's were. No divergence is recorded for either: each was
a bug against Convex's behaviour.

| Bug | How Convex does it | Before | Now |
|---|---|---|---|
| A function's time zone | `ensure_utc` (`crates/common/src/utils.rs:66-75`), called when the function runner starts (`crates/isolate/src/client.rs:470`): `TZ` unset becomes `UTC`; set to anything else (empty included) the backend refuses to start, "TZ is set, but Convex requires UTC. Unset TZ to continue." | a pushed context's `Date` followed the server's zone: on a machine in São Paulo `new Date(0).toString()` in a function was `Wed Dec 31 1969 21:00:00 GMT-0300 (Brasilia Standard Time)`, and `console.log(new Date(0))` the same in its log lines; a child of the `process` executor (whose environment holds no `TZ`) read UTC | `bunvex-local-backend` sets `TZ=UTC` before anything starts and refuses another value with Convex's words in bunvex's name (`TZ_NOT_UTC`, local-backend.ts) |
| `log.audit`'s errors in pushed code | made in the app's bundle (`npm-packages/convex/src/server/impl/audit_logging.ts`, `validateKey` and the variables' lookup): the app's frames | the server's `log` object, so an error it threw (a key starting with "$", an unknown variable, "not yet supported in actions") carried the server's own frames and paths in `error.stack` (`at invoke (…/packages/server/src/functions.ts:…)`), which the app could read, return or log; only the client's uncaught message dropped them (`mapStack`) | `bunvex/server`'s namespace, as a pushed context imports it, has `log` seen through the context's wrapper (`appNamespace`, app-errors.ts), as the engine's errors are (STUDY-150): the frames of the app's call, mapped |

**What is left as it was.** An embedded server (`createServer` in an app's own process) does not set the process's
time zone: it is the host app's, and a server library changing it would change the app's own dates. Its pushed
functions keep the host's zone (a question for the owner, in the PR).

**Tests:** `local-backend.test.ts` (a `TZ` of `America/Sao_Paulo`, empty or `utc` refuses the start with the
message and exit code 1; unset or `UTC`, the start makes a context's `new Date(0).toString()` UTC);
`audit-error-frames.test.ts` (uncaught, the client's message ends with the app's frames; caught, `error.stack` in a
query and an action is the app's frames alone; `log.vars` reads as itself through the wrapper).

**Sabotage:** `TZ` not set at start (1 failing test); the refusal removed (1); `log` not wrapped (1: the caught
stacks).
