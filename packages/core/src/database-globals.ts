// The database's globals (STUDY-126), as Convex's `_db` (crates/model/src/database_globals): one document
// `{version, awsPrefixSecret, storageType}`, written when the store is first initialized. `storageType` pins
// where the deployment's blobs live: it is null until the first start that sets up storage records it, and
// from then on a start with another kind of storage is refused (a local directory may move).
import { DATABASE_GLOBALS_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

/**
 * The format version of bunvex's stored data, Convex's `DATABASE_VERSION` (crates/migrations_model). bunvex
 * has no migrations yet: it starts at 1, and a store written by a newer bunvex is only warned about.
 */
export const DATABASE_VERSION = 1n;

/** Where the blobs live, as Convex's `StorageType` (serialized with its `tag`). */
export type StorageType = { tag: "s3"; s3Prefix: string } | { tag: "local"; dir: string };
/** What this start was configured with, as Convex's `StorageTagInitializer`. */
export type StorageTagInitializer = { tag: "s3" } | { tag: "local"; dir: string };

export type DatabaseGlobals = {
  _id: string;
  version: bigint;
  /** A prefix for cloud keys "to make them unguessable"; Convex uses it for its Lambda keys. */
  awsPrefixSecret: string;
  storageType: StorageType | null;
};

/** Convex's `database_globals`: the one document, which must exist. */
export async function readDatabaseGlobals(db: Tx): Promise<DatabaseGlobals> {
  const row = (await db.asSystem(() => db.query(DATABASE_GLOBALS_TABLE).first())) as DatabaseGlobals | null;
  if (!row) throw new Error("Database globals were not found??");
  return row;
}

/**
 * Convex's `DatabaseGlobalsModel::initialize`, at the store's first start: the current version, a fresh
 * prefix secret, no storage yet. A store that has the document keeps it. The stored version.
 */
export async function initializeDatabaseGlobals(db: Tx, uuid: () => string): Promise<bigint> {
  const row = (await db.asSystem(() => db.query(DATABASE_GLOBALS_TABLE).first())) as DatabaseGlobals | null;
  if (row) return row.version;
  await db.asSystem(() =>
    db.insert(DATABASE_GLOBALS_TABLE, { version: DATABASE_VERSION, awsPrefixSecret: uuid(), storageType: null }),
  );
  return DATABASE_VERSION;
}

/** A storage type as Convex's error prints it (Rust's `Debug`). */
const describeType = (t: StorageType) =>
  t.tag === "s3" ? `S3 { s3_prefix: ${JSON.stringify(t.s3Prefix)} }` : `Local { dir: ${JSON.stringify(t.dir)} }`;
const describeTag = (t: StorageTagInitializer) => (t.tag === "s3" ? "S3" : `Local { dir: ${JSON.stringify(t.dir)} }`);

/**
 * Convex's `initialize_storage_tag`: the storage this start uses, checked against the one the store was
 * initialized with. The first start records it (S3: a fresh `<instance name>-<uuid>/` key prefix). A local
 * directory that moved is recorded anew; S3 keeps its prefix, which must belong to this instance; any other
 * change (local to S3 or back) is refused.
 */
export async function initializeStorageType(
  db: Tx,
  init: StorageTagInitializer,
  instanceName: string,
  uuid: () => string,
): Promise<StorageType> {
  const globals = await readDatabaseGlobals(db);
  const stored = globals.storageType;
  const record = async (storageType: StorageType) => {
    await db.asSystem(() => db.patch(DATABASE_GLOBALS_TABLE, globals._id, { storageType }));
    return storageType;
  };
  if (stored === null)
    return record(
      init.tag === "s3" ? { tag: "s3", s3Prefix: `${instanceName}-${uuid()}/` } : { tag: "local", dir: init.dir },
    );
  if (init.tag === "local" && stored.tag === "local") {
    if (init.dir === stored.dir) return stored;
    console.info(`Switching storage tag from local dir ${stored.dir} to ${init.dir}`);
    return record({ tag: "local", dir: init.dir });
  }
  if (init.tag === "s3" && stored.tag === "s3") {
    if (!stored.s3Prefix.startsWith(`${instanceName}-`))
      throw new Error(`Cannot use s3 storage path ${stored.s3Prefix} with ${instanceName}`);
    return stored;
  }
  throw new Error(
    `Database was initialized with Some(${describeType(stored)}), but backend started up with ${describeTag(init)}.`,
  );
}
