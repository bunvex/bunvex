// The system tables in the dashboard contract (STUDY-131 AD-24) — a bunvex addition: Convex's dashboard shows
// the app's tables and the two virtual ones (`_storage` as Files, `_scheduled_functions` as Schedules), never
// the private system tables. Here the Data screen's "Show system tables" lists every one the deployment's
// catalog has and pages through its documents, read-only. A server source maps them to the system queries
// `_system/debug/systemTables` and `_system/debug/systemTable`. Both methods are optional — a source offers
// the view by having them (detected with `typeof`) — and need the `viewData` operation. Re-exported by
// `data-source.ts`.
import type { CallOptions, Document, Page, PageRequest } from "./data-source.ts";

export type SystemTableInfo = {
  /** Starts with `_`. */
  name: string;
  /** One line on what it holds; empty when the deployment has none for it. */
  description: string;
  /** Apps read it through `db.system`, in its public shape; otherwise it is private to the deployment. */
  appVisible: boolean;
  /** `null` when the source cannot count it now (a server still loading its table summaries). */
  documentCount: number | null;
};

/** A page of a system table's documents, as stored (every field), in `_creationTime` order. */
export type SystemDocumentQuery = PageRequest & {
  table: string;
  /** Default: oldest first. */
  order?: "asc" | "desc";
};

export interface SystemTablesFeatures {
  /** Every system table, by name. `unauthorized` without `viewData`. */
  listSystemTables?(opts?: CallOptions): Promise<SystemTableInfo[]>;
  /**
   * One system table's documents. `invalid_request` for a name that is not a system table's, `not_found` for
   * a system table the deployment does not have, `unauthorized` without `viewData`. Never writes.
   */
  listSystemDocuments?(query: SystemDocumentQuery, opts?: CallOptions): Promise<Page<Document>>;
}
