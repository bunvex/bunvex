# Convex studies

bunvex is a rewrite of Convex for Bun. The goal is that an app behaves **the same** on bunvex as on Convex,
from the function API down to its guarantees. Where bunvex differs, the difference is deliberate and
written down.

So no Convex-equivalent feature is implemented from memory or from the docs alone. It starts with a
**study** of how Convex actually does it, read in the Convex source.

## The rule

Before implementing a feature that Convex has:

1. **Study it in the source.** Read Convex's implementation in
   [get-convex/convex-backend](https://github.com/get-convex/convex-backend): the Rust crates for the
   backend and `npm-packages/convex` for the client and function API. The public docs say what Convex
   promises; the source shows how it keeps the promise and where the edges are. Cite files
   (`crates/…/file.rs`) so a reader can check.
2. **Write the study** as `docs/study/STUDY-NN-<topic>.md` from [TEMPLATE.md](TEMPLATE.md), in the same PR
   as the code or in a PR before it. It covers:
   - how Convex does it;
   - what an app can observe (the contract we must match);
   - how bunvex does it;
   - every divergence and why.
3. **Divergences need the owner.** Matching Convex is the default and needs no approval. Anything else —
   a different format, a missing piece, an extra feature — is listed under *Divergences* and decided by
   the owner before it merges. Record the decision in the study's table **and** in
   [docs/parity/divergences.md](../parity/divergences.md), the central ledger of divergences.
4. **Never copy Convex code.** Study it, then write bunvex's version from scratch (see [NOTICE](../../NOTICE)).
   Quoting a constant or a format description in a study is fine; pasting an implementation is not.

A study is not a spec. A spec (`docs/specs/`) records a bunvex design decision, such as the persistence
contract or the package layout. A study records what Convex does and how bunvex maps it. A study may lead
to a spec.

## Index

| Study | Topic | Status |
|---|---|---|
| [STUDY-01](STUDY-01-document-ids.md) | Document IDs (`_id`) and table numbers | accepted (C: as Convex) |
| [STUDY-02](STUDY-02-read-own-writes.md) | Read-your-own-writes inside a transaction | implemented (#3), retroactive |
| [STUDY-03](STUDY-03-deterministic-execution.md) | Deterministic queries and mutations | implemented (#4), retroactive |
| [STUDY-04](STUDY-04-table-and-index-metadata.md) | Table and index metadata (`_tables`, `_index`) | implemented (#6) |
| [STUDY-05](STUDY-05-index-keys-and-ordering.md) | Value order, index keys and system indexes | implemented / decided: all fixed (B5, B6, B11) or resolved (DV-33–DV-37) |
| [STUDY-06](STUDY-06-transactions-and-occ.md) | Transactions, OCC, commit and retries | decided; D3, D10, D11 resolved to match Convex (DV-57, DV-60, DV-61); D12 built (DV-62), D13 decided (DV-152); D8 a gap to build (DV-59) |
| [STUDY-07](STUDY-07-query-semantics.md) | Query semantics (`withIndex`, `take`, `collect`, limits) | implemented / decided: all fixed or resolved (DV-40–DV-43) |
| [STUDY-08](STUDY-08-cache-and-subscriptions.md) | Query cache and subscriptions | decided; D9, D10 resolved to match Convex (DV-64, DV-57); D6 (sync path, B13) and D8 (DV-63) to build |
| [STUDY-09](STUDY-09-persistence-layout.md) | Persistence layout and drivers | decided; D3 fixed (#17, B4); D9 built (DV-62); D5, D6 gaps (DV-65, DV-66; D6 partly built, #117); D4 not tracked |
| [STUDY-10](STUDY-10-documents-and-values.md) | Documents and values | implemented / decided; D12 (`db.system`) a gap (DV-69) |
| [STUDY-11](STUDY-11-function-results-and-errors.md) | Function results and errors | implemented / decided: all resolved (DV-31, DV-44, DV-46, DV-49, DV-70, DV-71) |
| [STUDY-12](STUDY-12-dashboard.md) | The dashboard: every screen, on the mock (§1–§15) | accepted: divergences decided; bunvex additions recorded; open items in §6 (the Health review) |
| [STUDY-13](STUDY-13-validators.md) | Validators (`v.*`) and args / returns validation | implemented (#24, #25) |
| [STUDY-14](STUDY-14-schemas.md) | Schemas: `defineSchema`, `defineTable`, document validation, implicit tables | implemented (#29, #33) |
| [STUDY-15](STUDY-15-query-filter.md) | `.filter()` and the filter builder | implemented (#37) |
| [STUDY-16](STUDY-16-query-chaining.md) | Query chaining, `unique()`, `fullTableScan()`, async iteration | implemented (#40) |
| [STUDY-17](STUDY-17-paginate.md) | `.paginate()`, cursors, reactive page boundaries, the instance secret | implemented (#42) |
| [STUDY-18](STUDY-18-value-model.md) | The value model: types, order, index keys, JSON | implemented (#15, #21) |
| [STUDY-20](STUDY-20-function-errors-and-logs.md) | Function errors, redaction and log lines | implemented; D1–D8 decided (owner, 2026-09-30 and 2026-10-01) |
| [STUDY-21](STUDY-21-occ-error-and-retries.md) | The OCC error and mutation retries | implemented; D1, D2 decided (DV-81, DV-82); D3 a gap |
| [STUDY-22](STUDY-22-ws-mutation-order.md) | Mutation order on one WebSocket connection | implemented; D1 decided (owner, 2026-10-01) |
| [STUDY-23](STUDY-23-sync-protocol-v1.md) | Sync protocol v1: transitions, read-your-writes, sessions, reconnect, auth | accepted: P1–P12 as recommended (owner, 2026-09-30); implementation in steps |
| [STUDY-24](STUDY-24-horizontal-scaling.md) | Horizontal scaling: leader + followers, commit stream, leases, readiness | draft v2 (reviewed, with experiments): H1–H12 decided (owner, 2026-09-30 and 2026-10-01); S1–S5 fixed (S5: STUDY-29, #115) |
| [STUDY-25](STUDY-25-persistence-lifecycle.md) | Persistence lifecycle: open, schema and versioning, timeouts, retries, shutdown (with runs of the real Convex binary) | accepted: L1–L12 decided (owner, 2026-09-30 and 2026-10-01); L1, L3 (#107), L4 and L5 (#112), L6 and L7 (#114) and L8 (#116) done |
| [STUDY-26](STUDY-26-sync-client.md) | The sync client: base client, local and remote state, requests, optimistic updates, reconnect and backoff, `BunvexClient` | accepted: C3–C7 as recommended (owner, 2026-09-30) |
| [STUDY-27](STUDY-27-auth.md) | Authentication: auth.config, JWT / OIDC verification, `ctx.auth`, identity-aware caching, sync and client auth, React helpers | accepted: A1–A3, A5 as recommended (owner, 2026-09-30) |
| [STUDY-30](STUDY-30-scheduler-and-crons.md) | Scheduled functions (`ctx.scheduler`, `_scheduled_functions`) and cron jobs | accepted: S1–S3 as recommended (owner, 2026-10-01) |
| [STUDY-33](STUDY-33-retention.md) | Retention: garbage collection of old index and document versions, the windows, reads below them | implemented; R1–R4 accepted (owner, 2026-10-01) |
| [STUDY-34](STUDY-34-admin-keys.md) | Admin keys: format and crypto, instance name, identities (admin, acting user, system), admin-only functions and endpoints | accepted: AK1–AK6 as recommended (owner, 2026-10-01) |
| [STUDY-35](STUDY-35-push-and-deploy.md) | Pushing and deploying functions: bundling, the deploy2 protocol, code versions in `vm` contexts, the atomic switch | implemented (PRs #160–#166); P1–P6 accepted (owner, 2026-10-02) |
| [STUDY-36](STUDY-36-codegen.md) | Codegen: `_generated/` (api, server, dataModel) and the typed data model behind it | accepted: all as recommended (owner, 2026-10-02) |
| [STUDY-37](STUDY-37-cli-and-environment-variables.md) | Deployment environment variables (`process.env`, limits, auth config) and the CLI part 1: `start`, `run`, `env`, `dev` | accepted: all as recommended (owner, 2026-10-02) |
| [STUDY-38](STUDY-38-docker.md) | The Docker image and docker-compose: `bunvex start` in a container, credentials in the volume, `generate_admin_key.sh`, publishing | accepted: all as recommended (owner, 2026-10-02) |
| [STUDY-39](STUDY-39-standalone-binary.md) | The standalone executable: `bunvex` compiled per platform, released as Convex releases `convex-local-backend` | accepted: all as recommended (owner, 2026-10-02) |
| [STUDY-28](STUDY-28-builtin-auth.md) | Built-in authentication on better-auth, hosted in the engine: users, sessions, plugins, a Users dashboard (beyond Convex) | accepted: B1–B10 as recommended (owner, 2026-10-01); spike done |
| [STUDY-31](STUDY-31-http-actions.md) | HTTP actions: `httpRouter`, `httpAction`, serving on `/http` and the site port, errors, limits, auth | accepted: H1–H5 as recommended (owner, 2026-10-01) |
| [STUDY-29](STUDY-29-index-backfill.md) | Background index backfill: index states, staged indexes, the worker, checkpoints and resume, queries on a backfilling index | implemented (#115); B1, B2 decided (owner, 2026-10-01: DV-126, DV-127) |
| [STUDY-32](STUDY-32-file-storage.md) | File storage: `ctx.storage`, `_storage`, upload tokens and URLs, downloads, local and S3 backends | accepted: F1–F4 as recommended (owner, 2026-10-01) |
| [STUDY-40](STUDY-40-local-backend-and-local-deployments.md) | `bunvex-local-backend` as Convex's `convex-local-backend`, local deployments in `bunvex dev` (download, state, `.env.local`), the npm package | accepted: all as recommended (owner, 2026-10-02) |
| [STUDY-41](STUDY-41-nested-calls-and-execution-limit.md) | `ctx.runQuery` / `ctx.runMutation` in queries and mutations (one transaction, sub-transactions, depth 8, `useStaleSnapshot`, `transactionLimits`), and the 1 s user execution limit | accepted: all as recommended (owner, 2026-10-02) |
| [STUDY-42](STUDY-42-import-export.md) | Snapshot export (ZIP, `_exports`, endpoints, `bunvex export`) and import (CSV/JSON/JSONL/ZIP, modes, hidden tables, `_snapshot_imports`, `bunvex import`) | accepted: all as recommended (owner, 2026-10-02) |
| [STUDY-44](STUDY-44-ctx-meta.md) | `ctx.meta`: function, transaction, deployment, snapshot and request metadata | built; no divergence |
| [STUDY-45](STUDY-45-text-search.md) | Full-text search: `searchIndex`, `withSearchIndex`, tokens, BM25, limits, reactivity | accepted: S1–S6 as recommended (owner, 2026-10-02) |
| [STUDY-47](STUDY-47-log-streaming.md) | Function log streaming: the execution log, `stream_function_logs`, `bunvex logs`, `dev --tail-logs` | accepted: L1–L4, L6 as recommended (owner, 2026-10-03) |
| [STUDY-48](STUDY-48-audit-log.md) | The deployment audit log: `_deployment_audit_log`, its events, the dashboard's queries, `list_audit_log_events` | accepted: A1–A3 as recommended (owner, 2026-10-03) |
| [STUDY-49](STUDY-49-canonical-urls.md) | Canonical URLs: `_canonical_urls`, `update_canonical_url`, the built-ins and file URLs they replace | accepted: C1 as recommended (owner, 2026-10-03) |
| [STUDY-50](STUDY-50-function-handles.md) | Function handles: `createFunctionHandle`, `_function_handles`, handles in `runX` and the scheduler | accepted: H1 as recommended (owner, 2026-10-03) |
| [STUDY-51](STUDY-51-vector-search.md) | Vector search: `vectorIndex`, `ctx.vectorSearch`, exact in memory | V1–V2 decided (owner, 2026-10-02); V3–V5 accepted as recommended (owner, 2026-10-03) |
| [STUDY-52](STUDY-52-shape-inference.md) | Table shape inference: the counted lattice, `/api/shapes2` | A1–A3 accepted as recommended (owner, 2026-10-03) |
| [STUDY-53](STUDY-53-commit-timestamp.md) | The commit timestamp: `db.vars.commitTs`, `v.commitTs()`, resolution at commit | accepted: T1–T2 as recommended (owner, 2026-10-03) |
| [STUDY-56](STUDY-56-push-checks.md) | The checks before a push: `evaluate_schema`, large-index deletion and backfill, slow schema walk, the default `--message` | P1 accepted as recommended (owner, 2026-10-03) |
| [STUDY-57](STUDY-57-linearizability-testing.md) | Jepsen-style consistency testing: a history of concurrent clients, a linearizability checker, invariants, faults | draft (PR 1: harness and checker) |
| [STUDY-58](STUDY-58-app-metrics.md) | App metrics: `/api/app_metrics/*`, the in-memory store, what is recorded | implemented; DV-302 accepted (owner, 2026-10-03) |
| [STUDY-59](STUDY-59-log-streams.md) | Log streams: `_log_sinks`, the API, the manager, webhook and local sinks, events | implemented; DV-303–DV-305 accepted (owner, 2026-10-03) |
| [STUDY-60](STUDY-60-streaming-export.md) | Streaming export: `list_snapshot`, `document_deltas`, `json_schemas`, `get_table_column_names` | implemented; DV-306 accepted, DV-307 resolved (owner, 2026-10-03) |
| [STUDY-61](STUDY-61-usage-limits.md) | Usage tracking and usage limits: the meter, `/api/v1/*usage*`, the enforcement worker | implemented; DV-308 resolved, DV-309 accepted (owner, 2026-10-03) |
| [STUDY-62](STUDY-62-components.md) | Components: how Convex does them, bunvex's touch points, the plan | K1–K9 accepted as recommended (owner, 2026-10-03) |
| [STUDY-63](STUDY-63-pause-deployment.md) | Pausing a deployment: `_backend_state`, pause / unpause, what stops while paused | implemented, no divergence an app can reach |
| [STUDY-64](STUDY-64-sync-load.md) | The sync worker under load and outages: the 60 s mutation timeout, per-socket caps, single-flight transitions, query rerun concurrency and retries, the reconnect limiter, result and argument sizes | draft; W1 pending (owner) |
| [STUDY-65](STUDY-65-convex-tests-application-client-cli.md) | What Convex tests in `crates/application`, the React / browser / Next.js clients and the CLI, mapped to bunvex's tests; the bugs it found and the gaps left | draft; F1–F4 fixed (#277, #278, #279, #281), client tests #282 |
| [STUDY-66](STUDY-66-server-api-gaps.md) | Small server-API gaps: `.limit(n)` and the 256-operator cap, `db.table()`, returned queries, `fetch` / timers / randomness in queries and mutations, bad tokens in nested actions, `schema.doc` / `schema.id` / `docValidator`, registration guards | draft; no divergence needing the owner |
| [STUDY-67](STUDY-67-http-function-api.md) | The HTTP function API: routes, status codes, `format`, request errors, CORS (audited against Convex's local backend) | studied; H7, H10–H12 pending (owner) |
| [STUDY-68](STUDY-68-function-limits.md) | Concurrency limits per function kind (queries, mutations, actions, Node actions) | implemented; closes DV-302 |
| [STUDY-69](STUDY-69-data-sync.md) | Data sync: `/api/v1/data/sync` and its routes, Convex's cursor, by-id then log pages, progress | implemented; owner decisions 2026-10-03 |
| [STUDY-70](STUDY-70-provider-sinks.md) | Provider log stream sinks: Datadog, Axiom, Sentry, PostHog Logs and PostHog Error Tracking, as Convex's | implemented (DV-303 resolved; names under DV-304, owner, 2026-10-03) |
| [STUDY-71](STUDY-71-usage-metering.md) | Usage metering as Convex's: database I/O, user time, egress, storage and search bytes (DV-309) | U1–U2 accepted as recommended (owner, 2026-10-03); PR 1 (database I/O) implemented |
| [STUDY-72](STUDY-72-table-summary-checkpoints.md) | Table summary checkpoints: the `table_summary_v2` global, Convex's worker pacing, a restore from the document log (DV-300) | implemented; C1 accepted as recommended (owner, 2026-10-03), DV-318 |
| [STUDY-73](STUDY-73-storage-usage-gauges.md) | Storage usage gauges: the hourly `current_storage_usage` event, the 1 TiB export limit on files | implemented; G1 accepted as recommended (owner, 2026-10-03), DV-317 extended |
| [STUDY-74](STUDY-74-function-execution-fields.md) | The `function_execution` fields DV-305 left out: `run_reason` of sync reruns, `scheduler_info`, arguments' bytes, retry counts, the mutation queue | implemented; F1 accepted as recommended (owner, 2026-10-03), DV-320 |
| [STUDY-80](STUDY-80-outbound-requests.md) | Outbound requests: the schemes and options an action's `fetch` takes, the SSRF proxy (`--convex-http-proxy`), what goes through it | PR 1 (#377), PR 2 (#379) and P1 (#381; DV-325 decided: C, owner, 2026-10-04) implemented |
| [STUDY-76](STUDY-76-limit-warnings.md) | Approaching-limit warnings: WARN system lines past 80 % of a limit, for queries, mutations, actions, HTTP actions and system functions | implemented; DV-323 resolved in the next PR (owner, 2026-10-04) |
| [STUDY-75](STUDY-75-sync-cache-hit-logs.md) | A sync query served from another session's run logs a cache hit, as Convex's query cache | implemented, no divergence |
| [STUDY-43](STUDY-43-data-command.md) | `bunvex data`: the tables and a table's documents, as `npx convex data` (`_system/cli/tables`, `tableData`) | accepted: D1 as recommended (owner, 2026-10-02) |
| [STUDY-46](STUDY-46-nextjs.md) | Next.js and server rendering: `fetchQuery` / `fetchMutation` / `fetchAction`, `preloadQuery`, `usePreloadedQuery` | accepted: X1–X3 as recommended (owner, 2026-10-03) |
| [STUDY-54](STUDY-54-react-clerk-auth0.md) | React providers for Clerk and Auth0: `BunvexProviderWithClerk`, `BunvexProviderWithAuth0` | accepted: X1–X2 as recommended (owner, 2026-10-03) |
| [STUDY-55](STUDY-55-react-query.md) | TanStack Query: `@bunvex/react-query` (`BunvexQueryClient`, `bunvexQuery`, `bunvexAction`), as `@convex-dev/react-query`, with SSR at one snapshot | accepted: R1–R4 as recommended (owner, 2026-10-03); R4 built in a follow-up |
| [STUDY-91](STUDY-91-isomorphic-server.md) | `bunvex/server` in a browser bundle and in Node, as `convex/server`: the builders moved to `builders.ts`, an isomorphic entry under the non-`bun` conditions | implemented; no divergence (the owner chose full parity, 2026-10-04) |
| [STUDY-82](STUDY-82-log-audit.md) | The `log` export: `log.audit(body)` and `log.vars`, audit log lines, their limits and the `custom_audit` topic | implemented |
| [STUDY-81](STUDY-81-deploy-cmd.md) | `bunvex deploy --cmd` and `--cmd-url-env-var-name`: a build command run first with the deployment's URLs, as Convex's `runCommand` | implemented |
| [STUDY-83](STUDY-83-bundling-server-only-and-wasm.md) | Bundling `import "server-only"` (an empty module) and `.wasm` imports (a `WebAssembly.Module`), as Convex's bundler plugins | implemented |
| [STUDY-79](STUDY-79-search-index-bootstrapping.md) | Search and vector indexes while they are rebuilt after a start: Convex's bootstrapping answer, the sync skip and retry; options for the window | implemented; window decided (owner, 2026-10-04: A now, D planned) |
| [STUDY-78](STUDY-78-write-throughput-limit.md) | The write throughput limit: 4 MiB/s per deployment, `TooManyWrites`, who waits and who fails | implemented |
| [STUDY-77](STUDY-77-action-timeout.md) | The action timeout: 1800 s (Node 600 s), Convex's messages, the cut-off handler | implemented |
| [STUDY-95](STUDY-95-error-stacks.md) | A function's error stack: only the app's frames, source-mapped to its files, everywhere errors surface | implemented; S1 / S2 (DV-345, DV-346) accepted as recommended (owner, 2026-10-04) |
| [STUDY-99](STUDY-99-http-client-function.md) | `BunvexHttpClient.function()`: any function by an admin, through `/api/function` | implemented |
| [STUDY-100](STUDY-100-typed-validators.md) | Table names in `v.id`: system tables suggested everywhere, the app's tables typed through codegen (a bunvex addition, beyond Convex) | accepted: T1 and T2 (owner, 2026-10-04); T3 later |
| [STUDY-98](STUDY-98-filter-api.md) | `filterApi` from `bunvex/server`: the api, filtered by type | implemented |
| [STUDY-97](STUDY-97-value-size-and-base64.md) | `getDocumentSize`, `Base64` and `getConvexSize` (`valueSize`) from `bunvex/values`, as Convex's | implemented; the `getConvexSize` name kept as `valueSize` (owner, 2026-10-04, DV-347) |
| [STUDY-96](STUDY-96-search-index-snapshots.md) | Search and vector indexes snapshotted at a clean shutdown, restored at start with the log since (STUDY-79 option D) | implemented; storage and crash behaviour decided by the owner (2026-10-04) |

The inventory of everything Convex has, and bunvex's status on each item, is in [docs/parity](../parity/README.md).

Status values: *draft* → *decision pending (owner)* → *accepted* → *implemented (#PR)*.
