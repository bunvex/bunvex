// An audit event in words (UI-01 §14.5): "Added 3 documents to tasks", "Deleted environment variable
// LOG_LEVEL". Unknown actions show their name.
import type { AuditEvent, Json } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";

// counts with the thousands separators the other screens use ("1,452 documents")
const n = (v: Json | undefined, one: string, many = `${one}s`) =>
  typeof v === "number" ? `${formatCount(v)} ${v === 1 ? one : many}` : many;
const str = (v: Json | undefined) => (typeof v === "string" ? v : "");

/** The actions the dashboard has words for, in the order a filter lists them. */
// The action facet's words: short, so they fit the column (UX2-24), under the area they belong to.
export const ACTION_AREAS: readonly { area: string; actions: Record<string, string> }[] = [
  {
    area: "Data",
    actions: {
      add_documents: "Documents added",
      update_documents: "Documents edited",
      delete_documents: "Documents deleted",
      clear_tables: "Tables cleared",
      create_table: "Table created",
    },
  },
  { area: "Files", actions: { generate_upload_url: "File uploaded", delete_files: "Files deleted" } },
  {
    area: "Environment variables",
    actions: {
      create_environment_variable: "Env var added",
      update_environment_variable: "Env var changed",
      delete_environment_variable: "Env var deleted",
      replace_environment_variable: "Env var renamed",
    },
  },
  {
    area: "Schedules",
    actions: { cancel_scheduled_function: "Run canceled", cancel_all_scheduled_functions: "Runs canceled" },
  },
  { area: "Deploys", actions: { push_config: "Functions deployed", build_indexes: "Indexes built" } },
];
export const ACTION_LABELS: Record<string, string> = Object.assign({}, ...ACTION_AREAS.map((a) => a.actions));
/** An action's area in the facet; "Other" for one no area lists (e.g. an extension's). */
export const areaOf = (action: string) => ACTION_AREAS.find((a) => action in a.actions)?.area ?? "Other";

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
    default: {
      // an action no screen describes (an extension's, a newer server's): its words, and what it was about
      const words = e.action.replace(/_/g, " ");
      const about = [m.flag, m.name, m.table].find((v) => typeof v === "string");
      return `${words.charAt(0).toUpperCase()}${words.slice(1)}${about ? ` ${about}` : ""}`;
    }
  }
}
