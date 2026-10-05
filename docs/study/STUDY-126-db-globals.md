# STUDY-126 — `_db`, the database globals

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-32](STUDY-32-file-storage.md) (file storage, S3), [STUDY-38](STUDY-38-docker.md) (K4: S3 per use
  case), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md) (the local backend's flags),
  [STUDY-17](STUDY-17-paginate.md) (D2: `_instance`, DV-07)

## 1. How Convex does it

`crates/model/src/database_globals/` defines the system table `_db` (`DATABASE_GLOBALS_TABLE`), with no index
but `by_id` / `by_creation_time`. Its number is `DefaultTableNumber::DatabaseGlobals = 8`, so 520
(`crates/model/src/lib.rs`, 512 + n). It is in `app_system_tables()` and loaded in memory
(`APP_TABLES_TO_LOAD_IN_MEMORY`).

It holds one document, `DatabaseGlobals` (`types.rs`), serialized in camelCase:

| Field | Type | What |
|---|---|---|
| `version` | int64 | the data's migration version (`migrations_model::DATABASE_VERSION`, 133 at this commit) |
| `awsPrefixSecret` | string | a v4 UUID, "prefix to put on the aws bucket/lambda keys to make it unguessable" |
| `storageType` | `null`, `{tag: "s3", s3Prefix}` or `{tag: "local", dir}` | the storage the deployment was initialized with |

**Written when.** `initialize_application_system_tables` (`model/src/lib.rs:420-445`) creates `_db` at the
store's first start and, only when the table is new, calls `DatabaseGlobalsModel::initialize(DATABASE_VERSION)`:
`{version, awsPrefixSecret: new_uuid_v4(), storageType: None}`.

**Storage pinning.** `Application::initialize_storage` (`application/src/lib.rs:669-680`) runs at every start, in
its own transaction (`"init_storage"`), before any storage is made. It calls
`DatabaseGlobalsModel::initialize_storage_tag(initializer, deployment_name)`. The initializer is
`StorageTagInitializer::S3` with `--s3-storage`, else `Local { dir: --local-storage }`
(`local_backend/src/config.rs:253`). The model:

- no storage recorded: records it. S3 gets the prefix `format!("{instance_name}-{uuid}/")`; local records the
  directory as given (`to_string_lossy`);
- local, recorded local: a different directory is recorded anew (`tracing::info!("Switching storage tag from
  local dir {old} to {new}")`), the same one is kept;
- S3, recorded S3: the recorded prefix is kept, but it must start with `{instance_name}-`, else
  `"Cannot use s3 storage path {s3_prefix} with {instance_name}"`;
- anything else (local ↔ S3) fails the start: `"Database was initialized with {db_storage_type:?}, but backend
  started up with {storage_tag:?}."` (Rust `Debug`: `Some(Local { dir: "…" })`, `S3`).

`create_storage` then makes every use case (files, modules, search, exports, snapshot imports) from the one
storage type: S3 with the recorded prefix, or the local directory.

**Read by.** The migration worker (`model/src/migrations.rs:80-125`) reads `version` at start and migrates one
version at a time to `DATABASE_VERSION`, writing `version` after each; a version ahead of the binary's only
logs `"persisted db metadata version is ahead at {v}, this binary is at {DATABASE_VERSION}"`. The beacon
(`local_backend/src/beacon.rs`) sends `version` and uses the document's id as the deployment's UUID.
`awsPrefixSecret` is read by Convex's cloud Lambda code only.

## 2. What an app can observe

Nothing: `_db` is private (no `db.system` access) and not in exports. Operators observe the storage pinning:
a store first started with local storage refuses to start with `--s3-storage` (and back), and an S3 store
refuses another instance name. The S3 keys are under `<instance name>-<uuid>/`.

## 3. How bunvex does it

Before this study bunvex kept the S3 key prefix (`bunvex-<uuid>/`) in its own `_instance`
(`Engine.instanceSetting("s3Prefix")`) and did not pin the storage type. Now:

- `@bunvex/core` `database-globals.ts`: `_db` with Convex's number (520) and document. `Engine.init` writes it
  at the store's first start (`initializeDatabaseGlobals`), after the catalog is reconciled; a stored version
  above bunvex's logs Convex's warning.
- `Engine.initializeStorage(initializer)` is Convex's `initialize_storage_tag`, with its four cases and
  messages.
- `bunvex-local-backend` (and the Docker image, which runs it) calls it at every start, after `init`, with
  `--s3-storage` → S3, else `Local { dir: --local-storage }` as given; a refused start closes the store and
  exits 1 with the message. Its S3 stores use the recorded prefix.
- `createServer`'s stores made from the environment (an embedding app, tests) record S3 on their first S3
  operation; they have no single local directory to pin, so a local store is not recorded there.
- `_instance` keeps the instance secret and name (DV-07, DV-159) and nothing else. Convex's `_db` has no name;
  its self-hosted image keeps the name with the secret, in its credentials. The owner decided the name stays with
  the secret in `_instance` (2026-10-05, G4).

`version` is bunvex's own data version, `DATABASE_VERSION = 1n` (`database-globals.ts`): bunvex has no
migrations yet, and Convex's number counts Convex's migrations, not bunvex's format. `awsPrefixSecret` is
written and not read, as in a self-hosted Convex.

Under STUDY-38 K4 a use case with no bucket stays local even with `--s3-storage`; the pin is the deployment's
kind of storage, as Convex's: S3 with `--s3-storage`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| G1 (DV-403) | Was: the S3 prefix `bunvex-<uuid>/` in `_instance`, no pin. Now as Convex: `_db` (520), `<instance name>-<uuid>/`, the pin and its messages | match Convex's internal system tables; no legacy data | owner, 2026-10-05: match Convex |
| G2 | `version` starts at 1 (bunvex's data version), not Convex's 133 | the number counts each system's own migrations; no app or operator sees it | not a behaviour difference; noted |
| G4 (DV-403) | The instance name stays in `_instance` with the secret, not in `_db` | Convex's `_db` has no name field; its self-hosted image keeps name and secret together (DV-159) | owner, 2026-10-05: keep it in `_instance` |
| G3 | `createServer`'s environment stores record S3 at first use and never pin local | an embedded server has no one local directory flag; the shipped backend pins at start | follows from K4 and the library API; noted |

## 5. Tests

`packages/core/test/database-globals.test.ts`: the document at first start (number 520, `version` an int64,
a v4 `awsPrefixSecret`, `storageType: null`) and kept across restarts; `_instance` has only the secret and the
name; S3 recorded with `<instance name>-<uuid>/` and kept; a moved local directory recorded; local ↔ S3 refused
with Convex's text both ways; another instance name refused for an S3 prefix.
`packages/server/test/local-backend.test.ts`: a store started local refuses `--s3-storage` with Convex's
message, and starts again local afterwards.

Sabotage (each applied alone, then restored):

| Change | Result |
|---|---|
| prefix `bunvex-<uuid>/` instead of `<instance name>-<uuid>/` | 1 test fails (S3 recorded) |
| `storageType` initialized to a local value | 6 tests fail |
| a moved local directory not recorded | 1 test fails |
| an S3 start accepted over a local store | 2 tests fail (core and local backend) |
| `_db` numbered 9997 | 1 test fails |

## 6. Open questions

None.
