// The system tables on the Data screen over a bunvex deployment (STUDY-131 AD-24, a bunvex addition: Convex's
// dashboard shows no private system table). The server has the two admin-only system queries the CLI's `data
// --system` reads: `_system/debug/systemTables` (every system table the catalog has, with its description, whether
// apps read it through `db.system`, and its size) and `_system/debug/systemTable` (a page of one, as stored). Both
// are one-shot here: the screen lists and pages them as the mock's (no live variant in the contract).
import {
  type CallOptions,
  DataSourceError,
  type Document,
  type Page,
  type SystemDocumentQuery,
  type SystemTableInfo,
} from "@bunvex/dashboard/data-source";
import type { AdminSync } from "./sync.ts";
import { pageError, toDocument } from "./tables.ts";

const SYSTEM_TABLES = "_system/debug/systemTables";
const SYSTEM_TABLE = "_system/debug/systemTable";

/** `_system/debug/systemTables`' rows, as the server sends them. */
type SystemTableJson = { name: string; description: string; appVisible: boolean; documentCount: number | null };

/** A row as the contract shows it (the server's fields are the contract's; sorted by name). */
export const systemTableOf = (t: SystemTableJson): SystemTableInfo => ({
  name: t.name,
  description: t.description,
  appVisible: t.appVisible,
  documentCount: t.documentCount,
});

export class SystemTables {
  constructor(private readonly sync: AdminSync) {}

  /** Every system table, by name. A key without ViewData is refused by the server (`unauthorized`). */
  async listSystemTables(o?: CallOptions): Promise<SystemTableInfo[]> {
    const rows = await this.sync.query<SystemTableJson[]>(SYSTEM_TABLES, {}, o?.signal);
    return rows.map(systemTableOf).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * A page of one system table, as stored. The server reads an unknown `_` name as an empty table, so the
   * listing (asked beside the page) tells the contract's `not_found`; a user table's name and a bad page size
   * are refused before anything is sent, as the mock refuses them.
   */
  async listSystemDocuments(q: SystemDocumentQuery, o?: CallOptions): Promise<Page<Document>> {
    if (!q.table.startsWith("_")) throw new DataSourceError("invalid_request", `"${q.table}" is not a system table.`);
    if (!Number.isInteger(q.numItems) || q.numItems < 1)
      throw new DataSourceError("invalid_request", `numItems must be a positive integer, not ${q.numItems}.`);
    const args = {
      table: q.table,
      order: q.order ?? "asc",
      paginationOpts: { numItems: q.numItems, cursor: q.cursor },
    };
    const [names, page] = await Promise.all([
      this.sync.query<SystemTableJson[]>(SYSTEM_TABLES, {}, o?.signal).then((rows) => rows.map((r) => r.name)),
      this.sync.query<Page<Record<string, unknown>>>(SYSTEM_TABLE, args, o?.signal).catch((e: unknown) => {
        throw pageError(e);
      }),
    ]);
    if (!names.includes(q.table))
      throw new DataSourceError("not_found", `There is no system table named "${q.table}".`);
    return { ...page, page: page.page.map(toDocument) };
  }
}
