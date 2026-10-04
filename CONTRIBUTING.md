# Contributing to bunvex

Thanks for helping. bunvex is pre-alpha: expect things to move, and please open an issue before a large
change so we can agree on the design first.

## Setup

```sh
bun install            # Bun 1.4+
bun run check          # lint (Biome), typecheck (tsc strict), dependency rules, tests
```

## Where things live

Read [ARCHITECTURE.md](ARCHITECTURE.md) first: it maps every package, what it may depend on, and what is
done or planned. The dependency rules are enforced by `bun run check:deps` — a pull request that breaks
one fails CI.

bunvex is a rewrite of Convex: an app should behave the same on both. **Before implementing a feature
Convex has, study how Convex does it in its source and write it up** in [`docs/study/`](docs/study/)
(the rule and the template are in its README). Divergences from Convex are decided by the owner.
The full inventory of Convex's features and bunvex's status is [`docs/parity/`](docs/parity/README.md);
update its rows in the PR that changes them.

bunvex's own code never says "convex" outside comments: no identifier, exported name, string, error message
or URL may contain it (`check:deps` rule 5). Cite Convex in comments and in `docs/study/`; name things, and
word messages, as bunvex. There are no exceptions: wire names (a `format` value, a metric, an error code)
are bunvex's too, since the clients that talk to bunvex are bunvex's (owner, 2026-10-03: DV-307, DV-308,
DV-312).

Design decisions are recorded in [`docs/specs/`](docs/specs/). A change to the engine's guarantees, the
persistence contract or the package layout starts with a spec (or an amendment to one).

## Pull requests

- Keep a PR to one concern. Update ARCHITECTURE.md in the same PR when you change what a package contains
  or its status.
- Tests for the behaviour you change. For a bug, a test that fails before the fix — and check that it
  can fail (break the fix and watch it go red).
- Add a changeset (`bunx changeset`) for any change to a published package.
- A change that can affect performance comes with a before/after measurement (`bench/`).

## Persistence drivers

A new driver implements the `Persistence` interface from `@bunvex/core/persistence` and must pass
`@bunvex/persistence-conformance` (see [PERSIST-01](docs/specs/PERSIST-01-contract.md)). Third-party
drivers are welcome as their own packages (`bunvex-persistence-<name>`).

Postgres and MySQL connections require TLS and a verifiable certificate by default, as Convex (STUDY-25
L8). A local or CI database usually has neither: run the conformance suite and the bench against one with
`DO_NOT_REQUIRE_SSL=1` (CI does). The TLS behaviour itself is tested against real servers by
`packages/persistence/test/tls-db.test.ts` (its header lists the variables that point it at them).

## Gotchas

- Never start a source file with `// @bun…`: Bun reads it as its "already transpiled" pragma and loads the
  TypeScript as JavaScript. `check:deps` refuses it.

By contributing you agree that your contributions are licensed under the Apache License 2.0.
