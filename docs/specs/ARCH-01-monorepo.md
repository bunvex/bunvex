# ARCH-01 — the monorepo: packages, boundaries and the migration

> **v1, 29 Sep 2026.** The living map of the result is [`ARCHITECTURE.md`](../../ARCHITECTURE.md) at the
> repository root — keep THAT up to date; this document records why the layout is what it is. A later
> change to the layout amends this record with a new section (or a new spec); it does not rewrite it.

## 1. Why now

The code is small (~2 000 lines in `src/` and `bench/`) and its boundaries are already clear — five
persistence drivers were added without touching the engine. The next work (Convex's guarantees, then the
client, auth, the scheduler, the CLI) would each cross a wrong boundary if the layout were decided later.
bunvex is meant to be an open-source project on GitHub: contributors need to find their way by the
structure alone.

**The migration is a pure move**: no behaviour changes. It is verified by the persistence conformance
suite (K1–K7, `bench/conformance.ts`, every driver) and by the benchmark (`convex-bench`), which must give
the same results before and after.

## 2. What we learned from Convex's layout

Measured on the Convex repository at `~/sandbox/convex-backend`:

- **Inside, split finely**: 74 Rust crates. The persistence drivers (`sqlite`, `postgres`, `mysql`) depend
  **only** on `common`, where the `Persistence` trait lives; the engine (`database`) knows no driver.
  `application` orchestrates; `local_backend` is the server binary.
- **Outside, one package**: the `convex` npm package, with subpath exports (`convex/server`,
  `convex/browser`, `convex/react`, `convex/values`, `convex/nextjs`, …) and the CLI as its `bin`. An app
  never learns how many pieces exist.

bunvex keeps both halves: fine internal packages with enforced dependency rules, one umbrella package for
apps.

## 3. The criterion for a package

A piece becomes its own package when **(a)** something outside the monorepo must depend on it alone
(a third-party driver on the persistence contract; a browser on the client), **(b)** it carries heavy or
optional dependencies (native database drivers, auth providers), or **(c)** it runs somewhere else (browser
vs server). Otherwise it is a **module** inside a package: size of a folder is not a reason.

Consequences:

| piece | package? | why |
|---|---|---|
| values, protocol | yes | shared by client and server; the client must not pull the engine |
| core | yes | the engine; everything else builds on it |
| memory, SQLite persistence | **no — inside core** | zero dependencies (`bun:sqlite` ships with Bun); `bunvex dev` works with nothing installed |
| Postgres, MySQL, MongoDB persistence | **one package, subpaths** | native drivers are optional peers; one version and one changelog |
| conformance suite | yes | the bar a third-party driver must clear |
| server, client | yes | run in different places |
| react, nextjs | yes | framework-specific peers |
| auth | yes | optional, with its own dependencies |
| scheduler, crons, HTTP actions, logs | no — modules of server | they need the committer from inside |
| file storage backends | yes (`@bunvex/file-storage`) | optional, with SDK dependencies (S3) |
| testing | yes | test-time only |
| cli | yes | a separate entry point, re-exported as the umbrella's `bin` |
| search | open (§6) | decide when it exists, by its dependencies |

## 4. Decisions

**D1 — Bun workspaces monorepo**, `packages/`, `apps/`, `examples/`, `bench/`, `docker/`, `docs/`.

**D2 — the persistence layer is called *persistence*, never *storage*.** In Convex, `storage` is the FILE
API (`ctx.storage`); bunvex keeps that meaning so Convex users recognise it. The engine's database layer
takes Convex's internal term: the interface `Storage` is renamed `Persistence`, `STORAGE=` becomes
`PERSISTENCE=`, and STORAGE-01 becomes **PERSIST-01** (same content). Rejected: `adapters` (too generic —
auth and queues will have adapters too), `drivers` (collides with the native driver underneath: "the
driver's driver"), `db` (suggests bunvex is a database client and hides that the engine is the database).

**D3 — where persistence drivers live** (options considered):

| option | example | verdict |
|---|---|---|
| A. one package per driver | `@bunvex/persistence-postgres` | rejected: six packages to version together whenever the contract changes |
| B. one package, subpaths, optional peer drivers (Drizzle's pattern) | `@bunvex/persistence/postgres` | **chosen for external databases** |
| C. inside the umbrella package | `bunvex/persistence/postgres` | rejected: every driver change would version the whole product |
| D. selected by configuration | `PERSISTENCE=postgres` | **chosen as the server's interface**, on top of B |
| E. split by kind | memory + SQLite in core | **chosen**: the zero-dependency drivers ship with the engine |

A missing native peer fails at import with a message that names the package to install. Third parties
publish their own `bunvex-persistence-<name>` against the published contract and prove it with
`@bunvex/persistence-conformance`.

**D4 — files**: the `ctx.storage` API lives in `@bunvex/server` (metadata is a system table that goes
through the engine); the bytes go to `@bunvex/file-storage` backends (`/local`, `/s3`), configured with
`FILE_STORAGE=`.

**D5 — the umbrella package `bunvex`** re-exports `bunvex/server`, `bunvex/values`, `bunvex/browser`,
`bunvex/react`, `bunvex/nextjs` and ships the CLI as its `bin`. It contains no logic.

**D6 — dependency rules, enforced in CI** (a check that fails the build on a forbidden import):

```
values ◄── core ◄── persistence          protocol ◄── server ──► core, values, auth, file-storage
                ◄── persistence-conformance            client ──► protocol, values
                ◄── testing ──► server                   react ──► client
cli ──► server, core                                      bunvex ──► re-exports only
```

`core` imports no external database driver, no HTTP and no WebSocket code; the client never imports the
engine; a driver imports only the `Persistence` interface and its native driver.

**D7 — each package's public API is its `exports` map.** Nothing outside a package imports its internal
files; internal modules are free to move.

**D8 — tooling**: TypeScript `strict` with project references (`tsc -b`), Biome (lint + format),
`bun test`, Changesets (per-package versions and changelogs), GitHub Actions (lint, typecheck, tests, the
dependency-rule check, and the conformance suite against SQLite plus Postgres, MySQL and MongoDB as service
containers; benchmarks run outside CI).

**D9 — open-source hygiene**: `README.md`, `ARCHITECTURE.md` (the living map), `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`, issue and PR templates. bunvex is written from scratch;
Convex's code was studied for its DESIGN only and none of it is copied. The README says so.

**D10 — two kinds of documentation**: `docs/specs/` records design decisions for maintainers (this file,
ENGINE-00, PERSIST-01); `apps/docs/` (later) is for people building apps. A question from a user is
answered in the user docs, never by linking a spec.

## 5. Migration plan (pure move)

| step | what | verified by |
|---|---|---|
| 1 | workspace root: `package.json` workspaces, `tsconfig.base.json`, `biome.json` | `bun install` |
| 2 | `packages/core` ← `src/keyenc.ts`, `src/engine.ts` (split into `mvcc`, `committer`, `tx`, `query`, `cache`), `src/subscriptions.ts`, `src/storage.ts` → `persistence/{index,memory,sqlite}` | typecheck |
| 3 | `packages/persistence` ← `src/storage_remote.ts` (split into `postgres`, `mysql`), `src/storage_mongo.ts` → `mongodb`; native drivers become optional peers | typecheck |
| 4 | rename `Storage` → `Persistence`, `STORAGE` → `PERSISTENCE`, STORAGE-01 → PERSIST-01 | grep finds no leftover |
| 5 | `packages/persistence-conformance` ← `bench/conformance.ts` + `bench/drivers.ts` | **K1–K7 green on every driver** |
| 6 | `packages/server` ← `src/server.ts`, the function registry; `packages/protocol` ← the wire messages | typecheck |
| 7 | `bench/` keeps the microbenchmarks and the convex-bench adapters, importing the packages | M1–M4 and the convex-bench HTTP suite within noise of `docs/bench/E2E-*.md` |
| 8 | the dependency-rule check, CI workflows, OSS files, Changesets | CI green on a pull request |

Steps 2–7 move code; none changes it except for imports and the D2 rename. `values`, `client`, `react`,
`auth`, `file-storage`, `cli`, `testing` and the umbrella start as empty packages with their `exports`
map and a README saying what will live there — so the map in ARCHITECTURE.md is true on day one.

## 6. Open decisions (each gets its own spec)

1. **Types**: code generation (`_generated/api`, like Convex) or inference without a codegen step.
2. **Deploying functions**: restart the server, or hot-swap the functions module.
3. **Sandboxing functions**: in-process now with a sandbox later, or a sandbox from the start (Bun
   workers, a separate process).
4. **Search**: text and vector search inside `core`, or a package of their own.
5. ~~Licence~~ — **decided 29 Sep 2026: Apache-2.0** (patent grant, the usual choice for infrastructure;
   Convex's backend uses FSL, which is not an OSI licence). `LICENSE` holds the official text and `NOTICE`
   the copyright line; every published package declares `"license": "Apache-2.0"`.
6. ~~Name and scope~~ — **decided 29 Sep 2026: `bunvex`.** The owner created the `bunvex` organisation on
   npm (for the `@bunvex/*` scope and the `bunvex` package) and on GitHub (`github.com/bunvex`; the
   repository will be `bunvex/bunvex`).

## 7. Amendment — as migrated (29 Sep 2026)

The migration landed as planned (§5), with these differences, now reflected in ARCHITECTURE.md:

- **core modules**: `keyenc`, `schema`, `committer`, `tx` (includes the query builder), `engine` (includes
  the query cache and mutation retries), `subscriptions`, `persistence/{index,memory,sqlite}`. The planned
  `mvcc` / `query` / `cache` split did not earn separate files at this size.
- **The engine executes anonymous transaction bodies** (`engine.query(db => …)`, `engine.mutation(db => …)`);
  naming functions, internal functions and the action context moved to `@bunvex/server` (`functions.ts`).
  Subscriptions take a `publish` callback instead of Bun's server, so core knows no transport.
- **server → persistence**: `@bunvex/persistence` is an OPTIONAL peer of the server, loaded by name when
  `PERSISTENCE=postgres|mysql|mongodb`. The dependency rule records it.
- **D8**: one root `tsconfig.json` (`tsc -p .`, strict) instead of project references; references come
  with a build step for publishing (packages export their TypeScript sources until then).
- **A Bun trap found during the migration**: a file whose first line starts with `// @bun` (e.g.
  `// @bunvex/core — …`) is taken by Bun as its "already transpiled" pragma and loaded as JavaScript —
  every `type` specifier then fails to parse. `check:deps` now refuses such files.
- **Verification**: PERSIST-01 K1–K7 green on all five drivers from the published suite; typecheck strict
  0 errors; the microbenchmarks within noise except the memory M3, whose code path is unchanged (the Mac
  was under load; see the VPS comparison in docs/bench). No commit existed before the migration, so no A/B
  against the old tree was possible — every later step is committed.
