# STUDY-65 — What Convex tests in the application, the clients and the CLI, and what bunvex covers

- **Status:** draft (inventory done; F1–F4 fixed in #277, #278, #279, #281; F6 in #331; client tests in #282)
- **Convex source read:** the last snapshots with tests, `bea52bde0` (Rust, 2026-04-09) and `c358201e1`
  (TypeScript, 2026-04-08), compared with the current source (`4577b9031`) where they differ
- **Related:** [TEST-01](../specs/TEST-01-test-strategy.md) §3 (the first round: values, database,
  persistence), [STUDY-57](STUDY-57-linearizability-testing.md) (sync and OCC guarantees),
  [STUDY-37](STUDY-37-cli-and-environment-variables.md), [STUDY-30](STUDY-30-scheduler-and-crons.md),
  [STUDY-49](STUDY-49-canonical-urls.md), [STUDY-26](STUDY-26-sync-client.md), [STUDY-27](STUDY-27-auth.md)

Convex removed its tests from the open repository in April 2026. TEST-01 §3 and STUDY-57 mapped the
value, database, persistence and sync tests. This study maps the rest that applies to bunvex:
- `crates/application/src/tests` (122 tests in 18 files; `occ_retries`, `mutation` and `query_cache`
  were mapped by STUDY-57);
- the React, browser and Next.js client tests (`npm-packages/convex/src/{react,browser,nextjs}`, 19 files);
- the CLI tests (`npm-packages/convex/src/cli`, 31 files).

It records **what** each test asserts, the bunvex test that covers the same behaviour, or why none does.
No Convex test code is copied: bunvex's tests are written from the behaviour.

Status values: **covered** (cite), **partial**, **gap** (bunvex has the feature, no test pins it),
**n/a** (the feature is absent or out of scope; the parity row or DV is cited), **bug** (a test exposed a
mismatch; the fix PR is cited).

## 1. Bugs found

Each was confirmed with a failing test before the fix. Each fix is its own PR off `main`, with the test,
a sabotage check, and its parity or study rows.

| # | Convex test | What bunvex did | Effect | Fix |
|---|---|---|---|---|
| F1 | `cli/lib/formatEnvValueForDotfile.test.ts` (values that round-trip through dotenv) | `parseEnvFile` read `.env` line by line: a multi-line quoted value came back as its first line with a stray quote, `\n` stayed literal in double quotes, an unquoted `#` did not start a comment, and backticks, `KEY: value` and `.`/`-` in names were not read | `bunvex env list > f; bunvex env set --from-file f --force` silently corrupted multi-line values (PEM keys). Differential run against dotenv 16.4: 17 158 of 200 000 random inputs differed; 0 after the fix | #277 |
| F2 | `application/tests/environment_variables.rs` `test_env_variable_delete_and_create` | the update batch refused a name that appears twice (`EnvVarNameNotUnique`). Convex sorts the batch (removals first, then sets by name and value) and checks no uniqueness | the dashboard's own rename (`A→B` with `B` deleted in the same save) or a swap of two names failed with 400; audit events were in request order, not apply order | #278 |
| F3 | `application/tests/auth_config.rs` `test_evaluate_auth_config_has_custom_system_env_var` | an environment-variable update re-evaluated `auth.config` with the raw built-ins, without the canonical URL overrides that a push, a restart and a canonical-URL change apply | with a canonical site URL and `domain: process.env.BUNVEX_SITE_URL`, changing **any** variable reinstalled the provider with the raw origin, and the issuer's tokens were refused until the next push or restart | #279 |
| F4 | `application/tests/scheduled_jobs.rs` `test_cancel_recursively_scheduled_job` | "born canceled" only looked at the job of the function that scheduled; the mutations and actions a scheduled action calls (`ctx.runMutation`, `ctx.runAction`) ran without it. Convex propagates `parent_scheduled_job` down the call tree | the common "action → runMutation(schedule the next step)" loop kept running after the job was canceled | #281 |
| F5 | `react/use_paginated_query.test.tsx` (the reset path), `ConvexReactClient.logger` | `BunvexReactClient.logger` returned the raw option (`Logger \| boolean \| undefined`), and the paginated hooks warned with `console.warn` | `logger: false` did not silence the pagination reset warning, and a custom logger never got it | #340 (DV-322, option (a) decided by the owner, 2026-10-04): `BunvexReactClient` builds its `Logger` as Convex's (`instantiateDefaultLogger` / `instantiateNoopLogger`, now exported `@internal` from `@bunvex/client`), and the paginated hooks warn through `client.logger` |
| F7 | `returns_validation.rs` (found while writing its tests: Convex's `runUdf` / action calls return `jsonToConvex(result)`) | a nested `ctx.runQuery` / `runMutation` / `runAction` returned the callee's own value | the caller got `undefined` where Convex gives `null`, shared the callee's objects, kept `undefined` fields and the callee's field order, and a non-value (a `Date`) went through | #345 |
| F6 | `cron_jobs.rs` `test_cron_jobs_race_condition` (an executor handed a cron deleted after it picked it) | `CronJobExecutor.execute` looked the function up before checking the cron; a missing function was a system error, retried without end | a push that removed a cron and its function while the executor held the cron: "Cron trying to execute missing function" logged every 15 s, forever, and one of the 8 run slots never freed. Convex's `run_function` checks the job first and drops it | #331 |

## 2. `crates/application/src/tests`

bunvex paths are relative to `packages/`. Convex file names are relative to `crates/application/src/tests/`.

### 2.1 Covered or n/a, compactly

| Convex file | Tests | bunvex |
|---|---|---|
| `airbyte_import.rs`, `fivetran_import.rs` (17) | streaming import | n/a: [platform §19](../parity/platform.md) "Streaming import … missing" |
| `components.rs` (20) | calls into components, env vars per component, unmount, delete | n/a: no components (DV-55, STUDY-62 K1–K9). The depth limit's root analog is covered: `server/test/nested-calls.test.ts` "the depth limit: 8 nested levels…" |
| `indexes.rs` (5) | `_add_system_indexes`, primary-key readiness | n/a (streaming import, platform §19); the general backfill is in `core/test/index-backfill.test.ts` |
| `http_action.rs`, component mounts (19) | `httpPrefix` mounts, child and grandchild routing | n/a: platform §8 "Component HTTP mounts … missing" |
| `streaming_export.rs` `test_streaming_export_from_component` | component tables in `list_snapshot` | n/a (components); the root is covered by `server/test/streaming-export.test.ts` |
| `analyze.rs` `test_analyze`, `test_analyze_crons` | the push's per-module analysis; a cron to a missing function | `server/test/code-version.test.ts` |
| `auth.rs` `test_auth_with_invalid_admin_key` | a bad admin key is refused | `server/test/admin-keys.test.ts`, `admin-access.test.ts` |
| `environment_variables.rs` limits, built-in names | count limit, built-ins refused | `core/test/environment-variables.test.ts` (512 and 512 KiB, as current Convex; the test snapshot still has 1000) |
| `http_action.rs` basic, error, not found, catch-all, auth identity | | `server/test/http-actions.test.ts`, `router.test.ts` |
| `logging.rs` `test_udf_logs` | a sink gets the console line, then the execution | `server/test/log-sinks.test.ts` |
| `push.rs` `test_push_with_unchanged_modules` | only changed modules are sent | `server/test/push.test.ts` "a second push sends only what changed…" |
| `push.rs` `test_change_node_version` | `nodeVersion` stored | n/a: DV-87, platform `node.nodeVersion` missing |
| `returns_validation.rs` query output, valid outputs | | `server/test/functions.test.ts`, `nested-calls.test.ts` |
| `scheduled_jobs.rs` success, canceled, garbage collection, pause, OCC retry | | `server/test/scheduler.test.ts`, `pause-deployment.test.ts` |
| `scheduled_jobs.rs` inline args, delete the jobs table, write-throughput limit | | n/a: bunvex never wrote inline args; `delete_scheduled_jobs_table` is not built ([divergences](../parity/divergences.md)); no write-throughput limit |
| `schema.rs` (4) | `_creationTime` appended; `_id`, `_creationTime`, system fields refused in indexes | `core/test/index-range.test.ts` (see M1 in §5) |
| `source_package.rs` | upload and download of the source package | `server/test/code-store.test.ts` (the source map's round trip is not asserted) |
| `storage.rs` `test_backend_not_running_cannot_store_file` | | `server/test/pause-deployment.test.ts` (paused; the disabled state is not tested) |
| `cron_jobs.rs` success, paused | | `server/test/cron.test.ts` |

### 2.2 Bugs and gaps

| Convex test | Behaviour | bunvex | Status |
|---|---|---|---|
| `environment_variables.rs` `test_env_variable_delete_and_create` | removing and setting one name in one batch succeeds; the set wins | `core/src/environment-variables.ts` refused it | **bug F2** (#278) |
| `environment_variables.rs` `test_env_variable_uniqueness` | the *create* API refuses an existing name | bunvex has only the update batch | n/a |
| `auth_config.rs` `test_evaluate_auth_config_has_system_env_var` | `auth.config` sees the built-in site URL | — | gap (closed by #279's test) |
| `auth_config.rs` `test_evaluate_auth_config_has_custom_system_env_var` | the canonical URL overrides the built-in in `auth.config` | only push and restart applied it | **bug F3** (#279) |
| `scheduled_jobs.rs` `test_cancel_recursively_scheduled_job` | what a canceled job's callees schedule is born canceled | only the job's own `ctx.scheduler` | **bug F4** (#281) |
| `scheduled_jobs.rs` `test_scheduled_jobs_race_condition`, `cron_jobs.rs` `test_cron_jobs_race_condition` | a job canceled (a cron deleted) after the executor picked it is not run | `unchanged()` in `server/src/scheduler.ts` and `cron-executor.ts`; also a cancel or delete while the mutation runs | covered (G-A6): `server/test/executor-races.test.ts` (#330) |
| `scheduled_jobs.rs` `test_disable_scheduled_jobs`, `cron_jobs.rs` `test_disable_cron_jobs` | a *disabled* backend runs no jobs or crons, then resumes | `server/test/disabled-deployment.test.ts`: a disabled or suspended system and a usage limit, for jobs and crons | covered (G-A7, #346) |
| `cron_jobs.rs` `test_cron_occ_gets_logged`, `scheduled_jobs.rs` OCC logging | a lost OCC attempt of a cron or scheduled mutation is in the function log | `server/test/executor-occ-log.test.ts`: the lost attempt (`occInfo`, `willRetry`), then the winner, for the Scheduler and the Cron | covered (G-A8, #349) |
| `storage.rs` `test_storage_get_url`, `test_storage_generate_upload_url` | user `getUrl` (query, action) and `generateUploadUrl` (mutation, action) follow the canonical cloud URL | `server/test/storage.test.ts`: all four, the site URL ignored, unset, and a subscribed `getUrl` re-run on a change | covered (G-A4, #333) |
| `storage.rs` `test_storage_api_bandwidth_log_events` | one bandwidth event per download, with the bytes actually streamed | the event is never emitted; egress counts `content-length` | n/a (DV-309 covers metering) — M3 |
| `returns_validation.rs` `test_action_bad_output`, `test_mutation_extra_fields` | an action's bad return, an extra field in a returned object | `server/test/returns-validation.test.ts` (the 7 cases, as Convex's file) | covered (G-A10, #344) |
| `http_action.rs` disconnect before head / while streaming / continues after | the action finishes and its writes commit; the log records the disconnect | `server/test/http-action-disconnect.test.ts`: continues after, writes commit, and before the head the Completion fails with "Client disconnected" (#350). While streaming (an `[INFO] Client disconnected` line, the Completion after the body) is not done: bunvex logs the Completion when the handler returns | partial (G-A11), M4 |
| `push.rs` `test_max_size_push` | 4096 modules + 4096 `_deps`, pushed twice | `server/test/push.test.ts` (about 0.3 s, then 0.7 s); M2 fixed with it | covered (G-A9, #348) |
| `analyze.rs` `test_analyze_with_source_map` | each function's source line | `AnalyzedFunction` has no `pos` | gap, M5 (dashboard only) |
| components.rs `test_component_status_skips_staged_index` | the schema status counts no staged index | `core/src/engine.ts` | gap (G-A5), cosmetic |

## 3. React, browser and Next.js client tests

bunvex's client follows Convex's closely: the auth state machine, `LocalSyncState`, `RequestManager`,
optimistic replay, `QueriesObserver`, both pagination paths, `insertAt*`, the HTTP client and hydration.
Reading each gap against both implementations found no client logic bug beyond F5. Most of Convex's
`auth_websocket.test.tsx` is `describe.skip` upstream (flaky); only its `expectAuth` cases run there.

Short paths: `client/` = `packages/client/test/`, `e2e/` = `packages/sync-e2e/test/`, `e2e-react/` =
`packages/sync-e2e/react/`.

| Convex file | Covered | Gaps |
|---|---|---|
| `react/ConvexAuthState.test.tsx` | loading → authenticated (`e2e-react/auth.test.tsx`); refetch at exp − iat − leeway (`e2e/client-auth.test.ts`) | G-C1: a non-JWT token logs and schedules nothing |
| `react/auth_helpers.test.tsx` | `<Authenticated>` etc. (`e2e-react/auth.test.tsx`) | — |
| `react/auth_websocket.test.tsx` | valid token, refused cached token, always refused, null token, `expectAuth: true` (`e2e/client-auth.test.ts`) | G-C2 cache failure then fresh token; G-C3 a stale AuthError after a second `setAuth`; G-C4 a non-auth AuthError while awaiting a fresh token; G-C5 a refetch during a reauth; G-C6 a fresh token refused once, then accepted; G-C7 Authenticate before an Add made during the fetch: G-C2–G-C7 covered by `e2e/client-auth-races.test.ts` (#337, differential against the official base client); **G-C8 pause/resume of the query set** (no duplicate Add, Add+Remove cancel out, refcounts, a Remove queued while paused) |
| `react/client.test.tsx` | construct; optimistic updates and "Already specified…" (`e2e-react/react.test.tsx`) | G-C9 a SyntheticEvent passed to a mutation, G-C10 the async-optimistic-update warning and G-C11 `BunvexReactClient.query()` from an optimistic or local value: covered by `e2e-react/react-client-local.test.tsx` (#353, differential) |
| `react/queries_observer.test.ts`, `react/use_queries.test.ts` | G-C12: swap, unsubscribe, destroy, local results on first render, journals carried to a new client, errors, pagination options (`e2e-react/use-queries.test.tsx`, #338, differential with the official hook) | — |
| `react/react_node.test.ts` | — | G-C13: no callback after `close()` |
| `react/use_paginated_query.test.tsx` | skip, first page, loadMore, a page updating, a page split, `insertAtTop` (`e2e-react/pagination.test.tsx`, `paginated-experimental.test.tsx`) | G-C14 `initialNumItems` refused (4 inputs) and G-C15 restart on a new name or args, not on equal args: covered for both hooks by `e2e-react/paginated-hook-args.test.tsx` (#351, differential); G-C16 `insertAtTop` edge cases and G-C17 `insertAtPosition` (10 cases): covered by `e2e-react/insert-at.test.ts` (#334: Convex's cases plus a differential run against the official package); F5 |
| `react/use_query.test.ts` | types | n/a |
| `browser/http_client.test.ts` | the mutation queue and `skipQueue` (`e2e/http-client.test.ts`) | G-C18 a failed mutation does not block the queue and G-C19 `fetch` override precedence: covered by `e2e/http-client-queue.test.ts` (#352, differential) |
| `browser/query_options.test.ts` | — | n/a: `convexQueryOptions` missing (client-sync §11); types only |
| `browser/simple_client.test.ts` | deduplicated subscriptions (`client/pieces.test.ts`) | partial: the optimistic callback's synchrony is not asserted |
| `browser/sync/client.test.ts` | — | G-C20 `localQueryResult` of a never-subscribed optimistic query; the legacy-config warning is n/a |
| `browser/sync/client_node.test.ts` | Connect + ModifyQuerySet, long encoding, early actions, chunks (`client/pieces.test.ts`, `protocol/test/v1.test.ts`, `client/web-socket-manager.test.ts`); STUDY-57 maps maxObservedTimestamp and out-of-order results | G-C21 clean exit after `close()`; G-C22 a result outside the announced query-set version, `QueryRemoved`; G-C23 backoff reset only after a real resync (3 cases): covered by `client/test/reconnect-backoff.test.ts` (#329) |
| `browser/sync/local_state.test.ts` | creation | **G-C24** outstanding-after-restart until every query is answered; reset by unsubscribe, `markAuthCompletion`, `clearAuth` |
| `browser/sync/optimistic_query_set.test.ts` | server results, errors, apply / replay / drop (`client/pieces.test.ts`) | **G-C25** only changed queries notified; stacked updates dropped in order; set to `undefined` |
| `browser/sync/paginated_query_client.test.ts` | subscribe, loadMore, split (`e2e/paginated-client.test.ts`) | partial: a split driven by optimistic updates alone |
| `browser/sync/protocol.test.ts` | u64 round trip (`protocol/test/v1.test.ts`) | — |
| `browser/sync/request_manager.test.ts` | retries (STUDY-57) | G-C26 `hasIncompleteRequests`, dirty notifications |
| `nextjs/nextjs.test.tsx` | the URL variable, preloaded first render (`e2e/nextjs.test.ts`, `e2e-react/preloaded.test.tsx`) | G-C27 a live `null` replaces the preloaded value |

Shared with Convex, not divergences (§6 has the questions):
- `WebSocketManager.stop()` does not cancel a pending scheduled reconnect (Convex's `web_socket_manager.ts`
  does the same). After an AuthError and a server close, the old timer can reconnect with the refused token
  when the token fetch is slower than the backoff, burning one of the two confirmation attempts.
- `insertAtPosition` matches `argsToMatch` with `===`, unlike `insertAtTop` (Convex's
  `use_paginated_query.ts` has the same inconsistency).

Doc fix: [client-sync §13](../parity/client-sync.md) says `consistentQuery` does `GET /api/query_ts`; both
Convex and bunvex use `POST`.

## 4. CLI tests

Most of Convex's CLI tests are about the cloud: deployment selection and creation, previews, WorkOS,
AI files, version checks. They are n/a ([platform §21](../parity/platform.md), DV-186, DV-199).

| Convex file | Behaviour | bunvex | Status |
|---|---|---|---|
| `lib/formatEnvValueForDotfile.test.ts` (~140 cases) | every printed value reads back through dotenv; the formatted forms; the warnings; a permutation matrix | `cli/test/env.test.ts` checked 7 outputs, never a read back | **bug F1**; closed by #277 (round trip, property, end to end) |
| `lib/config.test.ts` | `convex.json` defaults, validation, unknown keys kept with a warning | `deploy.ts` reads `functions` and `codegen.fileType` | partial. G-L2 (a `bunvex.json` that is `null` threw a `TypeError`, invalid JSON the raw parse error) fixed in #342: Convex's messages for the keys bunvex reads, checked against Convex 1.46's CLI. Not done: the unknown-key warning. Node, static codegen, WorkOS and AI-files keys are n/a (DV-173, DV-174) |
| `lib/run.test.ts` | `parseFunctionName` forms | `cli/test/run.test.ts` "Convex's function name forms" | covered; G-L7: a nested functions directory, `.ts` without a colon |
| `lib/indexes.test.ts` | `formatIndex` for database, text and vector indexes | `cli/src/index-checks.ts`, reached only through the deploy prompts | gap G-L3 (see M6) |
| `lib/deployment.test.ts` | `CONVEX_DEPLOYMENT=` replaced or appended; `.gitignore` additions (null, empty, `.env`, comment, `!.env.local`, CRLF, patterns that cover it) | `cli/test/local-deployment.test.ts` (replace, first write, `.env*.local`; Convex's cases for both functions, #354) | covered (G-L5, M7) |
| `lib/localDeployment/run.test.ts` | the latest version: a non-200, a missing field, a network error each reported | `latestVersion` reports each with Convex's wording, and keeps a version found for the process (`cli/test/local-deployment.test.ts`, #355) | covered (G-L6) |
| `lib/components.test.ts` (`partitionModulesByChanges`) | changed / unchanged / deleted modules; env and source map in the hash | `cli/test/deploy.test.ts` "a push sends only the changed modules" | partial: source map and deletion cases |
| `lib/codegen.test.ts`, `codegen_templates/*` | `--init` files; stale `_generated` entries removed; import paths and identifiers | `cli/test/codegen.test.ts` | covered; the README written by `--init` is not asserted |
| `configure.test.ts` | which variables each deployment kind writes | local: `local-deployment.test.ts` "first run"; cloud n/a (DV-199) | covered / n/a |
| `deploymentSelection.test.ts` (self-hosted and local cases) | `--url`/`--admin-key`, `*_SELF_HOSTED_*`, `local:` | every CLI test passes them through the environment | partial: G-L4, no test of the precedence (flags > environment > `.env.local` > `.env`) or `--env-file` |
| `lib/fsUtils`, `lib/utils/hash`, `lib/utils/utils`, `deploymentSelector`, `deploymentCreate`, `deploymentSelect`, `expiration`, `workos/*`, `versionApi`, `updates`, `aiFiles/*` | | | n/a (stdlib, or cloud-only) |

## 5. Smaller mismatches (no app-visible data effect)

- **M1. Index-field errors.** Convex has three codes and messages: `IndexFieldsContainId` ("`_id` is not a
  valid index field. To load documents by ID, use `db.get(id)`."), `IndexFieldsContainCreationTime`
  ("`_creationTime` is automatically added…") and `IndexFieldNameReserved`. bunvex throws one message
  (`core/src/schema.ts`), although STUDY-05 cites Convex's codes. Matching is the default: a fix, no decision.
  Fixed in #343, with the other database-index checks Convex makes at push (too many fields, a repeated field,
  an empty index, two indexes on the same fields, reserved and repeated names), in its order and with its
  messages. Two behaviours changed with them: an index of 16 fields is refused (Convex appends `_creationTime`
  before its last count), and so are two database indexes on the same fields.
- **M2. Module count.** The message differs from Convex's "Too many function files (N > maximum 4096)…",
  and there is no total cap counting `_deps` (`server/src/code-version.ts`). Fixed in #348 (and an unexpected
  push failure is a 500 `InternalServerError`, as Convex's, instead of an unhandled error).
- **M3. Storage egress** counts the `content-length` header, not the bytes streamed; no
  `storage_api_bandwidth` event (DV-309 territory).
- **M4. HTTP action disconnect** is not in the function log ("Client disconnected"). Before the head: fixed in
  #350. While streaming: open; it needs the Completion logged once the body is sent, as Convex's.
- **M5.** No `pos` in the push analysis.
- **M6. Index diff after a push.** The CLI prints `[+] index <name>`; Convex prints "Added table indexes:",
  "Deleted table indexes:", "Added staged table indexes:", "These indexes are now enabled:" with
  `formatIndex`. The server sends names only (`server/src/push.ts`), not the index configs. Fixed in #347: the
  push answers Convex's `SerializedIndexDiff`, and the CLI prints it as Convex's `printDiff` (without the
  staged indexes' dashboard link, which points at Convex's dashboard).
- **M7. `.gitignore`.** bunvex treats only `*.local` as covering `.env.local`, where Convex accepts any
  `*.local` line; no blank line before the appended block. `writeEnvLocal` also matches only `^NAME=`, so an
  `export NAME=` line gets a duplicate. Fixed in #354: Convex's `changesToGitIgnore` and `changedEnvVarFile`
  (its test cases pass), so each variable is added after a blank line and an `export NAME=` line is left as
  it is, as Convex leaves it.
- **M8. `bunvex.json` validation** (G-L2 above): fixed in #342.
- **M9. A `null` journal after a client swap.** `QueriesObserver.setCreateWatch` (and `useQueries`' `createWatch`) pass
  `{ journal: null }` on when a query's journal is `null`; Convex passes a journal only when it is truthy, so its `Add`
  carries none. The server reads both the same. Fixed in #339.

## 6. Prioritized gap list

Effort: S under an hour, M a few hours. "Done" links the PR from this round.

| # | Gap | Why it matters | Area | Effort | Done |
|---|---|---|---|---|---|
| 1 | F1 dotenv parsing and round trip | silent corruption of secrets | `cli/src/target.ts` | M | #277 |
| 2 | F4 cancel through `runMutation` / `runAction` | runaway scheduled loops | `server/src/functions.ts` | S | #281 |
| 3 | F3 `auth.config` after an env update with a canonical URL | sign-in breaks after an unrelated change | `server/src/server.ts` | S | #279 |
| 4 | F2 repeated names in an env batch | the dashboard's rename and swap fail | `core/src/environment-variables.ts` | S | #278 |
| 5 | G-C8, G-C24, G-C25, G-C26: pause/resume of the query set, outstanding state after a restart, optimistic stacking, incomplete requests | a duplicate Add or an Add+Remove is a base-version mismatch, a fatal client error; wrong rollback order is wrong UI | `client/src/{local-state,optimistic-updates,request-manager}.ts` | S | #282 |
| 6 | G-C23 backoff reset only after a real resync | thundering-herd reconnects, or a backoff that never resets | `client/src/web-socket-manager.ts`, `local-state.ts` | M | #329 (tests only: bunvex already matched) |
| 7 | G-A4 canonical URL in user `getUrl` / `generateUploadUrl` | wrong file URLs behind a proxy | `server/src/storage.ts` | S | #333 (tests; bunvex matched) |
| 8 | G-A6 executor races (a job canceled, a cron deleted after pickup) | exactly-once | `server/src/scheduler.ts`, `cron-executor.ts` | S | #330 (tests; bunvex matched) |
| 9 | G-C17, G-C16 `insertAtPosition`, `insertAtTop` | an optimistic item flickers or lands on the wrong page | `react/src/use-paginated-query.ts` | S | #334 (tests; bunvex matched) |
| 10 | G-C2–G-C7 auth races | wrongly signed out, or a socket never restarted | `client/src/authentication-manager.ts` | M | #337 (tests; bunvex matched the official client in all 9 scenarios) |
| 11 | G-C12 `QueriesObserver` / `useQueries` | subscription leaks, lost journals | `react/src/queries-observer.ts`, `hooks.ts` | S | #338 (tests; bunvex matched, but see M9) |
| 12 | F5 the React client's `logger` | `logger: false` not honoured | `react/src/client.ts`, the paginated hooks | S | #340 (DV-322 decided: (a)) |
| 13 | G-L2 `bunvex.json` validation, M1 index-field messages | Convex's messages | `cli/src/deploy.ts`, `core/src/schema.ts` | S | G-L2: #342; M1: #343 |
| 14 | G-A7 disabled state; G-A10 returns validation of actions and extra fields; G-A11 an HTTP action commits after a disconnect | | `server` | S each | |
| 15 | M6 index diff printing in Convex's format | operator output | `cli/src/deploy.ts`, `server/src/push.ts` | M | #347 |
| 16 | G-A9 a 4096 + 4096 module push | push time and limits | `server/src/code-version.ts` | M | #348 |
| 17 | the rest of §2–§4 | characterisation, messages | | S each | |

## 7. Owner decisions

Both match Convex, so no divergence row (owner, 2026-10-03: keep).

- **Q1. A stale reconnect timer after `stop()`** (§3, shared with Convex): **keep** Convex's behaviour;
  `stop()` does not cancel a scheduled reconnect.
- **Q2. `insertAtPosition`'s `===` on `argsToMatch`** (shared with Convex): **keep**.

No decision is needed for F1–F5 or M1–M8: matching Convex is the default.

## 8. How this was done

Three read-only passes, one per area. Each listed every test case, read the bunvex code for each gap, and
looked for places where bunvex would answer differently. Every candidate bug was then reproduced with a
failing bunvex test before any fix. F1 was also checked against the real dotenv 16.4 in a scratch
directory (dotenv is not a bunvex dependency).
