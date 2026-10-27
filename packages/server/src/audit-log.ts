// The deployment audit log's events (STUDY-48), as Convex's `DeploymentAuditLogEvent`
// (crates/model/src/deployment_audit_log/types.rs): each one's `action` and `metadata`, for the changes
// bunvex can make. (Stored objects come back with their keys in order, as Convex's do.)
import type { AuditLogActor, AuditLogEvent, Caller } from "@bunvex/core";
import { isBytes, type Value } from "@bunvex/values";
import type { AdminCaller } from "./functions.ts";
import { LOG_TOPICS } from "./log-events.ts";
import type { SinkConfig } from "./log-sinks.ts";

const event = (action: string, metadata: Record<string, Value>): AuditLogEvent => ({ action, metadata });

/** The root component, as Convex serializes it (`component_id`, `component`: null). */
const ROOT = { component_id: null, component: null };
/** A component as Convex serializes it: its `_components` id and its path; the root's when null. */
export type AuditComponent = { component_id: string | null; component: string | null };

/** A component's push diff (Convex's `SerializedComponentDiff`): in the audit event and `finish_push`'s answer. */
export type ComponentDiff = {
  diffType: { type: "create" | "modify" | "unmount" | "remount" };
  moduleDiff: { added: string[]; removed: string[] };
  udfConfigDiff: { previous_version: string; next_version: string } | null;
  cronDiff: { added: string[]; updated: string[]; deleted: string[] };
  indexDiff: Record<"added_indexes" | "removed_indexes" | "enabled_indexes" | "disabled_indexes", Value[]>;
  schemaDiff: { previous_schema: string | null; next_schema: string | null } | null;
};

export const auditEvents = {
  createEnvironmentVariable: (name: string) => event("create_environment_variable", { variable_name: name }),
  updateEnvironmentVariable: (name: string) => event("update_environment_variable", { variable_name: name }),
  deleteEnvironmentVariable: (name: string) => event("delete_environment_variable", { variable_name: name }),
  deleteTables: (names: string[]) => event("delete_tables", { ...ROOT, table_names: names }),
  /** Convex's `DeleteComponent`: the deleted component's id and path. */
  deleteComponent: (id: string, path: string) => event("delete_component", { component_id: id, component: path }),
  /** Streaming import's `clear_tables` (STUDY-141): no metadata, as Convex's ("consider adding table names"). */
  clearTables: () => event("clear_tables", {}),
  cancelScheduledFunction: (id: string, functionPath: string | null, component: AuditComponent = ROOT) =>
    event("cancel_scheduled_function", { ...component, scheduled_function_id: id, function_path: functionPath }),
  cancelAllScheduledFunctions: (component: AuditComponent = ROOT) =>
    event("cancel_all_scheduled_functions", { ...component }),
  deleteScheduledJobsTable: () => event("delete_scheduled_jobs_table", { ...ROOT }),
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
  /** Convex's `PushConfigWithComponents` (finish_push), for the root component (bunvex has no others). */
  pushConfigWithComponents: (o: {
    authDiff: { added: string[]; removed: string[] };
    /** Each component's diff, by path (null for the app's), as Convex's `component_diffs`: the app's first, by path. */
    componentDiffs: { path: string | null; diff: ComponentDiff }[];
    message: string | null;
    /** Convex's `SerializedNodeVersionDiff` (STUDY-145): null when the push keeps the Node version. */
    nodeVersionDiff?: { previous_version: string | null; next_version: string | null } | null;
  }) =>
    event("push_config_with_components", {
      auth_diff: o.authDiff,
      component_diffs: o.componentDiffs.map((c) => ({ component_path: c.path, component_diff: c.diff })),
      message: o.message,
      node_version_diff: o.nodeVersionDiff ?? null,
    }),
  /** The Data screen's writes (STUDY-149 PR 3), as Convex's system functions record them. */
  addDocuments: (table: string, ids: string[]) => event("add_documents", { ...ROOT, table, document_ids: ids }),
  updateDocuments: (table: string, ids: string[]) => event("update_documents", { ...ROOT, table, document_ids: ids }),
  deleteDocuments: (table: string, ids: string[]) => event("delete_documents", { ...ROOT, table, document_ids: ids }),
  createTable: (table: string) => event("create_table", { ...ROOT, table }),
  deleteFiles: (storageIds: string[]) => event("delete_files", { ...ROOT, storage_ids: storageIds }),
  generateUploadUrl: () => event("generate_upload_url", { ...ROOT }),
  /**
   * Log streams (STUDY-59): the sink's id and type, and its configuration as an audit snapshot (Convex's 3a958a4):
   * a created or deleted sink's, an updated one's before and after with which credentials changed.
   */
  createIntegration: (id: string, config: SinkConfig) =>
    event("create_integration", { id, type: config.type, ...present({ config: auditConfig(config) }) }),
  updateIntegration: (id: string, previous: SinkConfig, current: SinkConfig) =>
    event("update_integration", {
      id,
      type: current.type,
      ...present({
        previous: auditConfig(previous),
        current: auditConfig(current),
        credential_changes: auditCredentialChanges(previous, current),
      }),
    }),
  deleteIntegration: (id: string, config: SinkConfig) =>
    event("delete_integration", { id, type: config.type, ...present({ config: auditConfig(config) }) }),
  /** Convex's `DownloadExport` (8281a65, 9d26926): a completed export's ZIP downloaded, as `request_export` names it. */
  downloadExport: (id: string, includeStorage: boolean) =>
    event("download_export", {
      id,
      ...ROOT,
      format: includeStorage ? "zip_with_storage" : "zip",
      requestor: "snapshot_export",
    }),
  /**
   * The dashboard's actions on a room in memory (AD-43, bunvex's own: Convex has no rooms): the room's function and
   * its canonical args as JSON text (wire JSON may hold `$`-keys no stored object may), then what was done.
   */
  broadcastRoomEvent: (room: string, args: string, eventName: string) =>
    event("broadcast_room_event", { room, args, event: eventName }),
  removeRoomMember: (room: string, args: string, memberId: string, connections: number) =>
    event("remove_room_member", { room, args, member_id: memberId, connections }),
  closeRoom: (room: string, args: string, members: number, connections: number) =>
    event("close_room", { room, args, members, connections }),
  pauseDeployment: () => event("pause_deployment", {}),
  unpauseDeployment: () => event("unpause_deployment", {}),
};

// ---------------------------------------------------------------- integration audit snapshots (3a958a4)

/** The fields that are set (Convex's `skip_serializing_if = "Option::is_none"` on the event's own fields). */
const present = (o: Record<string, Value | null>): Record<string, Value> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Record<string, Value>;

/**
 * A URL's origin, Convex's `url_origin`: a path, userinfo, query or fragment can carry credentials, the origin names
 * the service. Null when it does not parse or has no origin.
 */
function urlOrigin(raw: string): string | null {
  try {
    const origin = new URL(raw).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Convex's `serialize_topics`: a set, in `LogTopic`'s order. */
const topicsOf = (topics: unknown): Value =>
  Array.isArray(topics) ? LOG_TOPICS.filter((t) => topics.includes(t)) : null;

/** Convex's `DEFAULT_POSTHOG_HOST` and Axiom's default ingest URL. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_AXIOM_INGEST = "https://api.axiom.co";

/** A Sentry DSN's project id: its last path segment. */
const sentryProject = (dsn: string) => {
  try {
    return new URL(dsn).pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    return "";
  }
};

/**
 * Convex's `audit_config`: a sink's configuration as the audit log keeps it, an allowlist of its fields with every
 * credential left out and every URL cut to its origin. Unset optional fields are null; the variant is `type`.
 */
export function auditConfig(config: SinkConfig): Record<string, Value> {
  const c = config as Record<string, unknown>;
  const opt = (k: string) => (c[k] === undefined ? null : (c[k] as Value));
  switch (config.type) {
    case "local":
      return { type: "local", path: config.path };
    case "datadog":
      return {
        type: "datadog",
        site: c.siteLocation as string,
        service: opt("service"),
        tags: (c.ddTags as Value) ?? [],
        format_version: String(c.version ?? "2"),
        topics: topicsOf(c.topics),
      };
    case "axiom":
      return {
        type: "axiom",
        dataset: c.datasetName as string,
        ingest_origin: urlOrigin((c.ingestUrl as string | undefined) ?? DEFAULT_AXIOM_INGEST),
        attributes: (c.attributes as Value) ?? [],
        format_version: String(c.version ?? "2"),
        topics: topicsOf(c.topics),
      };
    case "webhook":
      return {
        type: "webhook",
        url_origin: urlOrigin(config.url),
        format: config.format,
        topics: topicsOf(config.topics),
      };
    case "sentry":
      return {
        type: "sentry",
        dsn_origin: urlOrigin(c.dsn as string),
        project_id: sentryProject(c.dsn as string),
        tags: opt("tags"),
        format_version: String(c.version ?? "2"),
      };
    case "postHogLogs":
      return {
        type: "postHogLogs",
        host_origin: urlOrigin((c.host as string | undefined) ?? DEFAULT_POSTHOG_HOST),
        service_name: opt("serviceName"),
        topics: topicsOf(c.topics),
      };
    case "postHogErrorTracking":
      return {
        type: "postHogErrorTracking",
        host_origin: urlOrigin((c.host as string | undefined) ?? DEFAULT_POSTHOG_HOST),
      };
    case "s3Export":
      return {
        type: "s3Export",
        bucket: c.bucket as string,
        region: c.region as string,
        prefix: opt("prefix"),
        period: c.period as string,
        selection: c.selection as Value,
      };
  }
}

/**
 * Convex's `audit_credential_changes`: for an update, which credential-bearing fields changed (an unset optional one
 * differs from a set one). Null for a local sink, or when the type changed.
 */
export function auditCredentialChanges(previous: SinkConfig, current: SinkConfig): Record<string, Value> | null {
  if (previous.type !== current.type || current.type === "local") return null;
  const p = previous as Record<string, unknown>;
  const c = current as Record<string, unknown>;
  const changed = (k: string) => p[k] !== c[k];
  switch (current.type) {
    case "datadog":
      return { type: "datadog", api_key_changed: changed("ddApiKey") };
    case "axiom":
      return { type: "axiom", api_key_changed: changed("apiKey"), ingest_url_changed: changed("ingestUrl") };
    case "webhook":
      return { type: "webhook", hmac_secret_changed: changed("hmacSecret"), url_changed: changed("url") };
    case "sentry":
      return { type: "sentry", dsn_changed: changed("dsn") };
    case "postHogLogs":
      return { type: "postHogLogs", api_key_changed: changed("apiKey"), host_changed: changed("host") };
    case "postHogErrorTracking":
      return { type: "postHogErrorTracking", api_key_changed: changed("apiKey"), host_changed: changed("host") };
    case "s3Export":
      return {
        type: "s3Export",
        access_key_id_changed: changed("accessKeyId"),
        secret_access_key_changed: changed("secretAccessKey"),
      };
  }
}

/** A value as Convex's clean JSON (`ValueFormat::ConvexCleanJSON`): int64 as a decimal string. */
export function cleanJson(v: Value): unknown {
  if (typeof v === "bigint") return v.toString();
  if (isBytes(v)) return Buffer.from(v).toString("base64");
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
