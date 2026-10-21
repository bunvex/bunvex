# STUDY-171 — The function executor seam and its knobs (STUDY-168 PR 1), the wire and the child runtime (PR 2), queries and mutations over the bridge (PR 3), two `vm` bugs (§10), logs and errors (PR 4), actions (PR 5), unhandled rejections (PR 4b), HTTP actions (PR 6)

- **Status:** PR 1 implemented (#738); PR 2 (§7) implemented (#743); PR 3 (§8) implemented (#750); §9 (#751) and §10 (#759) fixed; PR 4 (§11) implemented (#760); PR 5 (§12) implemented (#773; the owner's decisions of 2026-10-21 in §12.11); PR 4b (§13) implemented (#802); PR 6 (§14) implemented (this PR); AD-44 accepted
  (owner, 2026-10-19)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend, the reference commit
  ([upstream.md](../parity/upstream.md)); §13 and §14 at `72ce13c`, checked against its binary
  `precompiled-2026-10-10-72ce13c`
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

Convex has no executor choice; the default behaves as before. Found later (§10, §11.9):

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-527 | An embedded server (`createServer`) leaves the process's time zone alone: its pushed functions' `Date` follows the host's zone, not UTC | the zone is the whole process's; a library setting it would change the host app's dates, and it cannot refuse a process it does not own | owner, 2026-10-20 |
| DV-528 | Under `vm`, an unhandled rejection in app code is printed and the function goes on; `process` will fail it (STUDY-168 PR 4b) | `vm` cannot tell which call a rejection belongs to (§11.9) | owner, 2026-10-20 |
| DV-537 | `bunvex dev` starts the local backend with `TZ=UTC`, whatever the shell's `TZ` | Convex's CLI passes the shell's `TZ` through, so its backend refuses to start; bunvex's user is not blocked | owner, 2026-10-20 |

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
| Actions | done in PR 5 (§12): they run in the child, as under `vm` | 5 |
| `"use node"` actions | when called: "\"use node\" actions are not available yet under the function sandbox 'process' …: unset BUNVEX_FUNCTION_SANDBOX to run them in 'vm'" (the function's error) | 10 |
| HTTP actions | each analyzed route answers with the same words for "HTTP actions" (the router keeps its routes: a wrong path is still a 404) | 6 |
| Components | the push fails (`InvalidModules`, "Components are not available yet …"); a start with components installed fails to load the code, saying so | 7 |
| Rooms (AD-42) | done in PR 5 (§12.5): stand-in definitions, gates run in the child, `ctx.rooms` / `ctx.presence` as operations | 5 |
| Log lines (`console.*` in a function) | done in PR 4 (§11): the client, the function log and the log stream get them as under `vm` | 4 |
| Source-mapped stacks | done in PR 4 (§11.3): an error the engine makes at the app's call keeps the app's frames, as under `vm` | 4 |

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
functions keep the host's zone (DV-527).

**`bunvex dev`** starts its local deployment's backend with `TZ=UTC` in its environment, whatever the user's shell
holds, so a `TZ` there does not stop it (DV-537). Convex's CLI passes the shell's environment through
(`npm-packages/convex/src/cli/lib/localDeployment/run.ts`, `env: { ...process.env, … }`), so on Convex a `TZ` other
than `UTC` in the shell makes the local backend panic at start ("Failed to setup timezone").

**Owner decisions (2026-10-20).**
- Refuse a `TZ` other than `UTC` at start, as Convex does, rather than overriding it with a warning: accepted (built
  here).
- `bunvex dev` passes `TZ=UTC` to the backend it spawns, so a user with `TZ` set in their shell is not blocked:
  DV-537.
- An embedded `createServer` cannot refuse, since it does not own the process: it keeps the host's zone, DV-527
  ("Não dá pra fazer": JavaScriptCore has no per-realm zone, and setting the process's would change the host
  app's own dates).

**Tests:** `local-backend.test.ts` (a `TZ` of `America/Sao_Paulo`, empty or `utc` refuses the start with the
message and exit code 1; unset or `UTC`, the start makes a context's `new Date(0).toString()` UTC);
`local-deployment.test.ts` (with `TZ=America/Sao_Paulo` in the CLI's environment, the local deployment starts and
its backend was given `TZ=UTC`);
`audit-error-frames.test.ts` (uncaught, the client's message ends with the app's frames; caught, `error.stack` in a
query and an action is the app's frames alone; `log.vars` reads as itself through the wrapper).

**Sabotage:** `TZ` not set at start (1 failing test); the refusal removed (1); `log` not wrapped (1: the caught
stacks); `bunvex dev` passing the shell's `TZ` through (1: the backend exits with the refusal).

## 11. PR 4: logs and errors under `process`

STUDY-168 §12.3's PR 4: a sandboxed query's or mutation's console lines reach the caller, the function log and the
log stream exactly as under `vm`, and its errors carry the same stacks. **The default does not change**: `vm` stays
the default. The two `vm` bugs its parity test found are fixed on their own (§10, #759), which this branch merges.

### 11.1 How Convex does it (re-read at `d8bdde0`)

- **The console is an op per line.** `npm-packages/udf-runtime/src/02_console.ts` renders each argument in the
  isolate with object-inspect (`maxStringLength: 32768`, `indent: 2`, `customInspect: true`) and sends the strings
  with the level (`console/message`); `console.trace` sends its frames (`console/trace`), source-mapped and put under
  the message on a line of their own (`crates/isolate/src/ops/console.rs:27-40`); `time`, `timeLog` and `timeEnd` are
  ops of their own. The host stamps the line with the wall clock when the op runs (`environment/udf/mod.rs:264-272`:
  "accessing the current time here is still deterministic since we don't externalize the time to the function").
- **Limits are the host's.** A line is cut at `MAX_LOG_LINE_LENGTH` (32 KiB of UTF-8) with " (truncated due to
  length)" (`crates/common/src/log_lines.rs:47-48`, `new_developer_log_line`); a function keeps `MAX_LOG_LINES - 1`
  lines and spends the last on "Log overflow (maximum 256). Remaining log lines omitted.", dropping the rest
  (`emit_log_line`, `environment/udf/mod.rs:1326-1345`). A nested call's lines join its caller's in place
  (`emit_sub_function_log_lines`).
- **Stacks** are the isolate's frames mapped through the module's source map, the runtime's trimmed
  (`udf-runtime/src/errors.ts` `setupSourceMapping`, `JsError::from_frames`); a syscall's error is made again in the
  app's code where it awaited it (`performAsyncSyscall`), a check of Convex's JS library throws at the app's call.
- **`log.audit`** is the async syscall `1.0/auditLog` (`environment/udf/async_syscall.rs:774`, `:1287`): the body is
  checked in JS, the line held by the host, bounded as it is added.
- **An unhandled rejection** fails the function once the microtask queue has drained
  (`execution_scope.rs:90-110`, `request_scope.rs:504-540`). bunvex's `vm` does not: Bun prints it to the server's
  stderr and the call goes on (its result unchanged). `process` keeps `vm`'s behaviour for now (§11.6); DV-528
  records `vm`'s for good, and PR 4b makes `process` fail the function (§13).

### 11.2 Logs

```
 child                                                         host
 console.log(…) ─ the server's console capture (logs.ts) ─►  line {level, messages, cut, wall-clock time}
                  rendered and cut as in-process              queued on the call
 next op / done ─────── report.lines ─────────────────────►  logged in the call's execution (logChildLine), in
                                                              order, before the op runs or the result is read
```

- **The child runs the server's own console capture.** `captureLines` (logs.ts) runs the handler in an execution of
  its own whose owner hands each line on: the same `render` (object-inspect, patched), the same `makeLogLine` (the cut
  at 32 KiB of UTF-8, lone surrogates as U+FFFD), the same timers (`time`, `timeLog`, `timeEnd` and their warnings),
  the same `console.trace` (the frames mapped with the child's own source maps, `mapStack`). So every console
  method `vm` supports renders the same text, by construction; the others (`assert`, `count`, `dir`, `table`,
  `group`) print to the process's stdout, as under `vm` (the child's stdout is the server's).
- **Sent with the call's next message** (`WireReport.lines`: level, messages, cut, timestamp), not one message per
  line nor all at the end. The host logs a message's lines before it runs the message's operation or reads its
  result, so the order relative to nested calls (whose lines are logged when they run, on the host) and to errors is
  `vm`'s: a line logged before a `runQuery` comes before the callee's lines, one logged after it after them, and
  every line before the error that ends the call. Batching costs nothing per line: a line rides on a message the
  call sends anyway.
- **Timestamps** are the child's wall clock (core's `wallClock`, not the function's frozen `Date.now()`), read when
  the line is logged, as `vm` and Convex stamp it.
- **The host logs them where the console would have** (`logChildLine`): into the current execution, so the caller's
  `logLines`, a cached query's stored lines (replayed on a hit), a mutation's attempt (`perAttempt`), the function
  log's Completion (`bunvex logs`, the dashboard) and the log stream's `console` events (the sinks) all get them as
  they get `vm`'s. A nested call's lines are named by it (`subFunction`), on the host.
- **Limits.** The host keeps applying the 256-line cap (`capped`); the child sends at most `MAX_LOG_LINES` lines of
  one call (the first 256 are the only ones that can be shown: a query's or mutation's lines are not streamed), which
  bounds what a logging loop costs the wire. A line the child says is within the cut is not measured again unless it
  might not be (3 bytes per UTF-16 unit): a broken child's longer line is cut again, as the console cuts it.
- **Checked as every message is**: a level outside the five, a message that is not text, a timestamp that is not a
  finite number kills the child (`parseChildMessage`).

### 11.3 Errors and stacks

What PR 3 left (§8.7): the app's errors already crossed with their class, name, message and data, and their stacks
were made in the child's app context (its `Error.prepareStackTrace`, its source maps), so most frames read as
`vm`'s. What differed was an error the engine made **at the app's call**:

- Under `vm` an engine method runs synchronously until its first `await`, in the app's call stack, so an error it
  makes there (a value that is not a value, written: `copyFields`; a bad id; an index not found, made when
  `withIndex` was) holds the app's frames, and `installAppErrors`'s `fix` keeps them (no `at async` frame). Under
  `process` the engine runs that code on the host, in no app frame, so the child gave the error the frames of the
  app's `await` (`at async …`).
- **Now the host tells.** It runs each operation through a function of its own name (`atTheAppsCall`) and makes each
  chain link through one named for it (`atTheAppsLink<id>`); an error whose own frames include one was made at the
  app's call (or at that link's), and the reply says so (`sync`, `link`). The child takes a stack at each operation
  and each link (`new Error()`: about 0.1 µs, measured) and gives such an error those frames, which its context then
  maps exactly as `vm` maps the engine's (`fix`, `mapStack`). JavaScriptCore drops a frame in a tail call (a module
  is strict code), so the named functions return from inside a `try`.
- **`log.audit`** was refused in the child (its scope was unset: "not yet supported in actions"). It is an operation
  now (`log.audit`): the child clones and checks the body as `vm` does (its errors the same, at the same place), the
  host adds the line to the call's scope (`addAuditLine`), shared with the nested calls, its heap limit checked
  there. A line that is not a JSON object kills the child.
- **Errors at import** (push) were already the loader's in the child (§7.4, the 557 corpus entries); the parity test
  now compares the push's whole message, frames included, for nine kinds of failure.

### 11.4 Time zone

A child's environment holds no `TZ` (§7.3), so its `Date` was UTC while a `vm` server's followed the machine's
zone. Convex's is always UTC (§10): the child now gets `TZ=UTC` explicitly, and `bunvex-local-backend` sets it for
`vm` (#759).

### 11.5 Parity

**`bridge-parity.test.ts`** now compares, for every case, the client's whole answer: the value or the error's whole
message (frames included) and its data, **and the log lines**. Of 273 tests:

- 106 → 148 query cases, 53 → 79 mutation cases (with #754's): every console method; strings, numbers, `-0`,
  `NaN`, bigints, symbols, `undefined`, Unicode and lone surrogates; objects, arrays, classes, null-prototype objects,
  functions, `Set`, `Map`, `Date`, typed arrays, `RegExp`, errors (`console.log(new Error(…))`, an engine's error,
  its stack), a document and query results; a line over 32 KiB, several messages over it, multi-byte characters at
  the cut, a long string inside an object; 255, 256 and 300 lines; timers and their warnings; `console.trace`;
  lines then a throw (an error, a `BunvexError`); lines around nested queries and mutations (caught, uncaught, rolled
  back, 200 + 300 lines across a nested call), concurrent operations, a getter that throws while rendering;
  `log.audit` (variables, a `$` key caught and uncaught, an unknown variable, nested, in a mutation); stacks of
  values written that are not values (insert, patch, the scheduler, a nested call's arguments), of a chain's link,
  a deep throw, a helper's throw;
- 13 checks that the function log and the log stream get the same structured lines (levels, messages, cut,
  sub-function, order), each stamped within the call;
- a cached query's lines on a hit; 9 errors at import (the push's whole message); 3 unhandled rejections under
  `process` (below), 18 read sets, 6 validator cases.

Every one matches. What it found: the time zone and `log.audit`'s server frames in `vm` (§10, #759).

**The suites under `process`** (`BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`). PR 3's
counts were taken on an older main; the "before" column is PR 3's code on today's main (`9254fa5c`), the "after"
this branch:

| Suite | PR 3 (§8.9) | Before | After | Every remaining failure |
|---|---|---|---|---|
| Server pushed-code suites (21 files) | 117 / 186 | 116 / 187 | 121 / 187 | 47 components, 12 actions (`"use node"` ones too, and the `process.env` tests' action steps), 7 HTTP actions |
| `examples/` end to end | 58 / 73 | 58 / 73 | 58 / 73 | 8 actions, 6 HTTP actions, rooms-cursors's push refused |
| CLI suites that push (10 files) | 86 / 107 | 87 / 108 | 93 / 108 | 10 components (`component-push`, `dev`'s local component), 4 `"use node"` actions (`external-packages`, `deploy`'s), 1 action (`run`) |
| `packages/differential` against Convex's binary (`d8bdde0`) | 120 / 176 | 238 / 294 | 239 / 294 | actions, `"use node"` actions, HTTP actions and components only |

- **The log lines are gone from the failures**: the function tester's lines and its function log entry
  (`run-test-function`), objects logged from either realm (`log-realms`), the dashboard runner's test query and its
  lines (`dashboard-functions`), and the CLI's (`run`'s, `dev`'s). The `examples/` suite reads no log line.
- **The frame lines are gone**: `value-error-frames`' "written or passed to a nested call: its frame alone", and in
  the differential suite the value errors' `at async <anonymous> (../bunvex/values.ts:N:N)` for `values:insert`
  (now `at <anonymous> (…)`, as Convex's) and the engine errors' mutation cases. What still differs there is an
  action's (`values:runQueryWith`, `frames:actionUncaught`), which runs in `vm` only until PR 5.
- Each remaining failure was read: it fails at the step that calls an action, an HTTP action or a component, with
  §8.7's message (or a push refused for its components).

### 11.6 What is left

| What | Under `process` | Its PR |
|---|---|---|
| Actions' lines (streamed as they come, `onLine`), `"use node"`'s `util.inspect` rendering | actions do not run yet | 5, 10 |
| An unhandled rejection in a query or mutation | as `vm`: printed to the server's stderr (the child's), the call goes on; an unawaited operation's failure reaches the child after the call ends, as it reaches `vm`'s promise (the call's answers are awaited before the child forgets it) | Convex fails the function (§11.1). `vm`: DV-528, kept. `process`: fails the function since PR 4b (§13) |
| Import-time `console.log` | printed to the server's stdout, as under `vm` (no function's lines) | — |

### 11.7 Measurements

`bench/calls.ts` gains three lines, each call under `collectLogs` as an HTTP or WebSocket call is: an empty query,
and a query that logs 1 and 10 lines (`console.log("line", k, { i })`). p50 / mean / p99, µs, 2000 calls per line after
300, the Mac (8 cores, shared; load average 5–7 during these runs, and much noisier at times):

| Function | vm, before | process, before | vm, after | process, after |
|---|---|---|---|---|
| empty query | 20 / 27 / 90 | 65 / 72 / 135 | 19 / 24 / 61 | 68 / 84 / 330 |
| 1 × `db.get` | 28 / 36 / 106 | 128 / 161 / 970 | 26 / 33 / 108 | 119 / 134 / 276 |
| 10 × `db.get` | 55 / 65 / 156 | 526 / 555 / 1449 | 54 / 64 / 173 | 509 / 570 / 1940 |
| 100 × `db.get` | 339 / 375 / 2448 | 4514 / 4754 / 10180 | 338 / 372 / 2298 | 4736 / 5067 / 12196 |
| page of 100 | 235 / 253 / 431 | 450 / 496 / 1794 | 240 / 259 / 436 | 565 / 716 / 2922 |
| insert mutation | 44 / 56 / 183 | 137 / 170 / 810 | 43 / 53 / 120 | 129 / 142 / 267 |
| empty query, lines collected | 17 / 19 / 39 | 63 / 70 / 123 | 17 / 21 / 43 | 61 / 68 / 142 |
| 1 `console.log` | 31 / 35 / 67 | 74 / 83 / 156 (printed, not captured) | 31 / 37 / 129 | 75 / 82 / 178 |
| 10 `console.log` | 104 / 112 / 217 | 105 / 120 / 269 (printed, not captured) | 109 / 122 / 310 | 142 / 156 / 375 |

(The second of two rounds, each "before" run right before its "after"; in the first, the after column's 10-line p50
was 212 µs, the machine's noise.)

- **A line costs about what it costs under `vm`**: about 14 µs for the first (the capture's execution, the line) and
  8–9 µs for each more, in both; rendering it (object-inspect) is most of it, in the child as in-process. The wire
  adds little (the line's JSON on a message the call sends anyway, its parse and logging on the host): `process`
  stays `vm` plus its constant per-call cost (about 45 µs here). Before this PR the child printed its lines to stdout instead, which is what the
  "before" column measures.
- **No cost per operation** that the noise shows: a stack per operation and per link (0.1 µs), the `sync` check
  only on an error, the empty `lines` of each report.
- Not measured on Linux: the test VPS was running another session's soak test.

### 11.8 Tests and sabotage

`packages/sandbox/test/`:
- `bridge-parity.test.ts` (273): §11.5;
- `bridge-limits.test.ts` (15): forged lines (a level that is not one; a line past the cut said not to be cut, cut
  again) and a forged audit line that is not JSON;
- `wire.test.ts`: the report's lines checked (their level, text, cut flag and time); `host.test.ts`: the child's
  environment has `TZ`.

| Break | Failing tests |
|---|---|
| The child sends no lines | 44 |
| The host drops them | 45 |
| Lines sent only with `done` | 10 (the nested calls' order, in the answer and in the function log) |
| The child stops at 255 lines | 3 (`logMany`, `logExactlyMax`, the function log's `logMany`) |
| No "made at the app's call" (`sync` never set) | 47 (every stack of an engine error made at the call) |
| A link's error given the operation's frames | 2 (`indexMissing`, `linkErrorStack`) |
| The link made without its named frame | 2 (the same) |
| `log.audit` left to the child's own scope | 4 (the audit cases) |
| The host trusts a long line's length | 1 (the forged long line) |
| A nested call's lines not named on the host | 6 (the function log's nested cases) |
| The child's `TZ` not set | 2 (`logCollections`, the child's environment) |

Each was applied to the file, the three test files run, and the file restored from a saved copy; `git diff` was
compared with the one before the break after each (`scratchpad` script).

### 11.9 Owner decisions and open questions

- **No new divergence from `vm`.** One finding against Convex, decided by the owner on 2026-10-20: an unhandled
  rejection in a query or mutation fails the function in Convex once the microtask queue has drained (§11.1,
  `environment/udf/mod.rs:1103-1119`, `UnhandledPromiseRejection`); both bunvex executors print it and go on.
  - **`vm`: DV-528, "Não dá pra fazer" (impossible in `vm`).** Every `vm` call shares the server's process and event
    loop, and Bun's `unhandledRejection` listener runs with no AsyncLocalStorage context, so a rejection cannot be
    traced to the call that made it when several run at once (as DV-500 found for `"use node"` actions). `vm` logs
    it to the server's stderr and the call keeps its result.
  - **`process`: fails the function**, as Convex, in a later sandbox PR (STUDY-168 §12.3, PR 4b): the child runs
    one call at a time, sees the rejection in that call's context and can fail it with Convex's message. Until then
    `process` keeps `vm`'s behaviour, which `bridge-parity.test.ts` pins ("a rejection nothing handles leaves the
    call as under vm"); that PR turns those three cases into the failure. **Built in §13**; the child runs several
    calls at once, so it attributes by checkpoint rather than by the one call running.
- Actions (PR 5): their lines stream as they come (`onLine`), so the child must send them as they come too, not with
  the next message; the per-call cap does not apply to them.

## 12. PR 5: actions under `process`

STUDY-168 §12.3's PR 5: under `BUNVEX_FUNCTION_SANDBOX=process`, an action runs in its code version's child, every
`ctx` operation and every `fetch` answered on the host, with the action's real `ctx`. **The default does not
change**: `vm` stays the default, and under it nothing runs differently (the server's changes are exports and one
refactor, `vectorSearchFilter`, that `vm` runs the same way). `"use node"` actions stay PR 10's, HTTP actions PR 6's,
components PR 7's.

### 12.1 How Convex does it (re-read at `d8bdde0`)

- **An action's operations are tasks** (`crates/isolate/src/environment/action/task.rs:45-63`): async syscalls
  (`runQuery`, `runMutation`, `runAction`, the scheduler, `storageGetUrl`, `1.0/actions/vectorSearch`, …) and async
  ops, among them `Fetch`, `StorageStore`, `StorageGet` and `SendStream`. The task executor runs them outside the
  isolate (`task_executor.rs`) and hands each answer back between turns of its loop.
- **Bytes stream** both ways: a fetch's response body and a stored file's bytes go to the isolate as
  `TaskResponse::StreamExtend` chunks (`stream.rs:36` `send_stream`, `fetch.rs:34` `run_fetch`, `storage.rs:103`
  `run_storage_get`); a request body and a file to store come from the isolate as a stream (`storage.rs:42`
  `run_storage_store`). A failure mid-stream is an `AbortError` `DOMException` or a `StreamFailed` error.
- **Vector search's filter is built in JS**: `vector_search_impl.ts:59-60` runs the app's filter on the builder and
  sends its expression with the query (`:81`, `1.0/actions/vectorSearch`).
- **The timeout** terminates the isolate (`environment/action/mod.rs`, the `Timeout`): nothing the action started runs
  further, and after the action's answer its isolate ends too (`:1297-1305` counts what it left without an answer, the
  unawaited-operations warning).
- **Lines** are streamed to the function log as they are printed (Convex's progress events).

### 12.2 The design

```
 host (server)                                               child
 Functions.runAction(standIn) ── action ctx ──► stand-in ──► action {fn, args, variables at its start, meta} ──►
   ctx.runQuery / storage / vectorSearch / rooms / fetch ◄── op {name, args, report.lines} ◄── the handler, a ctx of ops
   (in the action's async context: its timeout's signal,     ── reply ──►
    its meter, its pending operations, its log)            ◄── lines (as they come)
                                                          ◄── done {value | thrown, the operations left unanswered}
   bytes: chunk frames + end / fail / credit / stop, both ways (a fetch's bodies, a stored file's bytes)
   past the timeout: ── cancel ──►  ◄── cancelled   (none in 1 s: the child is killed)
```

- **The stand-in is the action's handler.** `RemoteCodeVersion` gives each action a handler that runs it in the
  version's child (`HostActionCall`). The engine calls it as it calls any action (`Functions.runAction`): under its
  permit and its timeout (`withActionTimeout`), with its environment (`inActionEnv`), its handle scope, its function
  log entry, its `ctx` (`trackedCtx`, so each operation counts as pending until it settles). Each operation the child
  sends runs on that `ctx` in that async context; the checks of every message are §8.2's: an operation an action may
  not send (a `db` write) kills the child.
- **In the child** (`child-action.ts`) the handler runs outside any execution: the real `Date`, `Math.random`, timers
  and `crypto`, as under `vm`. `process.env` is the variables at its start, which the call carries, read with the
  engine's name check (`withAllEnv`). `ctx` has the same keys in the same order as `vm`'s (`Object.keys(ctx)` is the
  same), each method an operation; the app's errors and the engine's cross as in §8.3. `log.audit` refuses with the
  server's words (actions have no audit lines, as in-process).
- **Lines stream.** A line the action logs is sent as it comes: with the action's next operation, or on its own at the
  end of the turn (`lines`). The host logs it in the action's execution, so the function log's progress events, the
  log stream and the caller's lines are `vm`'s, in order with the nested calls' lines. The per-call cap of queries
  (§11.2) does not apply: an action's lines are not held.
- **Protocol version 4.**

### 12.3 `fetch`

- **The host's own `fetch`.** The child's global `fetch` (core's deterministic one) sends, during an action, through
  the call (`setFetchSender`): the request is described (its URL or `Request`, the web's `RequestInit` fields; Bun's
  own options are dropped, as `isolateFetch` drops them), sent as the `fetch` operation, and the host calls the
  global `fetch` in the action's context: the action's signal (aborted at its timeout), its sender (`isolateFetch`,
  through the operator's proxy or the address screen, DV-325), its egress meter and its pending count. So every
  check, every refusal and every error is the host's, by construction: a scheme other than `http(s)`, a 407, a
  metadata address, reqwest's causes, the redirects (followed one by one, `manual`, `error`, 20 at most, a streamed
  body that cannot be resent), the default `User-Agent`.
- **Bodies.** A string, `URLSearchParams` and `FormData` (its files' bytes) are rebuilt on the host as they were, so
  the host measures and encodes them as `vm` does; bytes and `Blob`s up to 64 KiB go inline, larger ones and any
  `ReadableStream` as a stream (§12.4's streams), read as the host's `fetch` reads them. The response's head comes
  back with the reply; its body streams to the child as the app reads it.
- **The response** is a `Response` made in the child from the host's head and stream, read as the host's response is
  read (`asActionResponse`, the server's own wrapper): a body read twice, or one that breaks, fails with Convex's
  words, as `vm`'s; `url`, `redirected` and `type` are the host's; `blob()` is typed by `Content-Type`, as Bun types
  a fetched response.
- **Aborts.** An abort of the app's signal (waiting, or while the body is read) is sent to the host, which aborts its
  request: Convex's `AbortError`. At the action's timeout the host aborts every fetch of the action (its signal), and
  the child aborts its own (§12.6).
- **Cross-realm bodies.** The app's `ArrayBuffer` is its context's: told by its slot (`isBytes`), not by `instanceof`
  (the parity test's `fetchPostBuffer` found it).

### 12.4 Bytes: streams of chunk frames

STUDY-168 §14.1 planned bytes in 1 MiB chunks off the JSON channel. They share the socket, as frames of their own
(`frames.ts`): a length with its top bit set, the stream's id, then the bytes, no JSON and no base64.

- **Flow control** (`streams.ts`): a sender sends no more than its receiver's credit, in chunks of at most 1 MiB;
  the receiver gives credit back as its reader takes the bytes (by half a 4 MiB window). The host's streams start with
  that window (the child takes what it is sent as it comes); the child's start with none, until the host opens them
  when it reads the operation that names them, so the child can send no byte the host did not ask for. A stream nobody
  reads holds a window at most; a slow reader slows its sender.
- **Checks.** A chunk for a stream the host did not open, past its credit or over 1 MiB (refused from its header), an
  `end` or a `fail` for no stream, kills the child; a file whose bytes are not the size it said too.
- **No copies of the bytes** on the way (the second commit): a chunk is written as its header then its bytes, and read
  out piece by piece as it arrives, a view of what was read, never joined; a stored file goes to the engine as its
  parts.
- **`ctx.storage.get`** answers the file's type and size, its bytes inline up to 64 KiB, else a stream; the child
  makes the `Blob` (`SpecBlob`, as in-process) from the parts. **`store`** sends the `Blob`'s bytes the same way; the
  host makes the `Blob` the engine stores. What is not a `Blob` gets the host's own refusal. The other methods are
  operations, as a mutation's.
- **Sent before the answer.** An operation whose arguments take a while to make (a file's bytes, a body read) is
  started at the app's call and sent once they are made; the action's `done` waits until it is sent, so the host
  runs what the action started (and counts what it did not await), as the engine runs it in-process. Without it, a
  `store` the action did not await reached the host after the action's answer: the host killed the child for a
  message of a call that had ended.

### 12.5 Vector search, rooms, nested calls

- **`ctx.vectorSearch`**: Convex's JS-side checks and the app's filter run in the child, at the app's call
  (`vectorSearchFilter`, the server's code, which `vm` now runs too); the filter's expression is sent with the query,
  and the host searches with it as the engine's own (STUDY-168 §14.1's "recorded filter").
- **Rooms (AD-42).** The push no longer refuses rooms. The child describes each definition (its validators' JSON, which
  gates it has); the host makes stand-in definitions with the real builders, whose gates (`canJoin`, `canPublish`) run
  in the child as queries (`REMOTE_GATES`, run by `runGate` as any gate, `key#canJoin`). `ctx.rooms.broadcast` /
  `members` and `ctx.presence.list` are operations in an action; `ctx.rooms.broadcast` in a mutation too (sent once it
  commits, by the host's `ctx`).
- **`runQuery` / `runMutation` / `runAction`** are operations on the host's `ctx`, so their checks (`parseArgs`, the
  value check, the `_system/` refusal), their errors (`toActionCallerError`) and the callee's display are the
  engine's; the app's context view (`appContext`) gives the error the frames of the app's `await`, as under `vm`. A
  nested action runs in the child too, as its own call.
- **Unawaited operations.** The child's `done` names the operations it had not had the answer of when the action
  returned; the host counts them as pending, even those whose answer had already left it (Convex counts what the
  isolate had not taken). Without it, `ctx.meta.*` left unawaited was missing from the warning (the differential test's
  "ctx's calls, ctx.meta, createFunctionHandle and storage count").

### 12.6 The cut-off, then a kill

STUDY-168 §10.3: "the cut-off, then a kill of the process if it ignores it".

- **On the host, as under `vm`** (STUDY-77): past the timeout the action fails with Convex's message, its permit is
  free, its `ctx` refuses to start anything (`cutOffWithAction`, `checkActionAlive`), its fetches are aborted, its
  lines after it are not logged.
- **In the child**: the host sends `cancel`. The child rejects every operation waiting with the timeout, refuses every
  later one, aborts the action's fetches, drops its lines and its `done`, and says `cancelled`; the host then forgets
  the call. A child that does not say it within **1 s** (`CUT_OFF_GRACE_MS`) is running JavaScript that never yields
  (`for (;;) {}`, or `for (;;) await null`, which never lets the socket be read): it is killed. Its other calls fail
  as a system error (one child per version, §8.2), and the next call gets a new child. Under `vm` such an action
  blocks the server's event loop for good.
- **What it does not stop**: an action that heard the cut-off keeps its child. The timers its code set are cleared then
  (`trackedActionTimers`, the engine's own tracking, #782), but JavaScript already running or queued (a loop that
  yields on `await`, a `fetch` it did not await settling) goes on there, cut off from everything but its own module
  state: owner decision Q-PR5-1 (§12.11), kept until PR 9.
- **After its answer** the child ends the call as Convex ends its isolate and as `vm` ends an action (STUDY-77 §7,
  #782): the timers its code left are cleared, and any `ctx` call or `fetch` made afterwards (an operation's
  continuation, a `ctx` kept in module state and called by a later action) is refused with `ACTION_ENDED_MESSAGE`, "the
  action has ended: its operations can no longer run"; an operation in flight finishes. Owner decision Q-PR5-2
  (§12.11).

### 12.7 Parity

**`action-parity.test.ts`** (138 tests, with "an action ends with its answer" under both executors): the same module deployed to a `vm` server and a `process` server, the client's
whole answer compared (the value or the error's whole message, frames included, its data, and the log lines). 129
action cases: the nested calls (their values, their errors caught and uncaught, awaited or returned, with data, a
missing function, arguments that are not values or not an object, a validator's refusal, a `_system/` path, an action
four deep), the scheduler, `auth`, `meta` and `ctx`'s keys, `process.env`, the clock and timers,
`createFunctionHandle`, `getServiceToken`, `log.audit`, lines (several levels, 300 lines, around a nested call),
thrown values of every kind, results that are not values and one over 16 MiB, the unawaited-operations warning (meta,
storage, fetch, a 3 MiB store, after an await, none), 45 `fetch` cases (every body kind each way, a 4 MiB stream up,
3 MiB down whole and streamed and unread, statuses, `HEAD`, 204, redirects of each kind, a streamed body on a 307, a
bad scheme, a bad URL, a refused connection, the metadata address, aborts before, while waiting and while reading,
a body that breaks, read twice, cloned, `blob()`, Bun's options), 15 storage cases (small, empty, a `File`, 16 MiB + 5
byte for byte, a bad `sha256`, not a `Blob`, from a `fetch`, deleted, bad ids, upload URLs), 10 vector searches (with
filters `eq` and `or`, bad filters, an empty vector, a missing argument, a bad index, wrong dimensions, a zero limit),
8 rooms and presence calls; then a validator's 4 cases, a room's gate (let in, kept out), the room definitions, and
the writes, jobs and files the cases left. Every one matches.

**`action-limits.test.ts`** (16): the timeout under both executors (a fetch in flight aborted; what the action calls
after it refused, its lines not logged, nothing written), a loop that never yields and one that awaits forever
stopped (`process` only), an action that heard its cut-off keeping its child; the function log's progress events of a
streaming action and of a nested one, as under `vm`; eight forged messages (a `db.insert` from an action, an unknown
operation, an unasked chunk, an unasked `cancelled`, a file of the wrong size, a `fetch` with no input, a bad tag, too
many arguments), each killing the child with nothing written; a child killed under an action.

**`streams.test.ts`** (11): chunk frames split at every size between messages, never joined, views of what was read;
both caps; 16 MiB + 123 bytes whole in chunks of at most 1 MiB; the credit; the child silent until opened; the host's
refusals; a failing source; a cancelling reader; the other side gone.

**The suites under both executors** (`BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`; `vm`
passes every test of each). "Before" is PR 4's branch (#760, `009108c4`), "after" this branch, the same day; the
differential suite against Convex's binary `precompiled-2026-10-10-72ce13c`:

| Suite | `vm` | Before | After | Every remaining failure |
|---|---|---|---|---|
| Server pushed-code suites (21 files) | 188 / 188 | 121 / 188 | 125 / 188 | 47 components, 8 `"use node"` actions, 8 HTTP actions |
| `examples/` end to end | 76 / 76 | 58 / 73 (3 not run) | 70 / 76 | 6 HTTP actions (`http`, `file-storage`'s upload and CORS routes) |
| CLI suites that push (10 files) | 108 / 108 | 93 / 108 | 94 / 108 | 10 components, 3 `"use node"` actions (external packages), 1 HTTP action (`deploy`) |
| `packages/differential` against Convex's binary | 301 / 301 | 244 / 301 | 276 / 301 | 12 `"use node"` actions, 12 HTTP actions, 1 component |

Each remaining failure was read: it stops at a step that calls a `"use node"` action, an HTTP action or a component
(§8.7's message), or a push refused for its components. The examples all run now (rooms-cursors's push was refused
before), and `vm` still passes every test of every suite on this branch. The differential suite's action tests whose `"use node"`
cases fail were also run with those cases left out: their V8 action cases all pass (`error-frames`, `value-errors`,
`nested-errors`).

### 12.8 What it found

- In the child: an `ArrayBuffer` body told by `instanceof` (the app's is its context's); a response's reads not
  failing as the host's (`asActionResponse`); `blob()` untyped; `ctx.meta` left unawaited missing from the warning;
  an unawaited `store` sent after the action's answer (the child was killed).
- In `vm`: one difference between the executors, §12.6's last point: `vm` let an action's leftover timers run and reach
  the database. Decided (Q-PR5-2): both executors now end an action as Convex does (#782 for `vm`; here for the child,
  with the parity case "an action ends with its answer").

### 12.9 Measurements

`packages/sandbox/bench/actions.ts`: pushed code, each action run in-process through `Functions.runAction` (no
HTTP), one at a time; the `fetch` target is a Bun server in a process of its own. p50 / mean / p99 µs per action
(MiB/s from the p50). **Linux VPS** (AMD EPYC 9354P, 2 vCPUs, Ubuntu 24.04, Bun 1.4.3), idle (no other process of
any session), the second of two unpinned runs; raw output and the runner in
`bench/process-sandbox/results/pr5-actions/`:

| Action | vm | process | process − vm, p50 |
|---|---|---|---|
| empty action | 71 / 92 / 196 | 211 / 255 / 1476 | +140 |
| action, 1 `runQuery` | 166 / 214 / 1878 | 536 / 606 / 1907 | +370 |
| `fetch` GET, empty body | 810 / 1056 / 3459 | 1946 / 2612 / 7826 | +1136 |
| 10 × `fetch` GET, empty body | 6721 / 7709 / 18895 | 15111 / 16389 / 34347 | +8390 |
| `fetch` GET, 64 KiB | 845 / 1082 / 3828 (74 MiB/s) | 2643 / 3109 / 7966 (24 MiB/s) | +1798 |
| `fetch` GET, 1 MiB | 2794 / 3060 / 9144 (358 MiB/s) | 6232 / 6700 / 14280 (160 MiB/s) | +3438 |
| `fetch` POST, 1 MiB | 2978 / 3625 / 14003 (336 MiB/s) | 8415 / 9196 / 23777 (119 MiB/s) | +5437 |
| `storage.store`, 1 KiB | 286 / 388 / 2386 | 770 / 1101 / 5061 | +485 |
| `storage.get`, 1 KiB | 140 / 163 / 947 | 711 / 978 / 3470 | +571 |
| store + get + delete, 1 MiB | 2016 / 3628 / 11533 (992 MiB/s) | 9309 / 10062 / 20592 (215 MiB/s) | +7293 |
| store + get + delete, 16 MiB + 1 | 57891 / 57837 / 89870 (553 MiB/s) | 147912 / 153423 / 243204 (216 MiB/s) | +90022 |

- **A simple action** costs about +140 µs under `process` (p50 211 µs against 71 µs), the same constant as a query
  (§8.10: +140 µs); a `runQuery` from it about +370 µs, a round trip plus the nested query's own call.
- **Per `fetch`** the bridge adds about 0.8–1.1 ms on this 2-vCPU guest with three busy processes (host, child, target):
  the 10-fetch line gives 0.84 ms per fetch. The first run had `process` *faster* on the empty fetch (1133 µs against
  1275 µs): the fetch lines are dominated by the target and the scheduler, and vary by ±50 % between runs. Pinned to
  one vCPU (`taskset -c 0`): +329 µs per empty fetch, +263 µs each in the 10-fetch line.
- **Per storage call** about +0.5 ms (1 KiB, its bytes inline: one round trip and the engine's own work on the host).
- **Bytes**: the 16 MiB + 1 round trip (stored, read back, deleted: 32 MiB moved) runs at **216 MiB/s** under
  `process`, 553 MiB/s under `vm` (+90 ms). Before the second commit (no joins, no copies) it was 154 MiB/s
  (207 ms p50, `c1-bytes.txt`): +40 %. A 1 MiB `fetch` body streams at 120–160 MiB/s, a 1 MiB round trip at 215
  MiB/s. STUDY-168 §14.1 predicted 60–100 ms more for 16 MiB; measured: +90 ms for 32 MiB moved.
- **`vm` unchanged**: main (with PR 4) under `vm` measured in the same session gives 89 / 116 / 460 µs for the empty
  action, 2288 µs for the 1 MiB GET and 605 MiB/s for the 16 MiB round trip (`base-vm.txt`), within the runs' noise
  of this branch's `vm` column.

### 12.10 Tests and sabotage

`packages/sandbox/test/`: `action-parity.test.ts` (137) and `action-limits.test.ts` (16), §12.7; `streams.test.ts`
(11); `fixtures/children/forge.ts` gains four action forgeries (an unasked chunk, `cancelled`, a file's size, a
`fetch` with no input) and passes chunk frames through. Changed: `protocol.test.ts` and `fake.ts` (the reader's
frames are messages or chunks), `analysis-parity.test.ts` (a version's room definitions as the child describes them),
`forge.ts`'s too-many-arguments case (5 are allowed now: `rooms.broadcast`'s method and four).

| Break | Failing tests |
|---|---|
| No `cancel` sent to the child | 1: an action that heard its cut-off keeps its child |
| No kill after the grace | 2: a loop that never yields; one that awaits forever |
| The child does not say `cancelled` | 1: an action that heard its cut-off keeps its child |
| Lines sent only with the next message or `done` | 17 (the progress events, the timeout cases' lines; the parity file's run stopped early) |
| Unanswered operations not counted as pending | 5: `unawaitedMeta`, `unawaitedStorage`, `unawaitedBigStore`, `unawaitedFetchBlob`, `unawaitedFetchForm` |
| The answer sent before what the action started (`later`) | 1: `unawaitedFetchForm` |
| The host takes a chunk it never asked for | 2: the `chunk` forgery; the streams' refusals |
| A sender ignores its credit | 12 (the credit, the child silent until opened, every body over the window) |
| A file's size not checked | 1: the `fileSize` forgery |
| A chunk's size not capped from its header | 1: the chunk cap |
| The child's responses not read as the host's (`asActionResponse`) | 4: `fetchText`, `fetchRedirect`, `fetchBodyTwice`, `fetchBlob` |
| An `ArrayBuffer` body told by `instanceof` | 1: `fetchPostBuffer` |
| The vector filter not sent | 3: `vectorFilter`, `vectorFilterOr`, `vectorFilterField` |
| Room gates not run in the child (`REMOTE_GATES` unread) | 2: the gate's two cases |
| An action's variables not sent | 1: `env` |
| A response's body not streamed | 26 (every case that reads a body) |
| An abort of the app's signal not sent | 2: `fetchAbortWaiting`, `fetchAbortBody` |
| A stored file read back without its type | 1: `storeSmall` |
| The child's timers not cleared at the action's end (§12.6) | 1: "an action ends with its answer" |
| The child's ended call refusing with other words than `vm`'s | 1: the same |

Each was applied to the file, the three test files run (166 tests), the file restored from a saved copy and compared
byte for byte before the next (a `scratchpad` script). One break first caught nothing, and the test it called for was
added: making a nested call's error at the reply instead of at the app's `await` gave the same frames (the app's
context view already gives them), so that mechanism was removed instead.

### 12.11 Owner decisions (2026-10-21)

No DV or AD number: both are recorded here.

- **Q-PR5-1. An action past its timeout under `process`: cut it off, or kill its child?** Convex terminates the
  isolate at the timeout. **Decided: keep this PR's cut-off, then the kill after 1 s, until STUDY-168 PR 9**; in PR 9
  (one call per process) the timed-out call's own process ends at the timeout, as Convex's isolate does (added to PR
  9's row in STUDY-168 §12.3). Until then it is "not built yet", not a divergence: an action that hears its cut-off
  keeps running JavaScript in its child, cut off from `ctx` and `fetch`; one that never yields is killed after 1 s,
  with the version's other calls in that child.
- **Q-PR5-2. What an action leaves running after its answer (a timer it did not await).** Convex ends the isolate with
  the answer: its timers never fire and its tasks still running are shut down (`environment/action/mod.rs:1226-1233`).
  **Decided: `process`'s behaviour is accepted** (§12.6: a leftover timer's `ctx` calls and `fetch`es are refused,
  "the action has ended: its operations can no longer run", its lines dropped). **`vm` is made to match Convex in a
  PR of its own**: when an action ends, the timers it created are cleared, and a `ctx` call or `fetch` made after its
  end is refused with the same words. No DV for either.

## 13. PR 4b: an unhandled rejection fails the function under `process`

STUDY-168 §12.3's PR 4b (owner, 2026-10-20): under `BUNVEX_FUNCTION_SANDBOX=process`, a promise a query, mutation or
action leaves rejected with no handler fails it, as on Convex. Under `vm` it stays printed, and the call goes on
(DV-528: `vm` cannot tell which call made it). **The default does not change.** HTTP actions and `"use node"` actions
are out of scope (PRs 6 and 10).

### 13.1 How Convex does it (read at `72ce13c`)

- **The isolate records each rejection with no handler.** Its `promise_reject_callback` (`crates/isolate/src/
  request_scope.rs:504-540`) adds the promise and its value to `PendingUnhandledPromiseRejections` on
  `PromiseRejectWithNoHandler`, and removes it on `PromiseHandlerAddedAfterReject`. The comment on that type
  (`execution_scope.rs:75-117`) gives the rule: a rejection is "necessary but not sufficient"; the isolate waits until
  the microtask queue has drained, and a promise still unhandled then fails the function, "as Node.js and the HTML
  spec" do.
- **It checks after every microtask checkpoint, not only at the end.** A query's or mutation's loop
  (`environment/udf/mod.rs:1102-1127`) and an action's (`environment/action/mod.rs:1059-1088`) both run
  `perform_microtask_checkpoint`, then take the first pending rejection, format it (`format_traceback`) and
  `terminate_and_throw(ContextTerminationReason::UnhandledPromiseRejection(err))`. The check comes before the loop
  looks at the function's own promise, so it holds while the function waits for a syscall, after it returned and
  after it threw.
- **A query or mutation runs every syscall to the end before it answers.** Its loop ends only when no syscall is
  pending (`udf/mod.rs:1150`, "No syscalls or javascript to run, so we're done"; `:1250`, "queries and mutations should run all syscalls to completion"),
  so an operation the function did not await, and that fails, fails the function. **Syscalls run in batches**
  (`AsyncSyscallBatch`, `environment/udf/async_syscall.rs:262`): reads (`1.0/get`, `1.0/queryStreamNext`) together, up
  to `MAX_SYSCALL_BATCH_SIZE` (16, `crates/common/src/knobs.rs:613`), `storageGetUrl`s together, any other one alone; a batch's results
  are resolved in order, then the microtasks drain. An action's tasks answer one at a time
  (`TaskResponse`, `action/mod.rs`), each followed by a checkpoint.
- **The error is the value's.** `format_traceback` (`error.rs:32`) gives an `Error`'s `Uncaught <name>: <message>`
  (`format_uncaught_error`, `helpers.rs:210`) and its source-mapped frames, as a thrown error; a value that is not an
  `Error` gets V8's message: `Uncaught a plain string`, `Uncaught 42`, `Uncaught #<Object>`, `Uncaught undefined`, no
  frames. **An application error loses its data**: Convex's runtime marks a `ConvexError` (`ConvexErrorSymbol`, its
  `data` as JSON) only where the handler's throw leaves it (`serializeConvexErrorData`,
  `npm-packages/convex/src/server/impl/registration_impl.ts:112`), so one rejected unhandled reaches
  `extract_source_mapped_error` unmarked: `Uncaught ConvexError: {"code":1}`, with no `data`.
- **The termination is the current function's alone.** `ContextTerminationReason` "applies to just the currently
  running subfunction, and can be caught by the parent function" (`termination.rs:42-48`): a `ctx.runQuery` whose
  callee failed so throws in the caller, which can catch it. Nothing more of the terminated function runs: a
  mutation's writes are rolled back, an action's later calls never happen, and the syscalls an action had not taken
  the answer of are its unawaited operations (the warning). A syscall an action starts in the same turn as the
  rejection has already started as a task (`task_executor.rs`) and is listed unawaited; whether it finishes is a race:
  `rejections:a stopsBeforeOp`'s `runMutation` wrote nothing on the Mac and once on the test VPS, and
  `stopsBeforeFetch`'s `fetch` reached its server on some runs only (Convex's binary).

What an app sees, from Convex's binary (`precompiled-2026-10-10-72ce13c`, `packages/differential`'s
`rejections-app`): the same error as if the value were thrown, at the end of the checkpoint where it was left
unhandled: queries, mutations and actions alike.

### 13.2 How bunvex does it

```
 child: every frame that resumes a call's code                        Bun
 checkpoint(id):  drainMicrotasks(); mark(no call)      what ran before is no call's
                  resume()                              a start, an answer, a chunk, an end; an action's timer callback
                  drainMicrotasks(); mark(id)    ──►    unhandledRejection, in the order the rejections happened:
                                                          r1, r2, Marker(id)  ⇒  r1 and r2 are id's
 call id:         unhandled(r) ──► done {r, as thrown}, no more of its code, what it held never sent
                  checked()    ──► (its marker reported) it may answer
```

- **Attribution by checkpoint and marker** (`packages/sandbox/src/rejections.ts`). Bun's `unhandledRejection` carries
  no async context (the reason for DV-528), and a child runs several calls at once (one child per code version until
  PR 9's pool). So the child resumes a call's code only inside a checkpoint of that call (`child.ts`'s frame loop: a
  call's or action's start, an answer, a stream's chunk or message by the call that owns the stream; an action's
  timer callbacks through `setActionTimerCallback`). A checkpoint drains what was queued before and closes it with a
  marker of no call (a promise rejected with a `Marker`), runs the resumption, drains (`bun:jsc` `drainMicrotasks()`)
  and closes it with a marker of the call. Bun reports rejections in the order they happened, markers among them, so
  what comes before a call's marker, and after the marker before it, is that call's. This is Convex's microtask
  checkpoint, made where the child resumes the app.
- **When Bun reports.** Bun 1.4.2 (the version CI pins) reports a drain's rejections before `drainMicrotasks()`
  returns: the attribution is exact. Bun 1.4.3 reports at the end of the event loop's turn
  (`REPORTS_AT_DRAIN`, found at start): there a call's next checkpoint waits for its last marker's report (its frames
  queue, `later`), so each checkpoint of one call is checked before the next runs, as Convex's are; other calls' go
  on. A marker forces one more turn, so a child left idle still hears it.
- **A query's or mutation's answers reach its code in Convex's order** (`ChildCall.reply`). The host still runs each
  operation as it comes; the child gives the answers to the app in the order the operations were started, a batch at a
  time (`batchOf`: `db.get`, `db.system.get`, `db.query`, `db.next` are reads; `storage.getUrl` its own; every other
  one alone; at most 16), each drained and checked before the next. So `const p = ctx.db.get(bad); await
  ctx.db.query(t).first(); p.catch()` succeeds, as on Convex (one batch); with `ctx.runQuery` in place of `db.get`
  it fails, as there.
- **A query's or mutation's `done` waits** for every operation it started to be answered, its code drained and the
  last checkpoint checked (`settled`, `checked`), so an unawaited operation that fails fails the call. Before this
  PR the child answered at once and an unawaited failure came after the answer.
- **An action answers once the checkpoint it settled in was checked**, so a rejection made in the same turn as its
  `return` fails it. An operation it started in the turn of the rejection that fails it was sent as it was started,
  so it runs, one of Convex's two outcomes (§13.1), and the warning lists it unawaited, as there. (Holding each
  operation until its checkpoint was checked was built and dropped: stricter than Convex, a turn per operation.) Its
  later timers are cleared at its end (§12.6): a rejection there never happens, as on Convex.
- **Failing.** `unhandled(reason)` answers the call at once with the value as thrown (`rejected`: a `BunvexError`
  made a plain error, its data dropped, as Convex's), and marks it terminated: its later operations are never sent and
  never settle, the answers still in flight are dropped, so its code stops at its next operation (an operation sent
  after its `done` would be a bad message for the host, which would kill the child). The host runs a
  query's or mutation's in-flight operations to their end after `done`, as before (a failed mutation's writes are
  rolled back), and a nested call's failure is an error its caller can catch.
- **Outside any checkpoint** (code Bun resumed itself) a rejection is the running call's when exactly one call is
  running and no load is; otherwise it is printed to the server's stderr (`bunvex sandbox: an unhandled rejection no
  call can be found for: …`), as before.
- **A stream the host stopped** (a request body its `fetch` gave up on) may still get the chunks the child had in
  flight: the host now drops them within the credit it gave (`streams.ts`, `stopped`). It used to call that a broken
  child and kill it, an internal error the client saw in 1 of 40 runs of `fetchRedirect307Stream` on the base
  branch's code (0 of 40 since), and in 9 of 40 while this PR held actions' operations a turn.

### 13.3 Limits

- **Bun 1.4.3 and later report at the end of the turn**, and drop a rejection handled before then. The gate keeps one
  checkpoint per call per turn for everything the child resumes (frames, batches, timers), so this matters only for
  the next limit's code, which Bun resumes in the same turn without a checkpoint: a rejection it handles late is
  missed there. Under Bun 1.4.2 (CI's) a drain's rejections are reported before it returns.
- **Code resumed by Bun, not by the child**, with several calls running in the same child: a native completion
  (`crypto.subtle`, reading a `Blob` or a `Response` the app made itself, a `ReadableStream` with no host behind it).
  A rejection that code leaves is printed, not failed, unless that call is the only one running. PR 9 (one call per
  process) makes every rejection its process's call's (STUDY-168 §12.3). Accepted until then (Q-PR4b-1, §13.7).
- **Code of another call resumed by this one's**: a promise kept in module state, awaited by two calls and settled by
  one of them, resumes the other's continuation in the first one's checkpoint. Both calls share the version's
  module state (DV-165), on Convex as here; only the attribution is the first call's.
- **Batches are approximate where the operations differ**: bunvex's `db.query` with a terminal (`collect`, `first`,
  `take`) is one operation where Convex's library makes a `queryStreamNext` per page. Both are reads, so a page and a
  `db.get` share a batch on both; a `collect` of several pages is one answer here, several batches there.
- **An operation started in the turn of the rejection** reaches the host and runs. For a query or mutation nothing of it
  outlives the failed call (a read, or a write rolled back with it), where Convex never runs it (its syscalls wait in
  `pending_syscalls`); for an action it is one of Convex's two outcomes (§13.1).

### 13.4 Parity

**`packages/differential/test/unhandled-rejections.test.ts`** (61 cases and the writes left), the app of
`rejections-app/`, against Convex's binary (`precompiled-2026-10-10-72ce13c`) with bunvex under `process`: 21 query
cases, 24 mutation cases, 16 action cases (a rejection before and after an operation, handled in time, handled too
late, in a helper, of every kind of value, an application error, an unawaited operation and nested call, reads in one
batch and a nested call between, a nested call's failure caught, a throw after a handled rejection; a write then a
rejection, an unawaited write; an action's rejection before a timer, in a timer, in a timer after its answer, one that
stops it before a write, one that starts a mutation or a `fetch` in the turn of its rejection, a nested mutation's
rolled back). Compared: the status, the error's first line, its data, the
value, the log lines, whether the error has the app's frames, and what the writes left (but for the two racy cases of
§13.1). **All match**, on the test VPS under Bun 1.4.2 and 1.4.3, three runs each. What is
rewritten: `ConvexError` / `BunvexError` (DV-03), the docs link of the unawaited-operations warning (DV-04); the frames'
names and positions are not compared (DV-345, DV-346; the same as a thrown error's). Five cases are a known frame
difference (STUDY-150 §6): an id that does not parse is refused at the app's call, so bunvex's error has the app's
frame and Convex's none.

**`packages/sandbox/test/rejection-parity.test.ts`** (68): `vm` (a server in a process of its own,
`fixtures/vm-server.ts`, since `bun test` fails a test on a rejection in its own process) against `process`:

- DV-528 stated: 21 cases (7 shapes × query, mutation, action) where `vm` answers 1 and its server's
  `unhandledRejection` hears the value, while `process` answers what the same value **thrown** gives on `vm`, frames
  included;
- 38 cases on their own, each with Convex's outcome (above), and `vm`'s; a mutation's writes rolled back under
  `process` and kept under `vm`; an action stopped before a write; an operation started in the turn of the rejection
  listed unawaited;
- **attribution under concurrency**: 30 queries, 30 mutations, 30 actions failing in their own timers, 20 actions
  failing once their `fetch`'s body is read (chunks of 300 000 bytes interleaved), and the three kinds at once, every
  third call rejecting: each fails with its own value, the others answer their own; then the child still serves.

`bridge-parity.test.ts`: its three "a rejection nothing handles leaves the call as under vm" cases (PR 4's) moved
here, as failures; two cases stay (an unawaited operation handled later, one whose answer logs a line).
`rejections.test.ts` (1, its scenarios in `fixtures/rejections-scenarios.ts`, a process of their own): the late path
(`asIfReportedLate`) on any Bun: interleaved checkpoints, the gate, a rejection handled in time, an idle child's last
marker. `streams.test.ts` (+1): a stopped stream's chunks in flight dropped within the credit.

The whole `packages/sandbox` suite, this branch merged with `main`: 1161 tests, all passing under Bun 1.4.2 and 1.4.3
on the test VPS. The repository's `bun test --isolate` under Bun 1.4.2 there: 4695 pass, the same 5 failures as the base
branch's (4625 pass), none of them the sandbox's (the release-download and ZIP tests, failing the same way on the base branch there).

### 13.5 Measurements

On the test VPS (2 vCPUs, idle but for the runs, checked with `ps` first), the base branch
(`feat/function-sandbox-actions`, `7ad3cd6d`) against this one, `bench/calls.ts 3000 500` and `bench/actions.ts 1000
100`, alternated. The `process` column's p50, µs, of three rounds each under Bun 1.4.2 (CI's); the actions under
1.4.3, two rounds:

| Function | base | this PR |
|---|---|---|
| empty query | 229, 216, 196 | 249, 227, 244 |
| empty query, six more rounds of 4000 | 219, 210, 200, 226, 214, 220 | 214, 212, 218, 212, 217, 199 |
| 1 × `db.get` | 392, 409, 358 | 392, 371, 395 |
| 10 × `db.get` | 2202, 1932, 1595 | 1715, 1566, 1943 |
| 100 × `db.get` | 16000, 14714, 17749 | 15172, 17205, 15350 |
| insert mutation | 460, 420, 428 | 428, 443, 491 |
| empty action | 221, 201 | 209, 214 |
| action, 1 `runQuery` | 514, 506 | 541, 550 |
| `fetch` GET, empty body | 1116, 1207 | 1037, 1095 |

**No cost per call shows above the machine's noise** (the base branch alone spans 196–229 µs on the empty query). What
a call adds: two `drainMicrotasks()` per frame (23 ns each when empty), two markers per frame (0.4 µs each, a promise
rejected and its event) and the answer's wait for the last marker's report (2.4 µs p50, 17 µs p99, measured alone).
The `vm` column is unchanged (no `vm` code changed but the timer hook, a null check).

### 13.6 Tests and sabotage

§13.4's files. Each break below was applied to a copy on the test VPS, the five files run (`rejections`,
`rejection-parity`, `bridge-parity`, `streams`, `action-parity`) under Bun 1.4.2 and 1.4.3, and the sources restored
from a saved copy and compared (`diff -r`) before the next:

| Break | Failing tests, 1.4.2 / 1.4.3 |
|---|---|
| The listener never fails a call | 58 / 58 |
| No drain and marker before a resumption (what ran before is the call's) | 1 / 0: the actions failing once their `fetch`'s body is read |
| A query or mutation answers with operations pending | 6 / 6 (`unawaitedOp`, `unawaitedNested`, `unawaitedThen`, …) |
| A query or mutation answers as it settles, before its check | 29 / 27 |
| Answers given as they come (no batches) | 5 / 5 (`unawaitedOpHandledLater`, `nestedHandledAfterRead`, `unawaitedHandled`) |
| No drain between batches | 2 / 0: `nestedHandledAfterRead` (1.4.3 releases a batch per checkpoint) |
| An application error keeps its data | 6 / 6 |
| An action's timer callback outside its checkpoint | 2 / 2: the actions failing in their own timers, the three kinds at once |
| A stream's owner not recorded | 1 / 1: the actions failing once their `fetch`'s body is read |
| An action answers as it settles, before its check | 10 / 10 |
| No gate on a call's next checkpoint | 0 / 1: the attribution scenarios (the gate is idle where Bun reports at the drain) |
| No turn forced after a marker | 0 / 1: 300 queries with three reads at once (an answer waits forever) |
| The host refuses a stopped stream's chunks in flight | 2 / 1: the streams case, `fetchRedirect307Stream` (a race) |
| A failed call's later operations still sent | 0 / 0 |

The last one is kept as a guard: an operation that reaches the host after its call's `done` is a bad message, and the
host kills the child with every call in it. No test reaches it: once a call failed, the child resumes none of its code
(its answers are dropped), so only code Bun resumes itself (§13.3) could send one. Two mechanisms were built and dropped on what the tests and the oracle showed: the
listener's own attribution of a report made inside a drain (the next marker attributes it, whenever Bun reports), and
holding an action's operations until their checkpoint was checked (§13.2).

### 13.7 Owner decision (2026-10-21)

No new divergence from Convex in what the parity suites compare. One owner question, on what they cannot reach,
**accepted by the owner on 2026-10-21, with no new number**: recorded as a note in DV-528's row, and added to PR 9's
parity list (STUDY-168 §12.3).

- **Q-PR4b-1. A rejection left by code Bun resumes itself, while several calls run in one child** (§13.3).
  - Convex: the function fails, whatever resumed the code (one isolate per call).
  - bunvex `process`: the same when the child resumed the code (every frame, batch and timer); when Bun did (a native
    completion: `crypto.subtle`, reading a `Blob` or `Response` the app made itself) the rejection fails the call only
    if it is the one call running in the child, and is printed to the server's stderr otherwise.
  - Same: no, in that case only.
  - Why: not built yet. PR 9's one call per process makes every rejection its process's call's, with nothing to
    attribute; until then a native completion carries no async context the child can read.
  - App impact: a query, mutation or action that leaves such a rejection unhandled succeeds under load instead of
    failing (as it always does under `vm`, DV-528).
  - **Decided: accepted until PR 9**, as a note in DV-528's row; PR 9's parity list covers it.
  - The same note covers the Bun 1.4.3+ case (§13.3): where Bun reports at the end of the turn, a rejection that such
    Bun-resumed code handles later in the same turn is not reported, so the call succeeds where Convex fails it. PR 9
    closes it too (one call per process, and that process's checkpoints its own).

## 14. PR 6: HTTP actions under `process`

STUDY-168 §12.3's PR 6: under `BUNVEX_FUNCTION_SANDBOX=process`, an HTTP action runs in its code version's child, its
request going in and its response coming out as streams of PR 5's chunk frames (§12.4), with PR 4b's rejection
checkpoints (§13). **The default does not change**: `vm` stays the default, and runs as before (the server's changes
are exports and one refactor of the body reader, `readsAhead`, which `vm` runs the same way). `"use node"` actions stay
PR 10's, components PR 7's. Based on `main` with PR 4b (#802) merged in.

### 14.1 How Convex does it (read at `72ce13c`)

- **One isolate run per request, in two steps** (`crates/isolate/src/environment/action/mod.rs:439-563`,
  `run_http_action_inner`): the router's `lookup()` (app code: `npm-packages/convex/src/server/router.ts:275`), a 404
  "No matching routes found" when it gives none, then the router's `runRequest()` (`router.ts:304-332`), which makes
  the `Request` (`requestFromConvexJson`), runs the route's handler and turns its answer into the response's JSON
  (`convexJsonFromResponse`, `npm-packages/udf-runtime/src/23_response.ts:270-287`: "HTTP actions must return a
  Response" otherwise; the headers, the status, the body as a stream id, a known length as `content-length`).
- **The request's body is a stream** sent to the isolate as the run starts (`send_stream`, `mod.rs:518-527`), and the
  request's signal is a stream that closes when the client goes (`signal_http_action_abort`, `:565-593`).
- **The response streams**: its head first, then each chunk the body's stream hands its `stream/extend` op
  (`stream_http_result`, `:595-623`). **The isolate's loop runs until that stream ends** (`run_inner`, `:1010-1236`):
  the body's code keeps running (and calling syscalls) after the handler returned; the timeout covers it; an unhandled
  rejection is checked after every checkpoint (`:1071-1088`), failing the run before the head and ending the body with
  an `error:httpAction` line after it (`run_http_action`, `:401-418`); when the stream ends, the task channel is closed
  and the running tasks shut down (`:1226-1233`): nothing of the action runs after its body.
- **The 100 MiB cap is on the body's chunks** (`handle_http_streamed_part`, `:625-670`): the first chunk that would
  cross `HTTP_ACTION_RESPONSE_BODY_LIMIT` is dropped with an `error:httpAction` line, and every one after it.
- **A multipart body is parsed by the host**: `formData()` sends the body's stream to the `form/parseMultiPart` async
  op (`npm-packages/udf-runtime/src/21_formdata.ts:125-148`), a task like any other (so an unawaited one is in the
  unawaited-operations warning, as `formData`); another body type is parsed in JS.

What an app sees is bunvex's `vm`'s already (STUDY-31, STUDY-76, STUDY-143, DV-483, DV-485, DV-529), checked against
Convex's binary by `packages/differential`'s HTTP tests.

### 14.2 The design

```
 host (server)                                                    child
 router stand-in ── runHttpAction (permit, timeout, env, log) ──► http {route, request head, body: s1} ──►
   request.body ── chunk frames, credit ─────────────────────────►  Request(url, headers, body ⟵ s1, signal)
   ctx operations, fetch, formData (the multipart parse) ◄── op ◄──  the route's handler (an action's ctx)
                                                                  ◄── response {head, body}   (once checked)
   Response(head, body ⟵ s2) → the server's own meter (100 MiB,      the body: inline, whole (s2), or a stream
   its lines, its warnings), Bun                                  ◄── chunk frames on s2 (credit), a mark past the cap
   the client leaves ── disconnect ──► (the request's signal)       ◄── end, then done {pending}  (flushed together)
```

- **The router's stand-in** (`RemoteCodeVersion.routerOf`) is an `HttpRouter` made from the routes the child's
  analysis listed (`getRoutes()`, already in the push's analysis since PR 2), in their order, each with a handler that
  runs the app's in the child: so the server routes, names, logs and answers a request (its 404s, its 405, its HEAD)
  exactly as in-process (components' routers come with PR 7). The child finds the route's handler by its method and path in its
  version's router (`httpHandlerOf`).
- **The call** (`HostActionCall.runHttp`, `ChildActionCall.runHttp`) is an action's (§12.2): the same `ctx`, the same
  operations answered on the host's `ctx` in the run's async context (its permit, its timeout, its environment, its
  meter, its pending operations), its lines as they come, its cut-off at the timeout.
- **The request.** Its head goes with the call (the URL as rebuilt by the server, the method, the headers, the request
  id among them); its body, if any, as a stream the host sends with PR 5's credit, so a handler that reads slowly holds
  at most a window. The child's `Request` has the server's own `blob()` (`typedBlob`) and a signal aborted when the
  client leaves (`disconnect`, the host's `req.signal`). A body the handler never touched is stopped when the call
  ends.
- **`formData()`** of a multipart body sends the body back to the host as the operation `formData` (Convex's
  `form/parseMultiPart`): the host parses it with the parser `vm` uses (Bun's) inside `trackedOperation("formData")`,
  so it is pending until it settles, as `trackedFormData` counts it in-process; its files come back as files do
  (§12.4). Any other body is parsed in the child, as in-process.
- **The response is read in the child as the server reads it** (`runHttpAction`): not a `Response` → the server
  refuses it with its own error; its headers before its body (a Blob's or a form's type); no body → none; a body of
  known length (`bodyLength`: bytes, a Blob, a string, a form) → read whole and sent inline (≤ 64 KiB) or as a stream,
  handed to the server with its length (`withBodyLength`), so the server types, measures and frames it as one made
  in-process (past the 100 MiB cap the host gathers it first, so the server drops it whole as in-process, not a MiB
  at a time); a stream → checked for a failure in the handler's turn with the server's own reader
  (`readsAhead`'s `failedEarly`, DV-485: such a failure is the run's 500), then streamed, each chunk checked as the
  server checks it (`bodyChunk`: null and undefined skipped, what is not bytes ends the body with the server's error,
  DV-529).
- **The framing is `vm`'s**: Bun sends a body that ends with its chunk at once with its `content-length`, and chunked
  otherwise (DV-483). So the child writes a stream's chunks and its end without a flush, and the call's `done` right
  after flushes them in one write: a body's last chunk and its end reach the host together, as they reach Bun
  in-process.
- **The 100 MiB cap** is the server's (`meteredBody`) but on the app's chunks, as Convex's: the child counts them and,
  at the first that would cross the limit, sends a mark (`MARK`, a new stream frame) in its place and drops it and the
  rest; the host hands the server `BODY_OVER_LIMIT` there, which the server's meter takes as that chunk.
- **The body streams after the handler returned, and the call goes on while it does**: the code that makes its chunks
  runs in the call's context (its `ctx`, its console, its `fetch`, its `process.env`) and in its checkpoints. It ends
  when the body has been handed over (its end, its failure, or the host's `stop` when the client left or the request was
  a HEAD: the app's stream is cancelled at once, as in-process). Then the call ends as Convex's isolate ends: the timers
  its code left are cleared, a `ctx` it kept refuses with `ACTION_ENDED_MESSAGE` (§12.6). Its `done` carries the
  operations it left without their answer, and the host keeps counting one still running then until the server has
  given its warnings (which come when the response is sent, possibly after it settled).
- **Unhandled rejections** (§13): a rejection checked before the head fails the run with the value as thrown (the
  500); after it, the body ends there with that error, which the server logs as `error:httpAction`, and no more of the
  call's code runs.
- **Checks** (the child is untrusted): a `response` for an action or a second one, an inline body that is not bytes,
  a mark for a stream the host did not open, `formData` from an action, each kills the child.
- **Protocol version 5.**

### 14.3 Parity

**`http-parity.test.ts`** (103 tests): the same module deployed to a `vm` server and a `process` server, each request
made to both, and compared: the status and its text, every header (with `content-length` or `transfer-encoding`), the
body byte for byte, and the function log's run (its name, its status or error, every line, Progress and Completion).

- 84 cases: every kind of response body (text, JSON, none, empty, 204, bytes typed and untyped, an `ArrayBuffer`,
  Blobs typed and untyped, `URLSearchParams`, a form, a number, 1 MiB of text, 3 MiB of bytes, 101 MiB of bytes typed
  and untyped, an explicit length, a type removed, two `set-cookie`s, a redirect); streams (small, typed, empty, slow,
  5 MB, 3 MiB made at once, failing late, at once, with a string, in a pull, after awaits), chunks that are not bytes (a string, a number, an object, null and undefined,
  buffers and views), 141 MiB past the 100 MiB cap; a body that calls `runQuery` and logs in each pull, one that writes,
  one that fetches, one that reads `process.env`; the request (its URL, method, headers and request id, `text`,
  `json` good and bad, 3 MiB read whole and streamed, `blob()`'s type, a body read twice, cloned, unread; multipart
  forms with files parsed, stored, left unawaited; urlencoded; a bad boundary); `ctx` (nested calls and their errors,
  the scheduler, `auth`, `meta`, its keys, `process.env`, `fetch`, `storage` with the request's bytes and a stored
  file served), the console (lines, 300 lines), the unawaited-operations warning; throws of every kind and what is not
  a `Response`;
- 12 routing cases (exact and prefix routes, the longer prefix, HEAD of each body kind, OPTIONS, PUT on a GET route, a
  path no route matches), the writes the cases left, a client that leaves mid-body (the run's log; the app's stream
  cancelled at once and the request's signal aborted, both);
- 5 under `process` only, what it does as Convex and `vm` does not: a rejection before the head (the 500 the same
  value thrown gives), one after it (the body ended there, its `error:httpAction` line), the call's end with its body
  (a timer it left never fires; a `ctx` it kept refuses), with `vm`'s behaviour stated beside it (Q-PR6-1); and a
  `fetch`'s response returned as it came, which `process` sends and `vm` fails (Q-PR6-2).

Every vm-against-process case matches, in every run on the test VPS (more than twenty) and on the Mac. What it found,
fixed before the PR: the response's stream opened on the host after its head was read (an empty stream's end came
first: the child killed); the cap counted on the wire's 1 MiB pieces instead of the app's chunks (141 MiB sent 100 MiB
where in-process sends 60); bodies that end with their chunk framed chunked where `vm` gives a length (the one flush);
an unawaited `formData` missing from the warning half the time (the host stopped counting it once it settled, before
the server's warnings); and a request body stopped while `formData` still read it.

**`http-limits.test.ts`** (4): the four forgeries above, each killing the child with nothing written; the next
request gets a new child. **`streams.test.ts`** (+1): a mark comes out where its sender put it; the host refuses one
for no stream.

**The suites under `process`** (`BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`), on the test
VPS (Bun 1.4.3): "before" is this branch's base (`main` with PR 4b), "after" this branch; `vm` passes every test of
each on both (but the four of the differential suite's that need Node on the machine, below):

| Suite | `vm`, this branch | `process`, before | `process`, after | Every remaining failure under `process` |
|---|---|---|---|---|
| Server pushed-code suites with HTTP routes (12 files: `http-actions`, `http-action-content-type`, `router`, `cors`, `action-end`, `component-http`, `component-tree`, `code-version`, `source-position`, `engine-error-frames`, `action-nested-error-frames`, `serve-after-code-ready`) | 101 / 101 | 81 / 101 | 90 / 101 | 8 components, 3 `"use node"` actions |
| `examples/` end to end | 84 / 84 | 70 / 84 (6 HTTP actions) | 76 / 84 | the 8 of `examples/testing` (below) |
| CLI `deploy.test.ts` | 17 / 17 | 16 / 17 (at its HTTP step) | 16 / 17 (past it, at its `"use node"` action) | 1 `"use node"` action |
| `packages/differential` against Convex's binary (6 skipped on each run) | 350 / 354 | 337 / 354 (12 HTTP actions) | 349 / 354 | 4 `"use node"` suites, 1 component store |

Each remaining failure was read:

- server: 8 components (PR 7), 3 `"use node"` actions (PR 10);
- examples: the 8 of `examples/testing`, whose `@bunvex/testing` server reads `BUNVEX_FUNCTION_SANDBOX` but is not
  given the executor (it fails before any function runs, HTTP or not: a gap of `@bunvex/testing`, not of HTTP
  actions; a note below);
- CLI (`deploy.test.ts`): its one test now passes its HTTP step and stops at its `"use node"` action;
- differential, against Convex's binary `precompiled-2026-10-10-72ce13c`: 4 suites whose app has `"use node"`
  actions, which Convex's binary refuses on this machine (`DeploymentNotConfiguredForNodeActions`: no Node there; they
  fail under `vm` too), and 1 component store. One more fails at times under both executors, `http-action-log-route`:
  **the oracle's own race**. Convex logs a HEAD request as a client disconnect when hyper drops the body before the
  isolate hands it over, and not otherwise; bunvex logs it as Convex usually does. Seen in 6 of 8 runs under
  `process` (not in the final suite run above) and in 1 of 12 under `vm`.

### 14.4 Measurements

`packages/sandbox/bench/http.ts`: each executor's server in a process of its own (`bench/http-server.ts`), requested
over HTTP by the bench's process, one request at a time (1000 for the latency lines, 200 for the 1 MiB ones, 20 for
the 64 MiB ones, after a warm-up). **Linux VPS** (AMD EPYC 9354P, 2 vCPUs shared by the client, the server and the
child; Ubuntu 24.04, Bun 1.4.3), idle (`ps` checked first; nothing else running), four rounds of this branch and two of
its base under `vm` (whose `process` has no HTTP actions); raw output and the runner in
`bench/process-sandbox/results/pr6-http/`. Each round's p50, and the medians:

| Line | `vm`, base (2 rounds) | `vm`, this branch (4 rounds) | `process` (4 rounds) | medians: `vm` → `process` |
|---|---|---|---|---|
| empty HTTP action (`new Response(null)`), p50 µs | 287, 290 | 277, 337, 275, 261 | 520, 607, 593, 728 | 276 → 600 µs (+324) |
| HTTP action answering "ok", p50 µs | 551, 321 | 299, 658, 329, 273 | 524, 606, 613, 1241 | 314 → 610 µs (+296) |
| request body, 1 MiB, read whole, MiB/s | 717, 1242 | 1313, 390, 804, 1230 | 276, 296, 244, 137 | 1017 → 260 |
| request body, 1 MiB, streamed, MiB/s | 587, 588 | 810, 428, 1172, 806 | 364, 356, 350, 208 | 808 → 353 |
| response body, 1 MiB of bytes, MiB/s | 405, 406 | 508, 369, 449, 574 | 274, 218, 253, 230 | 479 → 242 |
| response body, 1 MiB, streamed, MiB/s | 567, 567 | 776, 549, 738, 928 | 319, 231, 314, 267 | 757 → 291 |
| request body, 64 MiB, read whole, MiB/s | 661, 615 | 551, 523, 1134, 537 | 327, 304, 330, 338 | 544 → 329 |
| request body, 64 MiB, streamed, MiB/s | 1997, 1418 | 1334, 1459, 1518, 2129 | 625, 470, 534, 500 | 1489 → 517 |
| response body, 64 MiB of bytes, MiB/s | 551, 495 | 597, 460, 584, 522 | 385, 365, 403, 402 | 553 → 394 |
| response body, 64 MiB, streamed, MiB/s | 1394, 1419 | 1585, 996, 1451, 1198 | 556, 549, 550, 565 | 1325 → 553 |

**Backpressure**: a 96 MiB body streamed a MiB at a time (its `pull` runs only when the reader wants more), read by a
client that takes no more than 8 MiB/s (12 s), then by one that reads as fast as it can; each process's resident
memory sampled every 50 ms, the first lines of a fresh server. Above its idle size, per round:

| Read | `vm` server | `process` server | `process` child |
|---|---|---|---|
| 8 MiB/s | +3.7, +2.9, +3.1, +3.0 MiB | +12.4, +14.5, +7.3, +10.4 MiB | +14.1, +13.1, +13.7, +12.3 MiB |
| as fast as it comes (`vm` 290–839 MiB/s, `process` 441–600 MiB/s) | +2.7, +3.6, +3.5, +3.0 MiB | +19.3, +19.0, +17.7, +20.1 MiB | +28.9, +13.8, +14.1, +21.4 MiB |

- **Memory stays bounded on a slow client**: 96 MiB went through each process holding at most ~15 MiB more than idle
  (the 4 MiB credit window each way, Bun's socket buffers, the 1 MiB chunks in flight), the same whether the client
  reads 8 MiB/s or 500: the child makes the next chunk only when the host's reader gives credit back, and the host
  reads the child only as Bun writes to the client.
- **An HTTP action costs about +300 µs under `process`** (p50 600 µs against 276–314 µs), more than an action's +140 µs
  (§12.9): the request's head and headers both ways, the child's `Request` and `Response`, the response's head then its
  `done`, and three processes on two vCPUs (the client's here too).
- **Bytes**: 250–400 MiB/s through the bridge for a body read or sent whole, 290–550 MiB/s streamed, against
  480–1500 MiB/s in-process (where a streamed body is not copied at all). A known-length body streams to the server
  with its length; gathering it on the host first, as this PR's first version did, gave 148 MiB/s for 64 MiB in a smoke
  run (now 394), so only a body past the cap is gathered.
- **`vm` unchanged**: its column on this branch is within the base's noise in every line (the only `vm` change is the
  body reader's refactor, `readsAhead`).

### 14.5 Tests and sabotage

`packages/sandbox/test/`: `http-parity.test.ts` (103), `http-limits.test.ts` (4) and `streams.test.ts` (+1), §14.3;
four forgeries in `fixtures/children/forge.ts`; the parity tests' in-memory file store moved to `fixtures/blobs.ts`
(shared with `action-parity.test.ts`).

Each break below was applied alone to a copy of the tree on the test VPS, the three files run (120 tests), and the file
restored from a saved copy and compared byte for byte before the next (`bench/process-sandbox/results/pr6-http/
sabotage.py`, its breaks in `breaks.py`, its output in `sabotage.jsonl`). The two guards against a race were run 12
times each on the cases they guard:

| Break | Failing tests |
|---|---|
| The response's stream opened on the host after its head is read, not as the message is read | 1: `streamEmpty` (the child killed: an end for no open stream) |
| The 100 MiB cap counted on the wire's 1 MiB pieces (no mark) | 1: `overCap` |
| The host drops a mark instead of handing the server its over-the-limit chunk | 1: `overCap` |
| No look for a failure in the handler's turn (`failedEarly`) in the child | 3: `chunkString`, `pullThrows`, `streamFailsNow` |
| A chunk that is not bytes sent as it is (no `bodyChunk` check) | 2: `chunkLateNumber`, `chunkLateObject` |
| A multipart body parsed in the child (no `formData` operation) | 1: `formUnawaited` (no warning) |
| The request's `blob()` not typed (`typedBlob`) | 2: `reqBlob`, `storeBody` |
| A body's end and the call's `done` flushed apart | 11 runs of 12 (the cases whose body ends with its last chunk: `stream`, `bodyFetches`, `bodyWrites`, …; chunked where `vm` gives a length) |
| An operation still running when the call's answer named it not kept counted | 4 runs of 12 (`formUnawaited`) |
| The call's timers not cleared at its end | 1: "the call ends with its body" |
| A rejection after the head fails the run, as before it, instead of ending the body | 2: "after the head, it ends the body there", "the call ends with its body" |
| The client's leaving not sent (`disconnect`) | 1: "a client that leaves" |
| A stopped body not cancelled at once (`onStop`) | 1: "a client that leaves" |
| The host accepts a mark for a stream it never opened | 2: `markNoStream`, the streams' mark case |
| The host takes an inline body that is not bytes | 1: `responseNotBytes` |
| An action may send `formData` | 1: `formDataInAction` |
| An action may send a response | 1: `responseForAction` |
| A known-length body's length not given to the server (`withBodyLength`) | 4: `bigBytesTyped`, `bigText`, `formMultipart`, HEAD of 3 MiB of bytes |
| A known-length body past the cap not gathered | 1: `overCapBytes` (100 MiB sent where in-process drops it whole) |
| A small (inline) known-length body not given its length | 3: HEAD of bytes, of text, of `/exact` (no `content-length`) |

Three mechanisms were built and dropped on what the breaks showed (no test failed without them, five clean runs each):
the host's read-ahead that handed on the chunks that came together, the gathering of a stream that ended in the
handler's turn, and a snapshot of what was pending when the response was made. The one flush of a body's end and the
call's `done` made the first two redundant, and keeping a running operation counted the third. One ordering is kept
that no test can see: the child reads the response's headers before its body, as the server does; with the server's
`Response`, whose type is set when it is built (`SpecResponse`), the order no longer changes the headers.

### 14.6 Owner questions

No DV, STUDY or AD number taken (TBD). Each comes as Convex against bunvex, whether it is the same, why not, the app's
impact, and a recommendation.

- **Q-PR6-1. An HTTP action's end, under `vm`.**
  - Convex: the isolate's loop runs until the response's body has been handed over, then closes the task channel and
    shuts the running tasks down (`environment/action/mod.rs:1226-1233`): a timer the action left never fires, a `ctx`
    it kept refuses, as for an action (STUDY-77 §7).
  - bunvex `process`: the same (§14.2: the call ends with its body; its timers cleared, a kept `ctx` refuses with
    "the action has ended: its operations can no longer run").
  - bunvex `vm`: an HTTP action never ends: its leftover timers fire after the response, and a `ctx` kept in module
    state keeps running (STUDY-77 §7.3 left HTTP actions out until this PR).
  - Same: `process` yes; `vm` no.
  - Why: not built yet in `vm` (it can be: the action's life ended when the body has been handed over, as #782 does for
    actions).
  - App impact: under `vm` an HTTP action that leaves a timer (or keeps its `ctx`) writes, schedules or fetches after
    its response; on Convex and under `process` it does not.
  - **Recommendation: make `vm` end an HTTP action with its body, in a PR of its own** (as #782); `http-parity.test.ts`
    states both behaviours today.
- **Q-PR6-2. A `fetch` response returned as it came, under `vm`.**
  - Convex: sent as the HTTP action's response (a proxy route).
  - bunvex `process`: the same.
  - bunvex `vm`: the run fails, a 500 "Uncaught TypeError: Invalid state: ReadableStream is locked". The server reads
    the response's `body` twice (`runHttpAction`: the check for none, then the stream), and a fetched response's
    `body` getter (`actionResponse`, `action-fetch.ts`) wraps the native stream anew at each read, which the first
    read locked.
  - Same: `process` yes; `vm` no.
  - Why: a `vm` bug, not impossible.
  - App impact: `return fetch(url)` from an HTTP action fails under `vm`.
  - **Recommendation: fix `vm` in its own PR** (the wrapper made once per response); `http-parity.test.ts` has the case.
- **Q-PR6-3. A system error in an HTTP action.**
  - Convex: Convex's internal error, a 500 `{"code":"InternalServerError","message":"Your request couldn't be
    completed. Try again later."}` (`local_backend/src/http_actions.rs` `http_any_method`, an `HttpResponseError`;
    `errors/src/lib.rs:1102`).
  - bunvex, both executors: the server's `errorResponse` describes it as an app's error: a 500 whose `code` and `trace`
    carry its message (`Uncaught ExecutorFailure: the function sandbox's process sent a message that is not valid: …`
    under `process`, an engine's system error under `vm`). Under `process` a child that dies or misbehaves during an
    HTTP action reaches it (`http-limits.test.ts`).
  - Same: no.
  - Why: not built yet (`http-actions.ts` does not ask `isSystemError`).
  - App impact: a client sees the server's internal message instead of the generic one (queries, mutations and actions
    already answer the generic one).
  - **Recommendation: answer a system error in an HTTP action with Convex's internal 500, under both executors, in a
    PR of its own.**
- **Q-PR6-4. A router whose `lookup` is its own.**
  - Convex: the isolate calls the app router's own `lookup()` and `runRequest()` (`environment/action/mod.rs:456-503`;
    `router.ts:275-332`): app code.
  - bunvex `vm`: the app router's own `lookup()`, then the matched handler.
  - bunvex `process`: the router's stand-in, an `HttpRouter` made from the routes the child's analysis listed
    (`getRoutes()`), looked up by bunvex's own `lookup`.
  - Same: for `httpRouter()` (and any router whose `lookup` finds what `getRoutes()` lists), yes; for a router that
    overrides `lookup` to route otherwise, no.
  - Why: not built yet. The server routes before it runs anything (the route names the run's log); asking the child
    would be a round trip per request.
  - App impact: an app whose `http.js` exports a router with a `lookup` of its own may get another route, or a 404,
    under `process`.
  - **Recommendation: accept until STUDY-168 PR 9**; then let the child say at analysis whether the router's `lookup`
    is `HttpRouter`'s, and route in the child (one round trip) only when it is not.
- **Q-PR6-5. Framing, when the body's last chunk and its end reach the host apart (DV-483).**
  - Convex: a stream is sent chunked.
  - bunvex `vm`: a stream that ends with its chunk at once goes with its `content-length` (DV-483).
  - bunvex `process`: the same, since the child writes the last chunk, the end and the call's `done` in one write
    (§14.2). Under load, if the host reads them apart, the body goes chunked (Convex's framing).
  - Same as `vm`: in every run measured; as Convex: more often.
  - Why: two processes, and Bun picks the framing as it writes: it cannot be made exact.
  - App impact: none for an app (`fetch` reads the same body); a raw-HTTP client may see `transfer-encoding:
    chunked` where `vm` sends a length.
  - **Recommendation: accept, as a note in DV-483's row.**


Notes, not divergences from Convex: under `process` the host sends a request's body ahead of the handler up to the
credit window (4 MiB), as Convex sends it to the isolate at the run's start, where `vm` reads it as the handler does;
the action timeout covers an HTTP action's handler, not its body's streaming, under both executors (DV-146);
`@bunvex/testing` under `BUNVEX_FUNCTION_SANDBOX=process` fails to start its server (it is not given the executor),
which a test run that sets the variable for its backend meets (`examples/testing`).
