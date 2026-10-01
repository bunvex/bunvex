# Architecture

This is the **living map** of bunvex: every package, what lives in it, what it may depend on, and where it
stands. Update it in the same pull request that changes any of those. The reasoning behind the layout —
the alternatives that were rejected and why — is in
[`docs/specs/ARCH-01-monorepo.md`](docs/specs/ARCH-01-monorepo.md).

bunvex is a Convex-style reactive backend written in TypeScript for Bun, with its own database engine on
top of a pluggable persistence layer (memory + log, SQLite, Postgres, MySQL, MongoDB). The engine keeps
every document version and every index entry stamped with a commit timestamp, runs mutations as
optimistic serializable transactions validated by one committer, and re-runs subscribed queries whose
read-set a commit overlaps.

## Status legend

| mark | meaning |
|---|---|
| ✅ | exists today (may still move during the monorepo migration) |
| 🟡 | partially there |
| **N** | core — needed for Convex's guarantees; done before anything else |
| **M** | MVP — needed to build a real app |
| **D** | later |

## The map

```
bunvex/
├── packages/
│   │
│   ├── values/                      @bunvex/values
│   │   ├── validators               v.string(), v.number(), v.id("tasks"), v.object()…      ✅
│   │   ├── id                       Convex-format ids: table number + checksum (STUDY-01)    ✅
│   │   ├── types                    Value, JSON form, sort keys (STUDY-18) ✅ · Infer<> N
│   │   └── errors                   BunvexError (Convex's ConvexError) with `data` (STUDY-20)  ✅
│   │
│   ├── core/                        @bunvex/core                     ← the ENGINE
│   │   ├── keyenc                   order-preserving byte keys                                ✅
│   │   ├── schema                   declared tables + indexes, Convex name rules ✅ · document validation N
│   │   ├── catalog                  _tables/_index: persistent table numbers + index ids, index states ✅
│   │   ├── committer                timestamps, group commit, optimistic validation, write log ✅
│   │   ├── tx                       read-set, write-set, versioned rows, query builder:
│   │   │                            withIndex/order/take/first ✅ · read-own-writes in queries ✅ ·
│   │   │                            filter M · paginate M
│   │   ├── engine                   snapshots, query cache by read-set ✅ · Convex's OCC retries/error (STUDY-21) ✅
│   │   ├── determinism              frozen Date, seeded Math.random, no fetch/timers in txs   ✅
│   │   ├── subscriptions            subscriptions, invalidation, dedupe (transport-agnostic)  ✅
│   │   ├── index-worker             background backfill of new indexes (STUDY-29)             ✅
│   │   ├── retention                garbage-collect old versions                              M
│   │   ├── search                   text and vector search (or its own package)               D
│   │   └── persistence/             the Persistence INTERFACE (contract PERSIST-01)           ✅
│   │       ├── memory               memory + append-only log (no dependencies)                ✅
│   │       └── sqlite               bun:sqlite (no dependencies)                              ✅
│   │
│   ├── persistence/                 @bunvex/persistence               ← external databases
│   │   ├── postgres                 (optional peer: postgres)                                 ✅
│   │   ├── mysql                    (optional peer: mysql2)                                   ✅
│   │   ├── mongodb                  (optional peer: mongodb)                                  ✅
│   │   └── tls (internal)           TLS required + verified by default, as Convex (STUDY-25 L8) ✅
│   │
│   ├── persistence-conformance/     @bunvex/persistence-conformance   the K1–K7 suite, published ✅
│   │
│   ├── protocol/                    @bunvex/protocol                  sync v1 + HTTP messages ✅
│   │
│   ├── server/                      @bunvex/server
│   │   ├── functions (runtime)      query/mutation/action, registry, internal fns ✅ ·
│   │   │                            validation N · determinism ✅ (in core) · sandbox D
│   │   ├── server (transports)      HTTP API ✅ · WebSocket subscriptions ✅ · advance together N ·
│   │   │                            errors, errorData, redaction (STUDY-20) ✅ ·
│   │   │                            one connection's mutations in order (STUDY-22) ✅ ·
│   │   │                            read-your-writes N · HTTP actions (STUDY-31) ✅
│   │   ├── scheduler                runAfter/runAt/cancel, db.system, crons (STUDY-30)        ✅
│   │   ├── storage                  ctx.storage: file metadata (a system table)               M
│   │   ├── auth                     ctx.auth over HTTP and sync, TokenExpired (STUDY-27) ✅ ·
│   │   │                            admin keys M
│   │   ├── admin                    admin/deploy keys, health, stats                          🟡 → M
│   │   ├── persistence (config)     PERSISTENCE=, PERSISTENCE_URL=, Convex's POSTGRES_URL=… and DO_NOT_REQUIRE_SSL= ✅ · FILE_STORAGE=, env vars M
│   │   ├── logs                     console.log from functions → logLines (STUDY-20) ✅ · streaming D
│   │   └── metrics                  Prometheus                                                D
│   │
│   ├── file-storage/                @bunvex/file-storage              ← the BYTES of files    M
│   │   ├── local                    local disk
│   │   └── s3                       S3 / R2 / MinIO / compatible
│   │
│   ├── auth/                        @bunvex/auth
│   │   ├── jwt                      verify JWT / OIDC (JWKS), STUDY-27                        ✅
│   │   ├── clerk                                                                               D
│   │   └── auth0                                                                               D
│   │
│   ├── client/                      @bunvex/client
│   │   ├── sync                     WebSocket, reconnect, session (STUDY-26)                  ✅
│   │   ├── local-state              a client's subscriptions advance together                 ✅
│   │   ├── optimistic               optimistic updates                                        ✅
│   │   ├── pagination               paginated queries (usePaginatedQuery, STUDY-26 §8)        ✅
│   │   └── http                     plain HTTP client (BunvexHttpClient, STUDY-26 §9)         ✅
│   │
│   ├── react/                       @bunvex/react   useQuery, useMutation, usePaginatedQuery,
│   │                                BunvexProviderWithAuth, useBunvexAuth (STUDY-27)          ✅
│   ├── nextjs/                      @bunvex/nextjs  SSR / hydration                           D
│   │
│   ├── ui/                          @bunvex/ui       design system (UI-01): Tailwind v4 tokens,
│   │                                light/dark themes, shadcn/ui on Base UI; no bunvex dependency 🟡
│   ├── dashboard/                   @bunvex/dashboard  the dashboard screens (UI-01), fed by an
│   │   ├── data-source              injected DashboardDataSource — the contract with the server   🟡
│   │   ├── mock                     MockDataSource, and the contract suite any source must pass  ✅
│   │   ├── database                 tables, filters, data grid, editing, live changes (STUDY-12) ✅
│   │   ├── schema                   the schema as a diagram: tables, references (STUDY-12 §14)     ✅
│   │   ├── topology                 nodes by role, lag, the store and lease (a bunvex addition)     ✅
│   │   ├── logs                     live log lines, client filters, details (STUDY-12 §7)          ✅
│   │   ├── functions                module tree, a function's details and logs (no metrics yet)   ✅
│   │   ├── runner                   run a function: literal args, value or error, its log lines    ✅
│   │   ├── schedules                scheduled runs (cancel), cron jobs and their runs (STUDY-12 §9) ✅
│   │   ├── files                    stored files: upload, image preview, download, delete (§9)     ✅
│   │   ├── settings                 environment variables: hidden values, batch edits (§9)        ✅
│   │   ├── history                  the audit log, in words, filtered, live (STUDY-12 §9)           ✅
│   │   └── screens                  health ✅ (engine counters)                                    ✅
│   │
│   ├── cli/                         @bunvex/cli
│   │   ├── dev                      watch files and push                                      M
│   │   ├── codegen                  API types (or inferred types — open decision)             M
│   │   ├── deploy                   publish functions (restart or hot swap — open decision)   M
│   │   ├── run, env, logs, data                                                                D
│   │   ├── import, export                                                                      D
│   │   └── mcp                      for AI agents                                              D
│   │
│   ├── testing/                     @bunvex/testing  the REAL engine in memory, to test functions M
│   │
│   └── bunvex/                      bunvex           ← THE ONLY PACKAGE AN APP INSTALLS
│       └── (re-exports)             bunvex/server · bunvex/values · bunvex/browser ·
│                                    bunvex/react · bunvex/nextjs · bin: bunvex
│
├── apps/
│   ├── dashboard/                   thin Vite host mounting @bunvex/dashboard (mock data for now) 🟡
│   └── site/                        bunvex.dev (SITE-01): landing now, user docs later; TanStack Start 🟡
│
├── examples/
│   ├── todo/                        the minimal example                                        M
│   ├── chat/                        realtime, fan-out                                          M
│   └── with-postgres/, with-auth/…                                                             D
│
├── bench/                           microbenchmarks + convex-bench adapters (not published)    ✅
├── docker/                          server image (bunvex start)                                M
├── docs/
│   ├── specs/                       design records for MAINTAINERS (ENGINE-00, PERSIST-01, ARCH-01…) ✅
│   ├── study/                       how Convex does X and how bunvex maps it (STUDY-NN), before code ✅
│   ├── parity/                      everything Convex has, bunvex's status on each, the roadmap     ✅
│   └── bench/                       benchmark reports                                          ✅
│
├── .github/                         workflows (lint, typecheck, tests, conformance against SQLite,
│                                    Postgres, MySQL, MongoDB service containers, release),
│                                    issue and PR templates
├── .changeset/                      per-package versions and changelogs
├── README.md · ARCHITECTURE.md · CONTRIBUTING.md · CODE_OF_CONDUCT.md · SECURITY.md · LICENSE
└── package.json (workspaces) · tsconfig.base.json · biome.json
```

## How an app sees it

An app installs **one package** and chooses its database by configuration (or by import when embedding):

```ts
// bunvex/schema.ts
import { defineSchema, defineTable } from "bunvex/server";
import { v } from "bunvex/values";

// bunvex/tasks.ts
import { query, mutation } from "bunvex/server";

// the front end
import { BunvexProvider, useQuery } from "bunvex/react";

// an external database: install its native driver and point at it
//   bun add postgres
//   PERSISTENCE=postgres PERSISTENCE_URL=postgres://… bunvex start
// or, when embedding the engine in your own code:
import { postgres } from "@bunvex/persistence/postgres";
```

The scoped `@bunvex/*` packages exist for whoever needs one piece — a third-party persistence driver,
tests, embedding the engine. An app never has to know they exist.

## Dependency rules

These are enforced in CI, not only written down.

```
values ◄── core ◄── persistence          protocol ◄── server ──► core, values, auth, file-storage
                                                              (+ persistence: optional, loaded by name)
                ◄── persistence-conformance (──► values) client ──► protocol, values
                ◄── testing ──► server                   react ──► client
                ◄── sync-e2e ──► client, react, server (tests only, never published)
cli ──► server, core                                      bunvex ──► re-exports only

ui ◄── dashboard ◄── apps/dashboard (──► ui)
ui ◄── apps/site
```

- `core` knows no external database, no HTTP and no WebSocket.
- The client never pulls the engine: a browser bundle contains only `client`, `protocol` and `values`.
- `ui` depends on no bunvex package; `dashboard` only on `ui` — never `core` or `server`: its data comes
  through the injected `DashboardDataSource`, so the same screens serve a self-hosted server and a cloud
  control plane (UI-01). The rules cover `apps/*` too.
- A persistence driver depends only on the `Persistence` interface from `core` and on its native driver.
- No source file starts with `// @bun…` (Bun's "already transpiled" pragma).

`bun run check:deps` (`scripts/check-deps.ts`) enforces all of the above.

## Two words that must not be confused

- **persistence** — where the ENGINE keeps document versions and index entries (the database layer).
  Interface `Persistence`, configured with `PERSISTENCE=`.
- **storage** — FILES, exactly as in Convex: `ctx.storage.store()`, `getUrl()`, `delete()`. Metadata is a
  system table in the engine; the bytes go to a `@bunvex/file-storage` backend, configured with
  `FILE_STORAGE=`.

## Project facts

- Name: **bunvex** — npm package `bunvex`, scope `@bunvex/*`, GitHub `github.com/bunvex/bunvex`.
- Licence: **Apache-2.0** (`LICENSE`, `NOTICE`).

## Open decisions

Recorded in ARCH-01 §6, to be settled in their own specs:

1. Types: code generation (as Convex) or type inference without a codegen step.
2. Deploying functions: restart the server, or hot-swap the module.
3. Sandboxing functions: now, or later.
4. Text and vector search: inside `core`, or a package of their own.
