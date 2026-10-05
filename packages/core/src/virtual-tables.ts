// Virtual system tables (STUDY-125), as Convex's `VirtualSystemMapping` (crates/common/src/
// virtual_system_mapping.rs, crates/database/src/virtual_tables) and its doc mappers
// (crates/model/src/file_storage/virtual_table.rs, crates/model/src/scheduled_jobs/virtual_table.rs):
//
// - A virtual table has no table of its own. Its PRIMARY system table holds its documents, ids, number and
//   indexes: `_storage` is `_file_storage`, `_scheduled_functions` is `_scheduled_jobs`. A virtual document's
//   `_id` and `_creationTime` are the system document's, so an id is the same string either way.
// - Apps reach them only through `db.system` (system-reader.ts), which reads the system table and maps each
//   document to the virtual shape before any filter runs: filters see the virtual fields, as on Convex.
// - Only `by_id` and `by_creation_time` exist on a virtual table, each mapped to the system table's.
import { FILE_STORAGE_TABLE, SCHEDULED_FUNCTIONS_TABLE, SCHEDULED_JOBS_TABLE, STORAGE_TABLE } from "./catalog.ts";
import { virtualJob } from "./scheduled-jobs.ts";
import type { Doc } from "./schema.ts";
import type { Tx } from "./tx.ts";

/** A `_file_storage` document (Convex's `FileStorageEntry`). */
export type FileStorageDoc = {
  _id: string;
  _creationTime: number;
  /** The UUID in file URLs (and, before Convex 1.6, the storage id). */
  storageId: string;
  /** The blob's key in the blob store. */
  storageKey: string;
  sha256: ArrayBuffer;
  size: bigint;
  contentType: string | null;
};

/** A `_file_storage` document as the virtual `_storage` gives it (Convex's `FileStorageDocMapper`, v2). */
export function virtualFile(d: Doc): Doc {
  const f = d as unknown as FileStorageDoc;
  // Keys in Convex's order (its documents are sorted maps); sha256 in base64, size a float.
  return {
    _creationTime: f._creationTime,
    _id: f._id,
    contentType: f.contentType ?? null,
    sha256: Buffer.from(f.sha256).toString("base64"),
    size: Number(f.size),
  } as unknown as Doc;
}

export type VirtualTable = {
  name: string;
  /** The primary system table. */
  system: string;
  /** A system document in the virtual shape, other system tables read in `tx` (a job's arguments). */
  toVirtual(tx: Tx, d: Doc): Doc | Promise<Doc>;
};

export const VIRTUAL_TABLES: ReadonlyMap<string, VirtualTable> = new Map([
  [STORAGE_TABLE, { name: STORAGE_TABLE, system: FILE_STORAGE_TABLE, toVirtual: (_tx, d) => virtualFile(d) }],
  [
    SCHEDULED_FUNCTIONS_TABLE,
    { name: SCHEDULED_FUNCTIONS_TABLE, system: SCHEDULED_JOBS_TABLE, toVirtual: (tx, d) => virtualJob(tx, d) },
  ],
]);

/** The virtual table whose primary system table is `system`, if any. */
export const virtualTableOfSystem = (system: string): VirtualTable | undefined => {
  for (const t of VIRTUAL_TABLES.values()) if (t.system === system) return t;
  return undefined;
};

/** Convex's `virtual_to_system_indexes`: the same two indexes, on the system table. */
export const VIRTUAL_INDEXES: ReadonlySet<string> = new Set(["by_id", "by_creation_time"]);
