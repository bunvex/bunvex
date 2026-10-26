# STUDY-150 — No server frame or path in what an app sees of an error
<!-- index: No server frame or path in what an app sees of an error: every client and log path audited; a pushed context's `Error.prepareStackTrace` (Convex's frames-only V8 `error.stack`), its context seen through an in-realm wrapper that gives an engine error the app's frames (`performAsyncSyscall`'s `at async`), its own `BunvexError`; checked against the binary | implemented; DV-482 accepted (owner, 2026-10-14) -->

- **Status:** implemented; DV-482 accepted (owner, 2026-10-14)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend; oracle binary
  `precompiled-2026-10-07-d8bdde0`
- **Related:** [STUDY-95](STUDY-95-error-stacks.md) (the app's frames, mapped; this closes its "Gap, for later"),
  [STUDY-20](STUDY-20-function-errors-and-logs.md) (redaction, system errors), [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md)
  N2 (a nested call's display), STUDY-149 PR 3 (#632), whose oracle found it, #628 (DV-501), #623.

## 1. How Convex does it

**Where an error's frames come from.**

- `npm-packages/udf-runtime/src/errors.ts:20-50` `setupSourceMapping` installs `Error.prepareStackTrace` in the
  isolate. On the first read of `error.stack`, it records V8's call sites as `FrameData`, stores them on the error
  (`__frameData`), and asks the `error/stack` op for the text.
  - `crates/isolate/src/ops/errors.rs:70-78` `op_error_stack` → `crates/isolate/src/error.rs:106-117`
    `source_mapped_stack` → `JsError::from_frames` with an empty message.
  - The returned text is the frames only, `trimEnd`ed. A V8 function's `error.stack` therefore has **no
    `Error: <message>` header**. The oracle confirms it: `"stack": "    at async patchCreationTime [as
    patchCreationTime] (../convex/frames.ts:8:21)\n    at async handler (../convex/frames.ts:48:4)"`.
- `crates/common/src/errors.rs:694-772` `JsError::from_frames` maps each frame through its module's source map.
  - It drops a frame with no source map (`lookup_source_map` → `None` → `continue`) or no URL.
  - It trims leading and trailing harness frames: `is_omittable_internal_frame`, l. 506-511, matches files
    containing `udf-runtime/src` or `convex/src/server/impl`.
  - System UDFs are modules with source maps too (`crates/isolate/src/execution_scope.rs:530-540`,
    `system_udf_file`). Every JS frame left is the app's bundle or a system function's source. A Rust frame never
    is one: the engine is not JavaScript.
- `crates/isolate/src/error.rs:31-61` `format_traceback` builds an uncaught error the same way.
  `crates/isolate/src/helpers.rs:210-220` `format_uncaught_error` makes `Uncaught <Name>: <message>`, and
  `JsError`'s `Display` (`errors.rs:826-842`) puts the frames after the message.

**An error the engine raises.**

- A syscall's failure reaches the app through its bundled library.
  - `npm-packages/convex/src/server/impl/syscall.ts:28-55` `performAsyncSyscall` awaits `Convex.asyncSyscall` and
    rethrows `new Error(e.message)`, or `new ConvexError(e.message)` with `data`, **in the app's code**. The comment
    there reads: "Rethrow the exception to attach stack trace starting from here".
  - The frames are therefore the app's, where it awaited the call, for example `at async patchCreationTime
    (../convex/frames.ts:8:21)`. The library's leading frames (`syscall.ts`, `database_impl.ts`) are harness frames
    and are trimmed.
  - A synchronous syscall (`performSyscall`, l. 17-26) or a check in the library throws inside the app's call, so
    its frames are synchronous (`at systemTable (…)`).
- What the client gets is `crates/application/src/redaction.rs:160-170`: `[Request ID: …] Server Error`, then
  the `JsError` display. With `--redact-logs-to-client`, only `Server Error`.
  - An HTTP action's 500 is `{code, trace}` (l. 140-158).
- A failure that is not the function's (not a `JsError`) reaches the client as
  `INTERNAL_SERVER_ERROR_MSG`, "Your request couldn't be completed. Try again later."
  (`crates/errors/src/lib.rs:989-993` `user_facing_message`, l. 1102). Its details and stack go only to the
  backend's own logs (`report_error`), never to the function log or the client.
- The function log, which the CLI and the dashboard stream, records the same `JsError` the client gets, not
  redacted. Its `console` lines are what the app printed.
  - In V8, `console.log(e)` prints `[Error: <message>]`, without the stack. `console.log(e.stack)` prints the
    mapped frames.

**A `"use node"` action.**

- `npm-packages/node-executor/src/errors.ts:54-108` `registerPrepareStackTrace` keeps Node's shape.
  - The header is always `Error` plus `: <message>` when there is one (`extractErrorMessage`), whatever the class.
  - Then come **all** of V8's frames, unmapped. A file under the modules directory is renamed `convex:/user/…`,
    so no local path appears. The executor's own frames (`bundledFunctions.js`, `node:internal/…`) stay.
  - Oracle: `Error: Could not find public function for 'nope:x'.\n\n    at performAsyncSyscall
    (convex:/user/node.js:1036:11)\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n
    at async runQuery (convex:/user/node.js:1108:15) …`.
  - Node's `util.inspect` prints that stack for `console.log(e)`.
- An uncaught Node error is mapped in Rust from its `__frameData` (`executor.ts:160`, `:450`), as V8's is.

## 2. What an app can observe

- The client's error (`errorMessage` over HTTP and sync, an HTTP action's `trace`, a scheduled job's
  `state.error`, a cron's status, the log stream's `error`) shows the app's frames only. For a failed syscall,
  those are the frames where the app awaited it.
- `error.stack`, read by the app and then returned, written or logged, shows the same frames.
  - In V8 it has no header.
  - In Node it is `Error: <message>` and frames.
- No path of the server's installation appears anywhere, and no frame of its runtime.

## 3. How bunvex does it

### 3.1 What leaked, classified

These are the paths that turn a thrown error into something a client or a log reader sees. They were probed with
pushed code (`deployCode`) on the #628 branch, for 9 engine errors and 3 app-made ones, from a mutation, a V8 action
and a Node action. Each error was left uncaught, caught and returned as `e.stack`, and caught and logged.

| # | Class | Path | Before #628 | After #628 | Now |
|---|---|---|---|---|---|
| A | Server frames attached to an engine-thrown error, in the client's message | `describeUncaught` → `mapStack`: `/api/query\|mutation\|action\|run`, sync, the HTTP action's `trace`, a scheduled job's and a cron's error, the log stream's `error`, log sinks' `Exception` frames (`log-events.ts` `stackFrames`), a failed push | leaked when no frame of pushed code was on the stack (a system function's, the PR 3 case `db.patch` of `_creationTime` through `_system/frontend/patchDocumentsFields`) | fixed (#628: `stack-map.ts` drops the server's frames from any stack) | fixed |
| B | An engine-thrown error carrying its own server stack, read by the app | `e.stack` of an error from `ctx.db.*`, `ctx.scheduler.*`, `ctx.storage.*`, `ctx.run*`: returned, logged (`console.error(e.stack)`; in Node `console.log(e)` too, through `util.inspect`) and streamed to the CLI and dashboard | leaked: `/…/packages/core/src/tx.ts`, `packages/server/src/functions.ts`, `node:async_hooks`, `processTicksAndRejections` | leaked | fixed (§3.2) |
| C | An app-made error's raw stack | `e.stack` of `new Error()` / a `TypeError` in pushed code: unmapped `bunvex:/v1/m.js` frames, and the server's frames below the handler when thrown before its first `await` (STUDY-95's gap) | leaked | leaked | fixed (§3.2) |
| D | An app-made `BunvexError`'s stack | a class of the server's realm, which formats its stack, with the same frames as C | leaked | leaked | fixed (§3.2) |
| E | No app frame on a failed async syscall, in the client's message (parity, not a leak) | `db.patch`, `db.replace`, the scheduler, a nested call: the error was raised after an `await` in the server's realm, and JavaScriptCore follows `await`s within one realm only | no frame | no frame | `at async …`, as Convex's |
| F | System errors (committer stopped, persistence read, out of retention, indexes unavailable) | `isSystemError` | the fixed message to the client; the details only in the server's log | same | same, and their stacks are left as they are for the operator |

### 3.2 The fix

All of it is in `packages/server/src/app-errors.ts`, installed per pushed context next to `installNestedCalls`.

- **The app's own errors (C).** Each context gets an `Error.prepareStackTrace`, as Convex's
  `setupSourceMapping`.
  - Bun calls it lazily, on the first read of `stack`, so it costs nothing on the success path. It is per realm,
    which was checked in a vm context.
  - It renders the call sites as `    at [async ]<site>`, runs them through `mapStack` (the app's frames mapped,
    every other frame dropped), and returns:
    - in V8, the frames alone (Convex's format);
    - in Node, `Error: <message>` and the frames.
- **The engine's errors (B, E).** The context a pushed function gets is a view of the server's: the same members,
  with every method called through an in-realm wrapper. A server object a method returns is seen through a view too:
  a query builder, `db.system`, an async iterator.
  - When the call throws or its promise rejects, the wrapper takes the frames for the server's error at that point.
    It keeps the error itself, so its class, `data`, codes and `instanceof` checks are unchanged.
    - If the error was thrown before the call returned, its stack already holds the app's frames (Convex's
      synchronous checks show these), and those frames are mapped.
    - Otherwise the frames are those of an error made in the app's realm where the app awaited the call. This is
      Convex's `performAsyncSyscall`, and it gives `at async …`.
  - System errors are passed through untouched.
  - The wrapper awaits the server's promise through its own realm's `Promise.prototype.then`. Awaiting a
    foreign-realm promise costs an extra thenable job, so this halves the hop's cost (§3.3).
- **`BunvexError` (D).** A pushed context's `bunvex/values` exports a `BunvexError` of the context's realm, a
  subclass of the server's.
  - Its stack is formatted as the app's other errors are.
  - The server still recognises it, by its brand (`isBunvexError`).
  - Its `Symbol.hasInstance` makes any `BunvexError`, the engine's included (a nested call's), an instance of it.
    A subclass the app declares keeps ordinary `instanceof`.
- `errors.ts` `stackAfterMessage` accepts a stack whose first line names another class: Node's is always
  `Error: …`. Without this, a multi-line message (a nested call's display) would be read as frames.

Functions registered in-process (`Functions.register`, `@bunvex/testing`) get the server's context as before. Their
frames are the developer's own, and #628 already drops the server's frames from their client errors.

### 3.3 Cost

The wrapper adds one in-realm `async` hop per syscall on the success path. An `async` function is required: an error
made in a `.then` handler gets no `at async` frames (checked).

Measurement: a pushed function over HTTP, A/B interleaved in one process (12 calls per batch, 40 batches, the first 4
discarded), three short runs, medians. The owner accepted this cost (2026-10-14: A).

| Workload | Without the view | With it | Cost |
|---|---|---|---|
| A mutation of 1000 sequential `db.get` | 3.05–3.21 ms | 3.12–3.31 ms | +1.6% to +5.5% (about +3%) |
| A query that iterates 1000 documents (`for await`) | 1.07–1.18 ms | 1.14–1.22 ms | +3.5% to +6.8% (about +5–6%) |

A first version, which awaited the server's promise directly, cost +8% to +11%.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-482 | A `"use node"` action's `error.stack` is `Error: <message>`, then the app's frames **mapped to its sources** (`../bunvex/n.ts:12:5`), with none of the runtime's. Convex's is `Error: <message>`, then every frame **unmapped** (`convex:/user/node.js:1036:11`), its executor's included (`performAsyncSyscall`, `bundledFunctions.js`, `node:internal/…`) | bunvex's runtime is the server: its frames would expose the server's paths (as DV-501). Showing unmapped bundle positions (`bunvex:/user/n.js:L:C`) is possible but would show positions nobody can read; Convex maps the uncaught error but not `e.stack` only because its executor cannot | **accepted** (owner, 2026-10-14); **amended** (owner, 2026-10-25, STUDY-188 Q2; built in #PRNUM): Node's own frames (`node:https`, `node:_http_client`, …) are kept among the app's, as Convex's executor keeps them for proxy-agents (agent-base reads `node:https:` in a stack); no server path, and none past the app's outermost frame |

Not divergences:

- V8's `error.stack` with no header is Convex's.
- `at async` where the app awaited a failed syscall is Convex's.
- A frame's function name (DV-345) and position (DV-346) are already decided.
- A system function's error shows no frame. Convex shows its system function's own (`at async Promise.all (index 0)`
  for `patchDocumentsFields`). bunvex's system functions are not pushed code, the same reason as DV-501.

## 5. Tests

- `packages/server/test/engine-error-frames.test.ts`, through `deployCode`:
  - **The guard.** For 15 mutation cases and 5 action cases from V8 and Node, each left uncaught, caught and
    returned as `e.stack`, and caught and logged, nothing contains the repository's path, `packages/core|server|values/`,
    `node_modules/`, `bunvex-runtime:`, `bunvex:/vN`, `(node:`, `(native` or `processTicksAndRejections`.
    - The mutation cases are the `_creationTime` patch, the `_id` replace, a bad table name, a non-object, a system
      table, a bad id, a bad index, a bad range field, a `$` field, a bad `paginate`, a missing scheduled function, a
      bad storage id, and app-made `Error`, `TypeError` and `BunvexError`.
    - The action cases are a missing function, a nested call that throws, a missing scheduled function, and app-made
      `Error` and `BunvexError`.
    - The same check covers the HTTP action's 500 for a nested failure and for a failed schedule, a scheduled job's
      `state.error`, and the log stream (`stream_function_logs`).
  - **Uncaught.** `at async` frames where a failed `db.patch` or `scheduler.runAfter` was awaited, and synchronous
    frames for a check made before the call returned (a system table).
  - **Caught.** V8's `e.stack` is the frames alone, the engine's, the app's and an app's `BunvexError` alike. Node's is
    `Error: <message>` plus the frames.
  - **The context still behaves as the server's.**
    - `for await` over a query, `paginate`, `withIndex` with a range, `filter().first()` and `db.system` all work.
    - A subclass of `BunvexError` is `instanceof` both classes, keeping its `data`.
    - A nested call's `BunvexError` (made by the server) is the app's `BunvexError`, in V8 and in Node.
- `packages/differential/test/error-frames.test.ts`, against the oracle (the app of `error-frames-app/`):
  - the client's frames match Convex's for 10 runs: 6 mutation cases, and 2 V8 and 2 Node action cases;
  - V8's caught `e.stack` matches, and has no header;
  - a Node `e.stack` starts with `Error: <message>` on both;
  - nothing bunvex answers holds a server frame or path.
  - Rewrites: frame names (DV-345), positions (DV-346), the directory (DV-03), and Convex's library frames (DV-501).
  - The cases listed in §6 are skipped.
- Existing tests still pass: `value-error-frames`, `stack-map`, `action-nested-error-frames`, and the differential
  `nested-errors` and `value-errors`.

**Sabotage.** Each one was applied alone and restored; `git diff` was checked clean after each.

| Sabotage | Caught by |
|---|---|
| No `Error.prepareStackTrace` in the context | the guard, and the caught-stack test |
| No view of the context (`appContext` returns `ctx`) | the guard, uncaught, caught (3 of 4); all 4 oracle tests |
| Always the await's frames (ignore the error's own) | uncaught (the system table's synchronous frames) |
| No context `BunvexError` (`appNamespace` returns the server's) | the guard, and the caught-stack test |
| No Node header | the caught-stack test |
| A method's returned builder not seen through a view | the guard (`badIndex`, `badRange`) |

## 6. Open questions

- **DV-482** (above): accepted by the owner, 2026-10-14.
- **Found, not changed here.** These are not leaks; they are message and frame differences of their own.
  - A bad id fails before `db.get` awaits on bunvex (synchronous frames). Convex parses it in its async syscall
    (`at async`).
  - A missing function in `ctx.runQuery` has different wording and frames:
    - bunvex says `Could not find public function for 'nope:x'.` with no frame;
    - Convex's V8 says `Couldn't resolve api.nope.x` with the app's frames;
    - Convex's Node keeps the callee display and a blank line.
  - A missing scheduled function from an action is worded differently: Convex's V8 says `Couldn't resolve
    api.nope.x`, and its Node says `Invalid schedule request: {"code":"InvalidScheduledFunction",…}`.
  - `db.patch` of `_creationTime` displays the patch (STUDY-149 PR 3, item 4).
  - An error the server raises, or a `BunvexError`, is not `instanceof Error` of the app's realm. This is a
    cross-realm difference that predates this study.
- **Not fixed: errors from server-realm code a Node action calls directly.** These are a builtin (`node:fs`) or an
  external package, which bunvex imports in the server's realm (DV-169, STUDY-148).
  - Their `e.stack` keeps `node:` frames, as Convex's does, and an external package's frames under the deployment's
    `node_modules`, an absolute path where Convex shows `convex:/user/…`.
  - The client's uncaught error is clean (`mapStack`). Fixing `e.stack` needs a server-realm hook and is left for a
    follow-up.
