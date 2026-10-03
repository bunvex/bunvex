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
| [STUDY-51](STUDY-51-vector-search.md) | Vector search: `vectorIndex`, `ctx.vectorSearch`, exact in memory | V1–V2 decided (owner, 2026-10-02); V3–V5 accepted as recommended (owner, 2026-10-03) |
| [STUDY-43](STUDY-43-data-command.md) | `bunvex data`: the tables and a table's documents, as `npx convex data` (`_system/cli/tables`, `tableData`) | accepted: D1 as recommended (owner, 2026-10-02) |

The inventory of everything Convex has, and bunvex's status on each item, is in [docs/parity](../parity/README.md).

Status values: *draft* → *decision pending (owner)* → *accepted* → *implemented (#PR)*.
