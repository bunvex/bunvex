// The Data screen's writes (STUDY-149 PR 3), as Convex's npm-packages/system-udfs/convex/_system/frontend:
// `addDocument.ts`, `patchDocumentsFields.ts`, `replaceDocument.ts`, `deleteDocuments.ts`, `clearTablePage.ts` and
// `createTable.ts`. Same names, arguments, answers, limits and errors, and each with Convex's deployment audit
// event (`add_documents`, `update_documents`, `delete_documents`, `create_table`; the metadata of
// crates/model/src/deployment_audit_log/types.rs, the root component's `component_id` and `component` added as
// the `writeDeploymentAuditLog` syscall adds them). They run as Convex's `mutationGeneric("WriteData")`: an app's
// database (`_`-tables are read-only, the schema is enforced), not the private system tables. `componentId` is
// accepted and ignored, as bunvex has only the root component (DV-55).
import { type AuditLogEvent, insertAuditLogEvents, type Tx } from "@bunvex/core";
import { BunvexError, decodeId, type Value, v } from "@bunvex/values";
import { auditActor, auditEvents } from "./audit-log.ts";
import { UNDEFINED_PLACEHOLDER } from "./data-system-functions.ts";
import type { SystemEnv, SystemMutation } from "./system-functions.ts";

const componentId = v.optional(v.union(v.string(), v.null()));

/** Convex's `MAX_IMPORT_COUNT` (`addDocument.ts`): half of a transaction's 8 192 user writes. */
export const MAX_ADD_DOCUMENTS = 4096;
/** Convex's `MAX_DOCUMENT_DELETIONS` (`deleteDocuments.ts`). */
export const MAX_DELETE_DOCUMENTS = 4096;
/** Convex's `MAX_CLEAR_ROWS` (`clearTablePage.ts`): the documents one call deletes. */
export const MAX_CLEAR_ROWS = 4000;
/**
 * Convex's `maximumBytesRead` for a clear's page: each document is counted when read and again when deleted,
 * and one document may go past the bound by up to 1 MiB, so (3 MB + 1 MiB) · 2 stays under 8 MiB.
 */
const CLEAR_MAX_BYTES_READ = 3_000_000;

type Doc = Record<string, unknown> & { _id: string };

/**
 * Convex rewraps a write's error as `new ConvexError(e.message)` (it may be the schema's refusal), so the
 * dashboard shows the data, the message alone.
 */
const rewrapped = (e: unknown) => new BunvexError((e as Error)?.message ?? String(e));

/** The name of the table an id is of, by its number (Convex's `getTableMapping` op and `decodeId`). */
async function tableOfId(db: Tx, id: string): Promise<string | undefined> {
  const number = BigInt(decodeId(id).tableNumber);
  const rows = (await db.asSystem(() => db.query("_tables").collect())) as Doc[];
  const row = rows.find((r) => r.number === number && (r.state ?? "active") === "active" && r.namespace === undefined);
  return row?.name as string | undefined;
}

const audit = (db: Tx, env: SystemEnv, event: AuditLogEvent) =>
  insertAuditLogEvents(db, [event], auditActor(env.caller));

export const DATA_SYSTEM_MUTATIONS: Record<string, SystemMutation> = {
  // Convex's `addDocument`: inserts each document in order; past 4 096 it answers `success: false` and writes
  // nothing. An insert's error is rewrapped (Convex deletes what it inserted first; the failure rolls it back
  // anyway).
  "_system/frontend/addDocument": {
    args: { componentId, table: v.string(), documents: v.array(v.any()) },
    handler: async (db, { table, documents }: { table: string; documents: Value[] }, env) => {
      if (documents.length > MAX_ADD_DOCUMENTS)
        // Convex's words, with its typographic apostrophe
        return { success: false, error: `Can’t import more than ${MAX_ADD_DOCUMENTS} documents at once.` };
      const ids: string[] = [];
      try {
        for (const d of documents) ids.push(await db.insert(table, d as Record<string, unknown>));
      } catch (e) {
        throw rewrapped(e);
      }
      await audit(db, env, auditEvents.addDocuments(table, ids));
      return { success: true };
    },
  },
  // Convex's `patchDocumentsFields`: the documents of `ids` (every document of `table` without them), each
  // patched with `fields`, the undefined placeholder removing a field. Reading an id fails as `db.get` does;
  // a patch's error (a document that is gone, the schema's refusal) is rewrapped. The event names `table` as
  // given and the ids patched.
  "_system/frontend/patchDocumentsFields": {
    args: { table: v.string(), fields: v.any(), ids: v.optional(v.array(v.string())), componentId },
    handler: async (db, { table, fields, ids }: { table: string; fields: Value; ids?: string[] }, env) => {
      const documents = (
        ids !== undefined ? await Promise.all(ids.map((id) => db.get(id))) : await db.query(table).collect()
      ) as (Doc | null)[];
      try {
        const patch: Record<string, unknown> = {};
        // `for…in`, as Convex's: a value that is not an object patches its indices (a string) or nothing
        for (const key in fields as object) {
          const value = (fields as Record<string, unknown>)[key];
          patch[key] = value === UNDEFINED_PLACEHOLDER ? undefined : value;
        }
        for (const d of documents) {
          // V8's words for Convex's `document._id` on a document that is gone
          if (d === null) throw new TypeError("Cannot read properties of null (reading '_id')");
          await db.patch(d._id, patch);
        }
      } catch (e) {
        throw rewrapped(e);
      }
      await audit(
        db,
        env,
        auditEvents.updateDocuments(
          table,
          documents.map((d) => (d as Doc)._id),
        ),
      );
      return { success: true };
    },
  },
  // Convex's `replaceDocument`: a document that is gone answers `success: false`; the replace's error is
  // rewrapped. The event names the id's table.
  "_system/frontend/replaceDocument": {
    args: { id: v.string(), document: v.any(), componentId },
    handler: async (db, { id, document }: { id: string; document: Value }, env) => {
      if ((await db.get(id)) === null) return { success: false, error: "Document does not exist." };
      try {
        await db.replace(id, document as Record<string, unknown>);
      } catch (e) {
        throw rewrapped(e);
      }
      const table = await tableOfId(db, id);
      await audit(db, env, auditEvents.updateDocuments(table ?? "", [id]));
      return { success: true };
    },
  },
  // Convex's `deleteDocuments`: past 4 096 it answers `success: false`; each delete fails as `db.delete` does
  // (an id that is gone included). One event per table named, in the order first named, with the ids as given.
  "_system/frontend/deleteDocuments": {
    args: { componentId, toDelete: v.array(v.object({ id: v.string(), tableName: v.string() })) },
    handler: async (db, { toDelete }: { toDelete: { id: string; tableName: string }[] }, env) => {
      if (toDelete.length > MAX_DELETE_DOCUMENTS)
        return {
          success: false,
          error: `You can't delete more than ${MAX_DELETE_DOCUMENTS}. Try selecting fewer documents instead..`,
        };
      for (const d of toDelete) await db.delete(d.id);
      const byTable = new Map<string, string[]>();
      for (const d of toDelete) byTable.set(d.tableName, [...(byTable.get(d.tableName) ?? []), d.id]);
      for (const [table, ids] of byTable) await audit(db, env, auditEvents.deleteDocuments(table, ids));
      return { success: true };
    },
  },
  // Convex's `clearTablePage`: the oldest 4 000 documents from `cursor` on (by creation time, so the screen's
  // newest-first page is not invalidated again and again), deleted; the dashboard calls it again with
  // `continueCursor` while `hasMore`. A page that deleted anything is one `delete_documents` event.
  "_system/frontend/clearTablePage": {
    args: { componentId, tableName: v.string(), cursor: v.union(v.string(), v.null()) },
    handler: async (db, { tableName, cursor }: { tableName: string; cursor: string | null }, env) => {
      const { page, continueCursor, isDone } = await db
        .query(tableName)
        .withIndex("by_creation_time")
        .order("asc")
        .paginate({ numItems: MAX_CLEAR_ROWS, cursor, maximumBytesRead: CLEAR_MAX_BYTES_READ });
      const documents = page as Doc[];
      for (const d of documents) await db.delete(d._id);
      if (documents.length > 0)
        await audit(
          db,
          env,
          auditEvents.deleteDocuments(
            tableName,
            documents.map((d) => d._id),
          ),
        );
      return { deleted: documents.length, continueCursor, hasMore: !isDone };
    },
  },
  // Convex's `createTable`: a document inserted and deleted in one transaction, which makes the table (a taken
  // name is no error, unless its declared type refuses `{}`). Errors are not rewrapped.
  "_system/frontend/createTable": {
    args: { table: v.string(), componentId },
    handler: async (db, { table }: { table: string }, env) => {
      const id = await db.insert(table, {});
      await db.delete(id);
      await audit(db, env, auditEvents.createTable(table));
    },
  },
};
