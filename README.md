# bunvex

> **Experimental — changes constantly, not for production. For real projects, use [Convex](https://convex.dev).** See [the warning below](#status).

A [Convex](https://convex.dev)-style reactive backend written in TypeScript for [Bun](https://bun.sh), with
**its own database engine** on top of a pluggable persistence layer.

- **Reactive queries** — clients subscribe to query functions; a commit re-runs exactly the subscriptions
  whose read-set it touches and pushes the new result.
- **Serializable transactions** — mutations run as optimistic transactions validated by a single
  committer: no lost updates, no false conflicts between writes to different documents.
- **Pluggable persistence** — the engine keeps every document version and index entry in an ordered,
  versioned store: **memory + log**, **SQLite** (built in), **Postgres**, **MySQL**, **MongoDB**. Each
  driver must pass a public conformance suite, so you can write your own.

## Status

> [!WARNING]
> **bunvex is an experimental project. Do not use it for anything that matters.**
>
> - It changes all the time: APIs, storage formats, wire protocol and behaviour can break between any two
>   commits, with no migration path and no deprecation period.
> - It is not supported, not audited and not run in production by anyone. Data loss and security bugs are
>   possible.
> - **For a real or professional project, use [Convex](https://convex.dev)**: the original, maintained,
>   supported product that bunvex studies and imitates.

**Status: pre-alpha.** The engine, the persistence drivers, the server (HTTP API, WebSocket sync,
validation, auth, the scheduler and crons, file storage, HTTP actions), the client SDK with its React and
Next.js bindings, and the CLI work; the hot paths are benchmarked. Components, built-in authentication and
the dashboard on a real deployment are still to come. See [ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/parity/](docs/parity/README.md) for what exists and what is planned.

## Numbers

Same 2-vCPU VPS, same harness, Convex self-hosted vs bunvex on **the same Postgres**, both measured on
5 Oct 2026 ([full report](docs/bench/E2E-VPS-2026-10-05.md)):

| | Convex | bunvex (Postgres) | bunvex (SQLite) |
|---|--:|--:|--:|
| uncached indexed read, req/s | 282 | 1 337 | 1 787 |
| durable insert, req/s | 406 | 3 281 | 2 494 |
| action (query + mutation), req/s | 134 | 1 159 | 1 544 |
| 10 000 subscribers, splay off¹, delivered · p99 | out of memory (6.7 GB) | 100 % · 1.57 s | 100 % · 825 ms |

¹ Both spread wide invalidations by default (bunvex as Convex does), which skips intermediate values alike;
the row compares them with that off (Convex's `raw` profile, measured 29 Sep).

## Repository layout

| path | what |
|---|---|
| `packages/values` | validators, ids, value types (`@bunvex/values`) |
| `packages/core` | the engine (`@bunvex/core`), including the memory and SQLite drivers |
| `packages/search` | full-text and vector search: tokenizer, BM25, segments (`@bunvex/search`) |
| `packages/persistence` | Postgres, MySQL and MongoDB drivers (`@bunvex/persistence/*`) |
| `packages/persistence-conformance` | the PERSIST-01 suite every driver must pass |
| `packages/server` | function runtime, HTTP API, WebSocket sync, scheduler, storage (`@bunvex/server`) |
| `packages/protocol` | wire messages |
| `packages/auth`, `packages/file-storage` | JWT / OIDC verification for `ctx.auth`; the bytes behind `ctx.storage` (local disk, S3) |
| `packages/client` | the sync client: WebSocket, optimistic updates, pagination, HTTP client (`@bunvex/client`) |
| `packages/react`, `nextjs`, `react-clerk`, `react-auth0`, `react-query` | React bindings, Next.js server rendering, Clerk and Auth0 providers, TanStack Query |
| `packages/cli` | the `bunvex` command line: dev, deploy, codegen, run, env, import/export, logs, mcp (`@bunvex/cli`) |
| `packages/bunvex` | the package an app installs (`bunvex/server`, …) |
| `packages/ui`, `packages/dashboard`, `apps/dashboard` | the design system and the dashboard (on mock data for now) |
| `packages/testing`, `sync-e2e`, `jepsen`, `differential` | test helpers and test suites (not published) |
| `apps/site` | [bunvex.dev](https://bunvex.dev), the website (landing now, user docs later) |
| `examples/` | one-feature example apps ([examples/README.md](examples/README.md)) |
| `docker/` | the self-hosted image and compose file ([docker/README.md](docker/README.md)) |
| `bench/` | benchmarks, the conformance runner, the convex-bench adapter |
| `docs/specs/` | design records |
| `docs/study/`, `docs/parity/`, `docs/bench/` | studies of Convex, the parity inventory, benchmark reports |

The full map, with status and dependency rules, is [ARCHITECTURE.md](ARCHITECTURE.md).

## Development

```sh
bun install
bun run check          # lint, typecheck, dependency rules, tests, dashboard and site builds
bun run conformance    # PERSIST-01 on memory + SQLite (+ PG_URL / MYSQL_URL / MONGO_URL when set;
                       #   MongoDB must be a replica set — a single-node one is enough;
                       #   DO_NOT_REQUIRE_SSL=1 for a local Postgres/MySQL without verifiable TLS)

PERSISTENCE=sqlite bun bench/server.ts   # a server with the benchmark functions on :3210
```

### Choosing the database

| Variable | Meaning |
|---|---|
| `PERSISTENCE` | `memory` (default), `sqlite`, `postgres`, `mysql` or `mongodb` |
| `PERSISTENCE_URL` | the URL for `postgres`, `mysql` and `mongodb`. For Postgres and MySQL, a URL without a database connects to the instance name's (`-` replaced by `_`), as Convex; a URL that names one keeps it |
| `POSTGRES_URL`, `MYSQL_URL`, `DATABASE_URL` | Convex's names, accepted too: without `PERSISTENCE`, the first one set selects Postgres, MySQL or (deprecated) Postgres. bunvex's names win when both are set. Unlike Convex, a URL that names a database is accepted and kept |
| `DO_NOT_REQUIRE_SSL` | any non-empty value: connect to Postgres/MySQL without requiring TLS. By default, as Convex, the connection must be encrypted and the server's certificate verified (chain and host name); a Postgres connection must also be read-write (never a standby) |
| `PG_CA_FILE`, `MYSQL_CA_FILE` | a PEM file with the CA that signed the server's certificate, trusted besides the built-in roots |

MongoDB's TLS is what its URL says (`tls=true`).

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Relationship to Convex

bunvex is an independent implementation written from scratch. Its design was informed by studying the
public architecture of Convex; no Convex source code is included. It is not affiliated with or endorsed
by Convex, Inc. "Convex" is a trademark of Convex, Inc., used here only to describe compatibility.

Contributors study Convex's source to match its behaviour, and cite the files they read
([docs/study/](docs/study/README.md)). Nothing is copied from it.

## License

[Apache-2.0](LICENSE)
