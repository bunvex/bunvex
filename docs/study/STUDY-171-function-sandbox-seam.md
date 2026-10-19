# STUDY-171 — The function executor seam and its knobs (STUDY-168 PR 1)

- **Status:** implemented (this PR); AD-44 accepted (owner, 2026-10-19)
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

None for this PR. The next ones are STUDY-168's (§9 Q3–Q11 and PR 2 onwards).
