// An audit event in words (UI-01 §14.5): "Added 3 documents to tasks", "Deleted environment variable
// LOG_LEVEL". Unknown actions show their name.
import type { AuditEvent, Json } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";

// counts with the thousands separators the other screens use ("1,452 documents")
const n = (v: Json | undefined, one: string, many = `${one}s`) =>
  typeof v === "number" ? `${formatCount(v)} ${v === 1 ? one : many}` : many;
const str = (v: Json | undefined) => (typeof v === "string" ? v : "");

/** The actions the dashboard has words for, in the order a filter lists them. */
export const ACTION_LABELS: Record<string, string> = {
  add_documents: "Added documents",
  update_documents: "Edited documents",
  delete_documents: "Deleted documents",
  clear_tables: "Cleared tables",
  create_table: "Created a table",
  generate_upload_url: "Uploaded a file",
  delete_files: "Deleted files",
  create_environment_variable: "Added an environment variable",
  update_environment_variable: "Changed an environment variable",
  delete_environment_variable: "Deleted an environment variable",
  replace_environment_variable: "Renamed an environment variable",
  cancel_scheduled_function: "Canceled a scheduled run",
  cancel_all_scheduled_functions: "Canceled scheduled runs",
  push_config: "Deployed functions",
  build_indexes: "Built indexes",
};

export function describeEvent(e: AuditEvent): string {
  const m = e.metadata;
  switch (e.action) {
    case "add_documents":
      return `Added ${n(m.count, "document")} to ${str(m.table)}`;
    case "update_documents":
      return `Edited ${n(m.count, "document")} in ${str(m.table)}`;
    case "delete_documents":
      return `Deleted ${n(m.count, "document")} from ${str(m.table)}`;
    case "clear_tables":
      return `Cleared ${Array.isArray(m.tables) ? m.tables.join(", ") : "tables"}${typeof m.count === "number" ? ` (${n(m.count, "document")})` : ""}`;
    case "create_table":
      return `Created table ${str(m.table)}`;
    case "generate_upload_url":
      return "Uploaded a file";
    case "delete_files":
      return `Deleted ${n(m.count, "file")}`;
    case "create_environment_variable":
      return `Added environment variable ${str(m.variable_name)}`;
    case "update_environment_variable":
      return `Changed environment variable ${str(m.variable_name)}`;
    case "delete_environment_variable":
      return `Deleted environment variable ${str(m.variable_name)}`;
    case "replace_environment_variable":
      return `Renamed environment variable ${str(m.previous_name)} to ${str(m.variable_name)}`;
    case "cancel_scheduled_function":
      return `Canceled a scheduled run${m.function ? ` of ${str(m.function)}` : ""}`;
    case "cancel_all_scheduled_functions":
      return `Canceled ${n(m.count, "scheduled run")}${m.function ? ` of ${str(m.function)}` : ""}`;
    case "push_config":
      return "Deployed functions";
    case "request_export":
      return `Requested a snapshot export${m.include_storage === true ? ", with the stored files" : ""}`;
    case "snapshot_import":
      return `Imported ${typeof m.count === "number" ? n(m.count, "document") : "a snapshot"}${
        Array.isArray(m.table_names) && m.table_names.length > 0 ? ` into ${m.table_names.join(", ")}` : ""
      }${m.import_mode === "replace" || m.import_mode === "replaceAll" ? " (replacing)" : ""}`;
    case "pause_deployment":
      return "Paused the deployment";
    case "unpause_deployment":
      return "Resumed the deployment";
    case "build_indexes":
      return "Built indexes";
    default:
      return e.action;
  }
}
