# Upgrading a bunvex deployment

How to move a self-hosted bunvex deployment to a new release, and how to move an app between Convex and bunvex.
It follows Convex's own guide ([`self-hosted/advanced/upgrading.md`](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/upgrading.md)),
with what is different in bunvex.

> [!WARNING]
> **bunvex is an alpha** ([Status](../README.md#status)). Storage formats and behaviour can change between any
> two releases, and bunvex carries no compatibility with stores or formats written by older bunvex releases
> ([STUDY-139](study/STUDY-139-product-and-oracle.md)). **Take an export before every upgrade**, and keep it until
> the new release has served your app for a while. Do not keep data in bunvex that you cannot afford to lose.

## 1. Before you start

1. **Read what changed.** Each published package has a `CHANGELOG.md` (for example
   [`packages/bunvex/CHANGELOG.md`](../packages/bunvex/CHANGELOG.md), [`packages/server/CHANGELOG.md`](../packages/server/CHANGELOG.md)),
   and each backend executable is a GitHub release `precompiled-<date>-<sha>`.
2. **Export the deployment, with its files** (§4):

   ```sh
   bunvex export --path ./backups --include-file-storage
   ```

   An export is a snapshot at one point in time: what is written after it is not in it.
3. **Save the environment variables**, which an export does not contain:

   ```sh
   bunvex env list --include-values > ./backups/env.txt
   ```

4. **Keep the instance's name and secret.** The admin keys and the signed pagination cursors are derived from the
   secret, and an S3 key prefix belongs to the instance name (a start with another name is refused: "Cannot use s3
   storage path … with …", [STUDY-126](study/STUDY-126-db-globals.md)). The Docker image keeps both in its volume
   (`credentials/`); with the executable, pass the same `--instance-name` and `INSTANCE_SECRET` (or `--instance-secret`) again.

## 2. Upgrade the packages and the server together

bunvex is one product: its client, CLI and server are released together with one version (`0.1.0-alpha.1` today).
Run your app's packages and the server at the **same release**: the server does not refuse a client of another
version (it has no version thresholds, STUDY-139 P2), but nothing tests one release's client against another's
server.

**The npm packages.** Upgrade every `@bunvex/*` package your app depends on (`@bunvex/server`, `@bunvex/values`,
`@bunvex/react`, `@bunvex/cli`, …) together to the new version, then push the functions again, so the new CLI
regenerates `_generated/` and bundles them:

```sh
bun add @bunvex/server@<version> @bunvex/values@<version>   # and every other @bunvex/* dependency
bun add -d @bunvex/cli@<version>
bunx bunvex deploy
```

**The server.** Pick one:

- **Docker** ([docker/README.md](../docker/README.md)): rebuild the image from the new release's checkout
  (`docker compose build`), or point `BUNVEX_IMAGE` at the published `ghcr.io/bunvex/bunvex-backend:<sha>` (`:latest`
  follows `main`), then `docker compose up -d`. The volume keeps the database, the files, the pushed code and the
  credentials.
- **The executable**: download `bunvex-local-backend-<target>.zip` from the new release, stop the old process
  (SIGINT or SIGTERM: it finishes and releases the store), and start the new one with the same flags.

Then deploy the functions again with the new CLI (above), and check the app.

**A local deployment** (`bunvex dev` without a URL, which runs `bunvex-local-backend` for the project): when a newer
release exists, `bunvex dev` asks "This deployment is using an older version of the bunvex backend. Upgrade now?"
before using it (`--local-force-upgrade` without asking; `--local-backend-version <precompiled-…>` pins one), as
Convex's CLI does (`packages/cli/src/local-deployment.ts`). Its store follows §3 like any other.

## 3. What happens to the stored data

Every store records the version of its data in `_db` (`{version, awsPrefixSecret, storageType}`), as Convex's
`DATABASE_VERSION` ([STUDY-126](study/STUDY-126-db-globals.md), [STUDY-133](study/STUDY-133-persistence-layout-identical.md)
Q8, DV-418). bunvex's is Convex's, **134**, and bunvex ports none of Convex's migrations (DV-56). At each start,
before anything is written to the store (`packages/core/src/database-globals.ts`, `engine.ts`):

| The store's `_db.version` | What bunvex does |
|---|---|
| 134 (this release's) | opens it |
| higher (a newer bunvex, or a newer Convex) | opens it with Convex's warning: `persisted db metadata version is ahead at <n>, this binary is at 134` |
| lower | refuses it, untouched (`LayoutError`): "the store's data is at version <n> …; this bunvex reads version 134 and has no migrations from older versions" |

The tables themselves are checked too: an open finds Convex's columns in `documents`, `indexes` and
`persistence_globals` (or, on MongoDB, its analogue; the memory log checks its file header), and refuses anything
else untouched, an older bunvex layout included (PERSIST-01 C10, `packages/core/src/persistence/layout.ts`).

So, unlike Convex, **there is no in-place upgrade across a format change** (Convex's option 1, its migration
worker's `Executing Migration 114/115` log lines, has no counterpart). If the new release refuses your store, or if
its changelog says the stored format changed, use the export and import of §4. That includes a release in which
bunvex follows Convex to a new `DATABASE_VERSION` ([upstream.md](parity/upstream.md)), as the move to 134
([STUDY-193](study/STUDY-193-convex-upstream-04d2f3b.md) A14) did: it refuses stores at 133. Moving back to an older release
after a newer one wrote to the store is not tested: restore your export instead.

Also kept from Convex: the storage kind is pinned at the first start (`_db.storageType`). A start with S3 on a
store that used a local directory, or the reverse, is refused ("Database was initialized with …, but backend
started up with …"); a local directory may move. To switch, export and import, as Convex's
[`s3_storage.md`](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md) says.

## 4. Export, then import

The path that works between any two releases, and Convex's option 2. It needs downtime: stop the traffic first, so
the final export has everything.

1. Stop the traffic to the backend.
2. Export with the **old** release, files included, and save the environment variables:

   ```sh
   bunvex export --path ./backups --include-file-storage
   bunvex env list --include-values > ./backups/env.txt
   ```

3. Start the **new** release on an empty database (a new SQLite file, a new Postgres/MySQL database or MongoDB
   database) and a new storage directory or S3 prefix.
4. Deploy the app with the new CLI (`bunvex deploy`), and set its variables again (`bunvex env set NAME value`).
5. Import:

   ```sh
   bunvex import --replace-all ./backups/snapshot_<…>.zip
   ```

   Every table comes back with its documents' ids and creation times, `_storage` with its files' ids, checksums
   and bytes ([STUDY-42](study/STUDY-42-import-export.md)). Every index, the search and vector indexes included,
   is built again from the imported documents.
6. Bring the traffic back.

What an export does not carry, as Convex's: the environment variables (step 4), the pushed code (step 4), and the
system tables, so the scheduled functions waiting to run too. It holds the app's tables and, with
`--include-file-storage`, the files (`packages/server/src/exports.ts`). An export takes as long as the data; try one while the old release is up to
see how long the downtime will be.

## 5. Moving between Convex and bunvex

### Export and import: the supported way

Moving an app **from Convex to bunvex** is an export from Convex and an import into bunvex
([STUDY-139](study/STUDY-139-product-and-oracle.md) §1, §3). A test runs exactly this against the Convex binary
(`packages/differential/test/export-import.test.ts`): `npx convex export --include-file-storage` from Convex, then
`bunvex import --replace-all` into bunvex with the same app deployed, and every document, index read and file must
come back.

1. Change the app: install the `@bunvex/*` packages in place of `convex` (`bun add @bunvex/server @bunvex/values`,
   `@bunvex/react` and the others you use; `bun add -d @bunvex/cli`), import `@bunvex/server`, `@bunvex/react`, …
   instead of `convex/server`, `convex/react`, …; run `bunx bunvex` instead of `npx convex`. bunvex looks for the functions in `bunvex/` (keep `convex/` with
   `{ "functions": "convex" }` in `bunvex.json`), and for `BUNVEX_SELF_HOSTED_URL` / `BUNVEX_SELF_HOSTED_ADMIN_KEY`.
2. `npx convex export --path ./backups --include-file-storage` on the Convex deployment, and save its variables
   (`npx convex env list --include-values > .env.convex`).
3. Start bunvex on an empty store, `bunx bunvex deploy`, set the variables, then
   `bunx bunvex import --replace-all ./backups/snapshot_<…>.zip`.

What does not import: an app with **components** (bunvex has none yet, DV-55: a ZIP with `_components/…` is
refused, X1 of STUDY-42), and Convex's legacy inferred-schema ZIP encoding (DV-219; Convex at bunvex's reference
writes the current one). Moving **from bunvex to Convex** is the same path the other way round: `bunvex export`
writes Convex's ZIP format (STUDY-42 §2), which `npx convex import --replace-all` takes. No automated test covers
that direction yet.

### Opening the other system's store (cross-open)

bunvex keeps its stores in Convex's exact layout ([STUDY-133](study/STUDY-133-persistence-layout-identical.md)), so
a store the Convex binary wrote opens in bunvex, and a bunvex store opens in Convex. This is how bunvex is
validated against Convex (`packages/differential/test/cross-open.test.ts`, both ways, on SQLite; Postgres and MySQL
checked by hand). **It is not a production recommendation** (STUDY-139 §1.1): use export and import to move a real
app.

What crosses over:

- **SQLite, Postgres and MySQL** stores, both ways: the documents, their history, the database indexes, the system
  tables (files' metadata, scheduled jobs, environment variables, schemas, …) and the files (the same storage
  directory or bucket). MySQL documents in Convex's compressed v1 encoding are read (DV-414). The `_db.version`
  rule of §3 applies: a Convex store below 133 is refused; start it on a Convex release at 133 or later first,
  which migrates it.
- Give the other backend the same instance name and secret, the same database (SQLite: pass the file, since the
  default names differ: `convex_local_backend.sqlite3`, `bunvex_local_backend.sqlite3`; the Docker images both use
  `<data>/db.sqlite3` and `<data>/storage`), and the same storage (`--local-storage <dir>`, or the same S3 buckets).

What is rebuilt:

- **Search and vector indexes.** Neither system reads the other's segments (Convex's Tantivy and Qdrant archives,
  bunvex's own format, STUDY-111). bunvex writes those `_index` rows as `backfilling` and keeps its segments in a
  global of its own, so each side builds the indexes again from the table after a cross-open (DV-415); their
  queries wait for the build.

What does not cross over:

- **The deployed code.** Each system bundles functions for its own runtime, so neither runs the other's bundles
  (STUDY-133 §6.4). Deploy the app again with the target's CLI right after the start (`bunvex deploy`, or
  `npx convex deploy`); until then function calls fail as on a deployment with no code. Convex's push also enables
  the search indexes it rebuilt.
- **Components.** bunvex has none (DV-55): do not cross-open a store whose app uses them.
- **MongoDB** and **memory-log** stores: Convex has neither; they move by export and import only.
- **Running both at once.** A Convex process and a bunvex process on the same SQLite file both write (Convex takes
  no lock; bunvex's `.lock` file protects bunvex from bunvex only, DV-411, DV-412). On Postgres and MySQL they share
  Convex's `leases` row, so the newest process wins and the other stops at its next write (DV-413). Stop one before
  starting the other.

## See also

- [docker/README.md](../docker/README.md): running the image, its volume and variables.
- [STUDY-42](study/STUDY-42-import-export.md): import and export.
- [STUDY-133](study/STUDY-133-persistence-layout-identical.md): the persisted layout and the cross-open.
- [STUDY-139](study/STUDY-139-product-and-oracle.md): bunvex as its own product; migration by export and import.
- [docs/parity/divergences.md](parity/divergences.md): every difference from Convex.
