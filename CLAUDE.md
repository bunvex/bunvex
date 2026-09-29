# bunvex — notes for AI coding sessions

bunvex is a **rewrite of Convex for Bun**. An app must behave the same on bunvex as on Convex, with
deliberate, documented differences only. Read [ARCHITECTURE.md](ARCHITECTURE.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## Study Convex before implementing

- The Convex source is the primary reference. Locally it is cloned at `../convex-backend`; otherwise use
  github.com/get-convex/convex-backend.
  - Backend: `crates/` (database, isolate, application, value, …).
  - Client and function API: `npm-packages/convex`.
- Before implementing any feature Convex has, write or update a study in `docs/study/STUDY-NN-<topic>.md`
  (see [docs/study/README.md](docs/study/README.md)). It covers:
  - how Convex does it, citing files;
  - what apps observe;
  - how bunvex does it;
  - the divergences.
- Match Convex by default. **Ask the owner about every divergence** instead of deciding it yourself.
- [docs/parity/](docs/parity/README.md) lists everything Convex has and bunvex's status on each item.
  Update the matching rows in every PR that adds or changes a Convex feature; the roadmap is there too.
- Never copy Convex code; write bunvex's version from scratch.

## Conventions

- Everything in the repo is in English: code, docs, commits and PRs.
- `main` is protected. Use one branch and one PR per concern; the owner merges.
  - CI must pass: lint, typecheck, dependency rules and tests, plus PERSIST-01 conformance on Postgres,
    MySQL and MongoDB.
- `bun run check` before pushing.
  - A behaviour change comes with tests, and with a sabotage check: break the fix and watch the test fail.
  - A change that can affect performance comes with a measurement.
- Never start a source file with `// @bun…` (Bun's pre-transpiled pragma).
