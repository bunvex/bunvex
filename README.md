# bunvex

A [Convex](https://convex.dev)-style reactive backend written in TypeScript for [Bun](https://bun.sh), with
**its own database engine** on top of a pluggable persistence layer.

- **Reactive queries** — clients subscribe to query functions; a commit re-runs exactly the subscriptions
  whose read-set it touches and pushes the new result.
- **Serializable transactions** — mutations run as optimistic transactions validated by a single
  committer: no lost updates, no false conflicts between writes to different documents.
- **Pluggable persistence** — the engine keeps every document version and index entry in an ordered,
  versioned store: **memory + log**, **SQLite** (built in), **Postgres**, **MySQL**, **MongoDB**. Each
  driver must pass a public conformance suite, so you can write your own.

> **Status: pre-alpha.** The engine, the persistence drivers, the HTTP API and WebSocket subscriptions
> work and are benchmarked; the client SDK, validation, auth, the scheduler and the CLI are still to come.
> See [ARCHITECTURE.md](ARCHITECTURE.md) for what exists and what is planned. Not for production yet.

## Numbers

Same 2-vCPU VPS, same harness, Convex self-hosted vs bunvex on **the same Postgres**
([full report](docs/bench/E2E-VPS-2026-09-29.md)):

| | Convex | bunvex (Postgres) | bunvex (memory + log) |
|---|--:|--:|--:|
| uncached indexed read, req/s | 298 | 2 119 | 6 067 |
| durable insert, req/s | 427 | 6 052 | 7 744 |
| action (query + mutation), req/s | 139 | 2 492 | 6 043 |
| 10 000 subscribers, delivered · p99 | 5 % · 3.2 s | 100 % · 220 ms | 100 % · 267 ms |

## Repository layout

| path | what |
|---|---|
| `packages/core` | the engine (`@bunvex/core`), including the memory and SQLite drivers |
| `packages/persistence` | Postgres, MySQL and MongoDB drivers (`@bunvex/persistence/*`) |
| `packages/persistence-conformance` | the PERSIST-01 suite every driver must pass |
| `packages/server` | function runtime, HTTP API, WebSocket sync (`@bunvex/server`) |
| `packages/protocol` | wire messages |
| `packages/bunvex` | the package an app installs (`bunvex/server`, …) |
| `bench/` | benchmarks, the conformance runner, the convex-bench adapter |
| `docs/specs/` | design records |

The full map, with status and dependency rules, is [ARCHITECTURE.md](ARCHITECTURE.md).

## Development

```sh
bun install
bun run check          # lint, typecheck, dependency rules, tests
bun run conformance    # PERSIST-01 on memory + SQLite (+ PG_URL / MYSQL_URL / MONGO_URL when set)

PERSISTENCE=sqlite bun bench/server.ts   # a server with the benchmark functions on :3210
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Relationship to Convex

bunvex is an independent implementation written from scratch. Its design was informed by studying the
public architecture of Convex; no Convex source code is included. It is not affiliated with or endorsed
by Convex, Inc. "Convex" is a trademark of Convex, Inc., used here only to describe compatibility.

Contributors study Convex's source to match its behaviour, and cite the files they read
([docs/study/](docs/study/README.md)). Nothing is copied from it.

## License

[Apache-2.0](LICENSE)
