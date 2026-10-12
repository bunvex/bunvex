# STUDY-143 — The unawaited-operations warning

- **Status:** implemented; no new divergence (the docs link is DV-04's).
- **Convex source read:** `crates/isolate/src/environment/action/{mod.rs,task.rs,async_syscall.rs,task_executor.rs}`,
  `crates/isolate/src/ops/mod.rs`, `npm-packages/udf-runtime/src/{21_formdata.ts,storage.ts,26_fetch.ts}` in the local
  clone (`4577b90`; none of them changed in `4577b90..d8bdde0`, STUDY-137), and `convex` 1.46.0's
  `dist/esm/server/impl/*` for the syscalls an action's API makes. Checked against the binary
  `precompiled-2026-10-07-d8bdde0`.
- **Related:** [STUDY-76](STUDY-76-limit-warnings.md) (the warnings, built with this one),
  [STUDY-77](STUDY-77-action-timeout.md) A3 (the timeout), DV-04 (no docs link).

## 1. How Convex does it

- `add_warnings_to_log_lines` (`action/mod.rs:1283-1315`), called by `add_warnings_to_log_lines_action` (`:1228`,
  after the run at `:740`: on success, on the app's error, on a timeout) and by
  `add_warnings_to_log_lines_http_action` (`:1263`, once the response's body was sent):
  - `dangling_task_counts` (`:1317-1330`) counts the entries of `task_promise_resolvers` — every task started
    with `start_task` whose answer JS has not received — except sleeps, by `name_when_dangling`, in a
    `BTreeMap` (sorted by byte, deduplicated with their counts summed);
  - the line: `{n} unawaited operation{s}: [{names joined by ", "}]. Async operations should be awaited or they
    might not run. See https://docs.convex.dev/functions/actions#dangling-promises for more information.`, `s`
    unless `n` is 1;
  - a `SystemWarning` at `WARN`, `system_log_metadata.code` `UnawaitedOperations`; the metric
    `log_unawaited_pending_op(n, "action")`.
  - Its order among the warnings: the action's arguments size, this, the duration, the result size (STUDY-76).
- **What counts** (`task.rs:91-111`, `name_when_dangling`):
  - async syscalls, named by `syscall_display_name` (drop `1.0/`, `actions/`, `httpEndpoint/`; `shallowMerge` →
    `patch`, `queryPage` → `paginate`). An action's are (`async_syscall.rs:68-96`): `query`, `mutation`,
    `action`, `schedule`, `cancel_job`, `vectorSearch`, `getUserIdentity`, `storageGetUrl`,
    `storageGetMetadata`, `storageGenerateUploadUrl`, `storageDelete`, `getFunctionMetadata`,
    `getDeploymentMetadata`, `getRequestMetadata` (`ctx.meta`), `createFunctionHandle`, `auditLog`
    (`log.audit`, refused in actions: "Audit logging is not yet supported in actions"), `createServiceToken`,
    `getServiceUrl` (Convex's managed services);
  - async ops: `fetch`, `formData` (`form/parseMultiPart`: `formData()` of a `multipart/form-data` body only;
    a urlencoded one is parsed in JS, `21_formdata.ts:125-160`), `storage.store`, `storage.get`;
  - not: `setTimeout` (`Sleep`, filtered out), `ReadableStream` (`SendStream` is started by `send_stream`
    without a resolver, `mod.rs:667-684`, so it never appears), a response body's reads (`stream/readPart`,
    not a task).
- **When an operation stops counting:** its answer comes from the task executor and is handled by the action's
  loop (`run_action_inner`, `:1100-1215`) *between* turns of JS — never in the turn that started it. When the
  handler's promise is fulfilled the loop collects the result and ends without handling answers still in the
  channel: a call left unawaited when the action returns is listed even if it was instant
  (`getUserIdentity`). An HTTP action keeps handling answers while its body streams, so a call that answers
  meanwhile is not listed.

## 2. What an app can observe

The `[WARN]` line in the action's log lines (the HTTP API's `logLines`, the client's console, the function log,
log streams with `system_code` `UnawaitedOperations`). Measured on the binary:

| Action | Convex |
|---|---|
| `void fetch(slow)` | `1 unawaited operation: [fetch]` |
| two fetches and a `runQuery` | `3 unawaited operations: [fetch, query]` |
| `runAction`, `runAfter`, `storage.getUrl`, `generateUploadUrl`, `getUserIdentity` | `5 …: [action, getUserIdentity, schedule, storageGenerateUploadUrl, storageGetUrl]` |
| the three `ctx.meta` calls, `createFunctionHandle` | `4 …: [createFunctionHandle, getDeploymentMetadata, getFunctionMetadata, getRequestMetadata]` |
| `storage.store` | `1 …: [storage.store]` |
| a timer | none |
| timed out (3 s) with a slow fetch and a 0.3 s `runAction` | `1 …: [fetch]` (the action had answered) |
| HTTP: `formData()` of a multipart body; a `runQuery` | `[formData]`; `[query]` |
| HTTP: a `runQuery` answered while a 250 ms body streams | none |

## 3. How bunvex does it

STUDY-76 built the line (`limit-warnings.ts`, `unawaitedWarning`: the text without the link, DV-04; the code;
the order) and counted `ctx`'s calls (`functions.ts`, `trackedCtx`) and `fetch` (the fetch meter). This study
matches what it lists:

- **The turn an answer is handed over** (`functions.ts`, `tracked`): an operation whose promise settles in the
  turn of the event loop it started in (a call that answers within microtasks) is handed to the app in the next
  turn (one `setImmediate`), as Convex's tasks are; until then it is pending. An action that returns without
  awaiting `getUserIdentity()` lists it; one that awaited it does not; one answered while the action waited, or
  while an HTTP action's body streamed, does not. A turn is counted lazily (one `setImmediate` per turn that
  starts an operation).
- **More operations:** `ctx.meta`'s three calls (`trackedCtx`); `createFunctionHandle` and `log.audit`
  (`auditLog`), module functions, through a tracker the server sets (`pending-ops.ts`); `formData()` of an HTTP
  action's request when the body is `multipart/form-data` (`trackedFormData`).
- Not built because bunvex has none: `createServiceToken`, `getServiceUrl`. `ReadableStream` never appears in
  Convex; `storage.get`, `storage.store` and the other names were already there.
- A timed-out action already listed what was pending at the timeout (the warning runs in its `catch`); the
  differential test now checks it against the binary.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| — | No link to Convex's docs at the end of the line | DV-04 | decided (DV-04) |

No new one. An answer handed over one turn later costs about 1 µs per awaited call that answers within
microtasks (below); no app can tell apart beyond that.

## 5. Tests

- `packages/differential/test/unawaited-operations.test.ts` (against Convex's binary, local only; app
  `packages/differential/unawaited-app/`): every row of §2, an action that awaited everything (none), one whose
  calls answered while it waited (none), the timeout (`V8_ACTION_USER_TIMEOUT_SECS=3` on both, through the
  harness's new `env` option), HTTP actions read from `/api/stream_function_logs`.
- `packages/server/test/unawaited-operations.test.ts`: the same cases in process, `log.audit`'s `auditLog`, an
  action that is not an async function, a urlencoded form (not counted), the `system_code`.
- Existing: `limit-warnings.test.ts` (the order of the four warnings), `function-handles.test.ts`,
  `action-timeout.test.ts`.

### Sabotage

Each break made at least one test fail (restored; `git diff` clean):

| Break | Failing |
|---|---|
| S1 `ctx.meta` not tracked | 1 |
| S2 answers handed over in the same turn (STUDY-76's behaviour) | 2 |
| S3 every answer handed over 50 ms late | 1 (`later`) |
| S4 a multipart `formData()` not tracked | 1 |
| S5 no tracker for `createFunctionHandle` / `log.audit` | 1 |
| S6 every form tracked (urlencoded too) | 1 |

### Measurements

An action awaiting `ctx` calls in a loop (in process, memory persistence; scratch script, 100 000 and 20 000
calls), main → this branch:

| | main | branch |
|---|---|---|
| `await ctx.auth.getUserIdentity()` | 0.18 µs | 1.27 µs |
| `await ctx.runQuery(…)` (answers within microtasks here) | 3.4 µs | 5.0 µs |

About +1.1–1.6 µs per awaited call that answers in its own turn (one `setImmediate`); a call that waits on I/O
pays nothing. Convex pays a loop round-trip on every call.

## 6. Open questions

None. Seen on the way, not changed here: Convex's function log has no entry for a `runQuery` an HTTP action left
unawaited (the run ends before it answers); bunvex runs it to the end and logs it.
