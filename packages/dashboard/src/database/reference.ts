// Where a document id leads (STUDY-163 §2), as Convex's `documentHref` (`dashboard-common/src/lib/utils.ts`): a
// file's id to Files with that file open, a scheduled run's to the scheduled functions (Convex opens no run there
// either), any other table's id to its document on the Database screen.

/** The table mapping's names for the system tables an id can point into (Convex's `getTableMapping`). */
export const FILE_STORAGE_TABLE = "_file_storage";
export const SCHEDULED_JOBS_TABLE = "_scheduled_jobs";

export type ReferenceTarget =
  | { to: "/files"; search: { file: string } }
  | { to: "/schedules/functions" }
  | { to: "/database/$table"; params: { table: string }; search: { doc: string } };

/** Where `id`, a document of `table` (as `tableOfId` names it), opens; null for a system table no screen shows. */
export function referenceTarget(table: string, id: string): ReferenceTarget | null {
  if (table === FILE_STORAGE_TABLE) return { to: "/files", search: { file: id } };
  if (table === SCHEDULED_JOBS_TABLE) return { to: "/schedules/functions" };
  if (table.startsWith("_")) return null;
  return { to: "/database/$table", params: { table }, search: { doc: id } };
}
