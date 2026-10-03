// The deployment audit log's events (STUDY-48), as Convex's `DeploymentAuditLogEvent`
// (crates/model/src/deployment_audit_log/types.rs): each one's `action` and `metadata`, for the changes
// bunvex can make. (Stored objects come back with their keys in order, as Convex's do.)
import type { AuditLogActor, AuditLogEvent, Caller } from "@bunvex/core";
import type { Value } from "@bunvex/values";
import type { AdminCaller } from "./functions.ts";

const event = (action: string, metadata: Record<string, Value>): AuditLogEvent => ({ action, metadata });

/** The root component, as Convex serializes it (`component_id`, `component`: null). */
const ROOT = { component_id: null, component: null };

export const auditEvents = {
  createEnvironmentVariable: (name: string) => event("create_environment_variable", { variable_name: name }),
  updateEnvironmentVariable: (name: string) => event("update_environment_variable", { variable_name: name }),
  deleteEnvironmentVariable: (name: string) => event("delete_environment_variable", { variable_name: name }),
  deleteTables: (names: string[]) => event("delete_tables", { ...ROOT, table_names: names }),
  cancelScheduledFunction: (id: string, functionPath: string | null) =>
    event("cancel_scheduled_function", { ...ROOT, scheduled_function_id: id, function_path: functionPath }),
  cancelAllScheduledFunctions: () => event("cancel_all_scheduled_functions", { ...ROOT }),
  requestExport: (id: string, includeStorage: boolean) =>
    event("request_export", {
      id,
      ...ROOT,
      format: includeStorage ? "zip_with_storage" : "zip",
      requestor: "snapshot_export",
    }),
  cancelExport: (id: string) => event("cancel_export", { id }),
  setExportExpiration: (id: string, expirationTsMs: bigint) =>
    event("set_export_expiration", { id, expiration_ts_ms: expirationTsMs }),
  /** Convex keeps the first 20 table names and the full counts (snapshot_import/audit_log.rs). */
  snapshotImport: (o: { tables: string[]; deleted: string[]; mode: string; format: Value }) =>
    event("snapshot_import", {
      table_names: [{ component: null, table_names: o.tables.slice(0, 20) }],
      table_count: BigInt(o.tables.length),
      import_mode: o.mode,
      import_format: o.format,
      requestor: { type: "snapshotImport" },
      table_names_deleted: [{ component: null, table_names: o.deleted.slice(0, 20) }],
      table_count_deleted: BigInt(o.deleted.length),
    }),
  updateCanonicalUrl: (destination: string, url: string) =>
    event("update_canonical_url", { request_destination: destination, url }),
  deleteCanonicalUrl: (destination: string) => event("delete_canonical_url", { request_destination: destination }),
  deleteFiles: (storageIds: string[]) => event("delete_files", { ...ROOT, storage_ids: storageIds }),
  generateUploadUrl: () => event("generate_upload_url", { ...ROOT }),
  /** Log streams (STUDY-59): the sink's id and type. */
  createIntegration: (id: string, type: string) => event("create_integration", { id, type }),
  updateIntegration: (id: string, type: string) => event("update_integration", { id, type }),
  deleteIntegration: (id: string, type: string) => event("delete_integration", { id, type }),
};

/** A value as Convex's clean JSON (`ValueFormat::ConvexCleanJSON`): int64 as a decimal string. */
export function cleanJson(v: Value): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map(cleanJson);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanJson(x as Value)]));
  return v;
}

/** A stored event as `GET /api/v1/list_audit_log_events` answers it (Convex's `DeploymentAuditLogEventResponse`). */
export function auditEventJson(d: Record<string, Value>) {
  const member = d.member_id;
  return {
    actor: typeof member === "bigint" ? { kind: "member", member_id: Number(member) } : { kind: "system" },
    action: d.action,
    createTime: Math.floor(d._creationTime as number),
    metadata: cleanJson(d.metadata ?? {}),
    clientIp: d.client_ip ?? null,
    clientUserAgent: d.client_user_agent ?? null,
  };
}

/** Convex's DEFAULT_AUDIT_LOG_LIMIT and MAX_AUDIT_LOG_LIMIT. */
export const DEFAULT_AUDIT_LOG_LIMIT = 15;
export const MAX_AUDIT_LOG_LIMIT = 100;

/**
 * Who a request's change is recorded as: an admin key's member (Convex's `identity.member_id()`), none for
 * the system key or a user, and the request's IP and user agent.
 */
export function auditActor(caller: Caller | undefined): AuditLogActor {
  const admin = (caller as AdminCaller | undefined)?.admin;
  return {
    memberId: admin?.kind === "admin" ? BigInt(admin.memberId) : null,
    ip: caller?.request?.ip ?? null,
    userAgent: caller?.request?.userAgent ?? null,
  };
}
