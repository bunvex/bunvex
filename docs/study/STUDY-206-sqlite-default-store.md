# STUDY-206 — SQLite as the default store of an embedded server
<!-- index: The store `persistenceConfigFromEnv` picks with nothing set becomes SQLite, as Convex's, instead of memory+log (audit decision 1); a directory holding a memory log and no SQLite file is refused instead of opened empty | implemented -->

The 2026-11-03 production audit asked which store bunvex should use when none is configured. On 2026-11-04 the
owner chose SQLite, as Convex does (decision 1). The B5 fixes (#1038) had just shown how much the memory driver's
own log has to get right. On SQLite, SQLite carries that weight.

## 1. How Convex does it

Every Convex backend stores in SQLite unless a database URL is given:

- **The self-hosted image** (`self-hosted/docker-build/run_backend.sh:6,30`): `SQLITE_DB` defaults to
  `$DATA_DIR/db.sqlite3`. `POSTGRES_URL`, `MYSQL_URL` or `DATABASE_URL` replace it.
- **The local backend** (`crates/local_backend/src/config.rs:30`): the `db_spec` argument defaults to
  `convex_local_backend.sqlite3`, and `--db` defaults to SQLite.

Convex has no in-memory store and no embedded server.

## 2. What apps observe

bunvex already defaulted to SQLite everywhere Convex has a counterpart:

- the Docker image (`docker/run_backend.sh`);
- the `bunvex-local-backend` executable and `bunvex dev` (`packages/server/src/local-backend.ts:216`).

One place picked memory+log: `persistenceConfigFromEnv` (`packages/server/src/persistence.ts`), the configuration
an app embedding `createServer` reads, and with it `bench/server.ts` and `bunvex admin-key`. With no `PERSISTENCE`
and no database URL, such a server wrote `$DATA/bunvex.log` (default `./.data`). The data is the same either way.
What differs is how the file is kept: SQLite's journal and pages, against bunvex's own append-only log.

## 3. How bunvex does it now

- `persistenceConfigFromEnv` with nothing set returns `kind: "sqlite"`, so the store is `$DATA/bunvex.sqlite`.
  `PERSISTENCE=memory` still selects memory+log, for development and tests. `PERSISTENCE_URL` alone still selects
  nothing.
- **An older default store is not replaced by an empty one.** A server that ran with the old default has
  `$DATA/bunvex.log`. After an upgrade, opening `$DATA/bunvex.sqlite` would show an empty deployment, and the app
  would start writing to it as if its data were gone. So `openPersistence` refuses that case: when the SQLite
  default was implied (`PERSISTENCE` unset), the directory holds `bunvex.log` and no `bunvex.sqlite`, it fails
  with this message, before creating any file:

  > `found a memory store at <dir>/bunvex.log and no SQLite file: SQLite is now the default store. Set
  > PERSISTENCE=memory to keep using this one, or export it (bunvex export) and import it into SQLite`

  This is the one conversion path bunvex offers, as CLAUDE.md says: export, then import. bunvex does not read the
  old store in its place. An explicit `PERSISTENCE=sqlite` is not checked, because the operator chose it.
- The config records whether the driver was implied (`implied: true`). Only `openPersistence` reads it.

## 4. Divergences

None remain. Defaulting to memory was never recorded as a divergence. The platform row "Database selection"
(docs/parity/platform.md) now says SQLite is the default everywhere. The refusal above has no Convex counterpart,
because Convex never had another default. It guards bunvex's own earlier versions and opens nothing they wrote.
