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

## Gotchas

- Never start a source file with `// @bun…`: Bun reads it as its "already transpiled" pragma and loads the
  TypeScript as JavaScript. `check:deps` refuses it.

By contributing you agree that your contributions are licensed under the Apache License 2.0.
