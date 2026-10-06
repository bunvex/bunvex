// The mock's system tables (STUDY-131 AD-24): what a bunvex deployment's catalog would hold for the mock's
// state, built when asked, so they follow the app's tables, indexes, environment variables, crons and run
// state. The documents have the shapes bunvex stores (`_tables`: name, number, state, tablet; `_index`:
// table, name, fields, state; …); the descriptions are the server's (SYSTEM_TABLE_DESCRIPTIONS in
// @bunvex/core's catalog), copied for the tables the mock fills.
import type { CronJob, Document, EnvironmentVariable, IndexInfo, SystemTableInfo, Value } from "../data-source.ts";

export type SystemTablesHost = {
  tables: () => { name: string; indexes: IndexInfo[]; declared: boolean }[];
  envVars: () => EnvironmentVariable[];
  crons: () => CronJob[];
  paused: () => boolean;
  /** When the deployment was created: every system document is from then on. */
  createdAt: number;
};

const SYSTEM_TABLES: { name: string; number: number; description: string; appVisible?: true }[] = [
  { name: "_tables", number: 513, description: "Every table: its name, number and state (active, hidden, deleting)." },
  {
    name: "_index",
    number: 514,
    description: "Every index: its table, fields and state (backfilling, backfilled, enabled).",
  },
  {
    name: "_schemas",
    number: 532,
    description: "Pushed schemas and their state (pending, active, overwritten, failed).",
  },
  { name: "_environment_variables", number: 525, description: "The deployment's environment variables, by name." },
  { name: "_cron_jobs", number: 531, description: "The cron jobs and their schedules." },
  { name: "_backend_state", number: 536, description: "The deployment's run state (running, paused, disabled)." },
  {
    name: "_scheduled_functions",
    number: 539,
    description: "Scheduled function runs and their state (apps read them through db.system).",
    appVisible: true,
  },
  {
    name: "_storage",
    number: 540,
    description: "Stored files' metadata (apps read it through db.system).",
    appVisible: true,
  },
  {
    name: "_instance",
    number: 9_999,
    description: "The deployment's own settings, such as the generated instance secret.",
  },
];
const FIRST_USER_TABLE = 10_001;

/** A stable id per system document: its table's number and its position. */
const sysId = (table: number, i: number) => `sys${table.toString(36)}${i.toString(36).padStart(4, "0")}`;

export class MockSystemTables {
  constructor(private readonly host: SystemTablesHost) {}

  list(): SystemTableInfo[] {
    return SYSTEM_TABLES.map((t) => ({
      name: t.name,
      description: t.description,
      appVisible: t.appVisible === true,
      documentCount: this.documents(t.name)!.length,
    })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** The documents of one system table, oldest first; `undefined` when the mock has no such table. */
  documents(name: string): Document[] | undefined {
    const t = SYSTEM_TABLES.find((x) => x.name === name);
    if (!t) return undefined;
    const at = this.host.createdAt;
    const docs = (rows: Record<string, Value>[]): Document[] =>
      rows.map((r, i) => ({ _id: sysId(t.number, i), _creationTime: at + t.number + i / 1000, ...r }));
    const user = [...this.host.tables()].sort((a, b) => (a.name < b.name ? -1 : 1));
    switch (name) {
      case "_tables":
        return docs([
          ...SYSTEM_TABLES.filter((x) => x.name !== "_tables" && x.name !== "_index").map((x, i) => ({
            name: x.name,
            number: x.number,
            state: "active",
            tablet: i + 1,
          })),
          ...user.map((u, i) => ({ name: u.name, number: FIRST_USER_TABLE + i, state: "active", tablet: 100 + i })),
        ]);
      case "_index":
        return docs(
          user.flatMap((u, i) =>
            u.indexes.map((ix) => ({
              table: FIRST_USER_TABLE + i,
              name: ix.name,
              fields: ix.fields,
              state: ix.state === "ready" ? "enabled" : "backfilling",
            })),
          ),
        );
      case "_schemas":
        return docs([{ state: { type: "active" }, tables: user.filter((u) => u.declared).map((u) => u.name) }]);
      case "_environment_variables":
        return docs(this.host.envVars().map((v) => ({ name: v.name, value: v.value })));
      case "_cron_jobs":
        return docs(
          this.host.crons().map((c) => ({ name: c.name, cronSpec: { udfPath: c.function, udfArgs: [c.args] } })),
        );
      case "_backend_state":
        return docs([{ system: "none", usage_limit: "none", user: this.host.paused() ? "paused" : "none" }]);
      case "_instance":
        return docs([{ key: "instance_secret", value: "(generated)" }]);
      default:
        return docs([]);
    }
  }
}
