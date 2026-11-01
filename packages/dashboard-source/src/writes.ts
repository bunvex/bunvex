// The Data screen's writes over a bunvex deployment (STUDY-149 PR 3), as Convex's dashboard makes them
// (`dashboard-common/src/features/data/lib/useDataToolbarActions.ts`, `useToolPopup.tsx`, `DataSidebar.tsx`,
// `ClearTableConfirmation.tsx`, `lib/api.ts`): the `_system/frontend` mutations over the socket (`addDocument`,
// `patchDocumentsFields` with ids or, for "Edit all", without them, `replaceDocument`, `deleteDocuments`,
// `clearTablePage` called again on its cursor until it has no more, `createTable`) with the tables' `componentId`, and
// `/api/delete_tables` over HTTP. The deployment records each in its audit log; a watched table hears them through
// its subscriptions (tables.ts).
import { type DashboardDataSource, DataSourceError, type FieldPatch, type Value } from "@bunvex/dashboard/data-source";
import { fromJsonValue, type JSONValue } from "@bunvex/values";
import type { AdminHttp } from "./admin-http.ts";
import type { AdminSync, Args } from "./sync.ts";
import type { Tables } from "./tables.ts";

/**
 * What the dashboard sends for "remove this field" in a patch: bunvex's undefined placeholder (Convex's
 * `UNDEFINED_PLACEHOLDER`, renamed by rule 5: DV-478), which `patchDocumentsFields` reads as `undefined`.
 */
export const UNDEFINED_PLACEHOLDER =
  "__BUNVEX_PLACEHOLDER_undefined_I23atX0jcndVbFgXoQZffsih7eAqktCyFjgUuAeNBtfr3ySOljPSPSEOPFgprkdBO3zXNiGEJxmJ5ZFPc5C5qKesG80QRPvlJe8vgSxAt9feLTwxTg4PHfVwUaTEJU67FDwldWmTxp1guMPwxQ2jOuhEryTBf3mQ";

/** The answer of Convex's data mutations that check a limit or a document first. */
type Outcome = { success: true } | { success: false; error: string };
/** `clearTablePage`'s answer. */
type ClearPage = { deleted: number; continueCursor: string; hasMore: boolean };

/** How long `deleteTables` waits for the table mapping's subscription to hear the deletion. */
const MAPPING_CATCH_UP_MS = 5000;

/** A contract value (int64 and bytes in their JSON encodings) as the client sends it. */
const decoded = (v: Value) => fromJsonValue(v as JSONValue);

/**
 * A failed write's error. Convex rewraps the database's refusals (a field name, the schema, a read-only system
 * table) as an application error whose data is the message, and its dashboard shows that data; any other error
 * the function raised (`Uncaught …`) is a refusal too, with the line it raised. A document that is gone is
 * `not_found`; a permission refusal `unauthorized`; anything else (the server's own failure) `unavailable`.
 */
export function writeError(udfPath: string, errorMessage: string, errorData?: unknown): DataSourceError {
  if (/permission|not authorized|admin key/i.test(errorMessage) && errorData === undefined)
    return new DataSourceError("unauthorized", `${udfPath}: ${errorMessage}`);
  const raised = /^Uncaught \w*:? ?([\s\S]*)$/m.exec(errorMessage);
  const message =
    typeof errorData === "string" ? errorData : raised ? raised[1]!.replace(/\n\s+at [^\n]*/g, "").trim() : null;
  if (message === null) return new DataSourceError("unavailable", `${udfPath}: ${errorMessage}`);
  const gone =
    /^(Delete on nonexistent document ID|Cannot read properties of null \(reading '_id'\)|Document does not exist)/;
  return new DataSourceError(gone.test(message) ? "not_found" : "invalid_request", message);
}

export type Writes = Required<
  Pick<
    DashboardDataSource,
    | "insertDocuments"
    | "patchDocuments"
    | "patchAllDocuments"
    | "replaceDocument"
    | "deleteDocuments"
    | "clearTable"
    | "createTable"
    | "deleteTables"
  >
>;

export function dataWrites(sync: AdminSync, http: AdminHttp, tables: Tables): Writes {
  /** A data mutation over the socket (Convex's `useMutation`), its `success: false` a refusal. */
  const mutate = async <T>(name: string, args: Args, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const udfPath = `_system/frontend/${name}`;
    // in the namespace of the component the tables are (Convex passes the selected one's), the app's for null
    const r = await sync.client.mutationInternal(udfPath, { ...args, componentId: tables.componentId });
    if (!r.success) throw writeError(udfPath, r.errorMessage, r.errorData);
    const value = r.value as T | Outcome;
    if (value !== null && typeof value === "object" && "success" in value && value.success === false)
      throw writeError(udfPath, "", value.error);
    return value as T;
  };

  return {
    async insertDocuments(table, documents, o) {
      await mutate("addDocument", { table, documents: documents.map((d) => decoded(d)) }, o?.signal);
    },
    async patchDocuments(table, ids, fields, o) {
      await mutate("patchDocumentsFields", { table, ids, fields: fieldPatch(fields) }, o?.signal);
    },
    async patchAllDocuments(table, fields, o) {
      // Convex's "Edit all" (`useDataToolbarActions.ts` `patchFields` with `rowIds === "all"`): the mutation
      // without ids patches every document of the table in its one transaction; no pages, no filter
      await mutate("patchDocumentsFields", { table, fields: fieldPatch(fields) }, o?.signal);
    },
    async replaceDocument(_table, id, document, o) {
      await mutate("replaceDocument", { id, document: decoded(document) }, o?.signal);
    },
    async deleteDocuments(table, ids, o) {
      await mutate("deleteDocuments", { toDelete: ids.map((id) => ({ id, tableName: table })) }, o?.signal);
    },
    async clearTable(table, o) {
      // the server deletes from an unknown table's empty index; the mapping tells it is not there
      if (!(await tables.tableNames(o?.signal)).includes(table))
        throw new DataSourceError("not_found", `Table "${table}" does not exist.`);
      // Convex's ClearTableConfirmation: page after page from the last one's cursor, until there are no more
      let cursor: string | null = null;
      let deleted = 0;
      for (;;) {
        const page: ClearPage = await mutate<ClearPage>("clearTablePage", { tableName: table, cursor }, o?.signal);
        deleted += page.deleted;
        if (!page.hasMore) return { deleted };
        cursor = page.continueCursor;
      }
    },
    async createTable(name, o) {
      await mutate("createTable", { table: name }, o?.signal);
    },
    async deleteTables(names, o) {
      // a refusal (a declared table, a name that is not one) is the route's 400: `invalid_request`
      await http.request("/api/delete_tables", {
        method: "POST",
        body: { tableNames: names, componentId: tables.componentId },
        signal: o?.signal,
      });
      // The route answers over HTTP, ahead of the socket: the mapping the source keeps subscribed hears the
      // deletion a moment later. Wait for it (a mutation over the socket resolves after its own transition), so
      // a table list read next does not show the tables again.
      const deadline = Date.now() + MAPPING_CATCH_UP_MS;
      while (Date.now() < deadline && (await tables.tableNames(o?.signal)).some((n) => names.includes(n)))
        await new Promise((r) => setTimeout(r, 10));
    },
  };
}

/** A contract patch as the mutation's `fields`: values decoded, a removal the undefined placeholder. */
function fieldPatch(fields: Record<string, FieldPatch>): Args {
  const patch: Args = {};
  for (const [k, v] of Object.entries(fields)) patch[k] = isUnset(v) ? UNDEFINED_PLACEHOLDER : decoded(v);
  return patch;
}

const isUnset = (v: FieldPatch): v is { $unset: true } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (v as { $unset?: unknown }).$unset === true;
