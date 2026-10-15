// The component registry (STUDY-152 step 2): Convex's `_components` rows, a component's path in the tree and back,
// and the namespace a new component's tables live in. As Convex's `ComponentRegistry`
// (crates/database/src/component_registry.rs), lookups read `_components` through `by_parent_and_name` and `by_id`
// in the transaction, so a query that resolves a path re-runs when the tree changes.
import { COMPONENTS_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

/** A component's state, as Convex's `ComponentState`: an unmounted one keeps its data, read-only, and runs nothing. */
export type ComponentState = "active" | "unmounted";

/** An environment variable binding (Convex's `SerializedEnvBinding`): a value, or the parent's variable. */
export type EnvBinding = { type: "value"; value: string } | { type: "envVar"; name: string };

/**
 * A `_components` row read back (Convex's `ComponentMetadata`): the root (`App`) has no parent and no name; a child
 * has both, its args (legacy, always `[]` from today's JS API: K6) and its env bindings.
 */
export type ComponentMeta = {
  _id: string;
  definitionId: string;
  state: ComponentState;
  httpPrefix: string | null;
} & (
  | { parent: null; name: null }
  | { parent: string; name: string; args: [string, unknown][]; env: [string, EnvBinding][] }
);

/** A component's fields without its id: what a new row is written from. */
export type NewComponent = ComponentMeta extends infer M ? (M extends unknown ? Omit<M, "_id"> : never) : never;

/** A row that is not a component Convex can load, in its words. */
export class ComponentMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComponentMetadataError";
  }
}

/**
 * A `_components` row as Convex stores it (`SerializedComponentMetadata`): `parent`, `name`, `args` and `env` null
 * for the root; `state` always written.
 */
export function componentRow(m: NewComponent): Record<string, unknown> {
  return {
    definitionId: m.definitionId,
    parent: m.parent,
    name: m.name,
    args: m.parent === null ? null : m.args,
    env: m.parent === null ? null : m.env,
    state: m.state,
    httpPrefix: m.httpPrefix,
  };
}

/** A `_components` row read back, checked as Convex's `TryFrom<SerializedComponentMetadata>`. */
export function componentMeta(row: Record<string, unknown>): ComponentMeta {
  const state = row.state ?? "active";
  if (state !== "active" && state !== "unmounted")
    throw new ComponentMetadataError(`Invalid component state: ${state}`);
  const base = {
    _id: row._id as string,
    definitionId: row.definitionId as string,
    state: state as ComponentState,
    httpPrefix: (row.httpPrefix as string | null | undefined) ?? null,
  };
  const { parent, name, args } = row as { parent?: string | null; name?: string | null; args?: unknown[] | null };
  if (parent == null && name == null && args == null) return { ...base, parent: null, name: null };
  if (parent != null && name != null && args != null)
    return {
      ...base,
      parent,
      name,
      args: args as [string, unknown][],
      env: ((row.env as [string, EnvBinding][] | null | undefined) ?? []) as [string, EnvBinding][],
    };
  throw new ComponentMetadataError("Invalid component type");
}

const BY_PARENT_AND_NAME = "by_parent_and_name";

/** The root component's row (Convex's `root_component`), if a push wrote it. */
export async function rootComponent(db: Tx): Promise<ComponentMeta | null> {
  return componentInParent(db, null, null);
}

/** The child named `name` of `parent` (the root's row for `null`, `null`), as Convex's `component_in_parent`. */
export async function componentInParent(
  db: Tx,
  parent: string | null,
  name: string | null,
): Promise<ComponentMeta | null> {
  const row = await db.asSystem(() =>
    db
      .query(COMPONENTS_TABLE)
      .withIndex(BY_PARENT_AND_NAME, (q) => q.eq("parent", parent).eq("name", name))
      .first(),
  );
  return row ? componentMeta(row as Record<string, unknown>) : null;
}

/** A component's children, as Convex's `component_children`. */
export async function componentChildren(db: Tx, parent: string): Promise<ComponentMeta[]> {
  const rows = await db.asSystem(() =>
    db
      .query(COMPONENTS_TABLE)
      .withIndex(BY_PARENT_AND_NAME, (q) => q.eq("parent", parent))
      .collect(),
  );
  return rows.map((r) => componentMeta(r as Record<string, unknown>));
}

/**
 * A component's path, its names from the root (`[]` for the root), or null if it has no row (Convex's
 * `get_component_path`).
 */
export async function componentPath(db: Tx, id: string): Promise<string[] | null> {
  const path: string[] = [];
  let current: string | null = id;
  while (current !== null) {
    const row = await db.asSystem(() => db.get(COMPONENTS_TABLE, current as string));
    if (!row) return null;
    const meta = componentMeta(row as Record<string, unknown>);
    if (meta.parent === null) break;
    path.push(meta.name);
    current = meta.parent;
  }
  return path.reverse();
}

/** The component at `path` (names from the root), or null, as Convex's `resolve_path`. */
export async function resolveComponentPath(db: Tx, path: readonly string[]): Promise<ComponentMeta | null> {
  let component = await rootComponent(db);
  for (const name of path) {
    if (component === null) return null;
    component = await componentInParent(db, component._id, name);
  }
  return component;
}

/**
 * Every component's path, by id (Convex's `all_component_paths`): the root's under `null`, there even when no push
 * wrote its row; a component whose chain to the root is broken is left out.
 */
export async function allComponentPaths(db: Tx): Promise<Map<string | null, string[]>> {
  const rows = (await db.asSystem(() => db.query(COMPONENTS_TABLE).collect())).map((r) =>
    componentMeta(r as Record<string, unknown>),
  );
  const byId = new Map(rows.map((r) => [r._id, r]));
  const paths = new Map<string | null, string[]>();
  for (const r of rows) {
    const path: string[] = [];
    let current: ComponentMeta | undefined = r;
    while (current && current.parent !== null) {
      path.push(current.name);
      current = byId.get(current.parent);
    }
    if (!current) continue;
    if (path.length) paths.set(r._id, path.reverse());
  }
  paths.set(null, []);
  return paths;
}

/** A path as Convex prints it: names joined with `/`, `""` for the root. */
export const formatComponentPath = (path: readonly string[]) => path.join("/");

/**
 * The system tables each component has in its own namespace, at the root's numbers (Convex's
 * `initialize_component_namespace`, crates/model/src/components/config.rs; checked against a store the Convex binary
 * wrote). The others (`_tables`, `_index`, `_components`, `_environment_variables`, `_function_handles`, …) are
 * global.
 */
export const COMPONENT_NAMESPACE_TABLES: ReadonlySet<string> = new Set([
  "_schemas",
  "_schema_validation_progress",
  "_schema_validations",
  "_modules",
  "_udf_config",
  "_source_packages",
  "_scheduled_jobs",
  "_scheduled_job_args",
  "_file_storage",
  "_cron_jobs",
  "_cron_next_run",
  "_cron_job_logs",
]);
