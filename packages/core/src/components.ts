// The component registry (STUDY-152 step 2): Convex's `_components` rows, a component's path in the tree and back,
// and the namespace a new component's tables live in. As Convex's `ComponentRegistry`
// (crates/database/src/component_registry.rs), lookups read `_components` through `by_parent_and_name` and `by_id`
// in the transaction, so a query that resolves a path re-runs when the tree changes.
import { COMPONENTS_TABLE } from "./catalog.ts";
import type { Tx } from "./tx.ts";

/** A list of `[key, value]` pairs as Convex keeps a `BTreeMap`: by key, so a row reads back in key order. */
const byKey = <T>(pairs: [string, T][]): [string, T][] => [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

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
 * for the root; `args` and `env` by key; `state` always written.
 */
export function componentRow(m: NewComponent): Record<string, unknown> {
  return {
    definitionId: m.definitionId,
    parent: m.parent,
    name: m.name,
    args: m.parent === null ? null : byKey(m.args),
    env: m.parent === null ? null : byKey(m.env),
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

/** A component's exports (Convex's `SerializedComponentExport`): a branch of named exports, or a function's reference. */
export type ComponentExport = { type: "branch"; branch: [string, ComponentExport][] } | { type: "leaf"; leaf: string };
/** A declared environment variable's validator (Convex's `SerializedEnvVarValidator`): its JSON as a string. */
export type EnvVarValidator = { type: "value"; value: string; optional?: true };
/** A legacy component argument or argument validator (Convex's): a JSON string. Today's JS API has none (K6). */
export type ComponentArgument = { type: "value"; value: string };
/** A child a definition mounts (Convex's `SerializedComponentInstantiation`). */
export type ComponentInstantiation = {
  name: string;
  path: string;
  args: [string, ComponentArgument][] | null;
  env: [string, EnvBinding][];
};
/** What a definition is (Convex's `SerializedComponentDefinitionType`): the app, or a child component. */
export type ComponentDefinitionType =
  | { type: "app" }
  | { type: "childComponent"; name: string; args: [string, ComponentArgument][] };

/**
 * A `_component_definitions` row read back (Convex's `ComponentDefinitionMetadata`): one per definition a push
 * evaluated, by path (`""` for the app's). Its maps (`httpMounts`, a branch's exports, `env`, `envVars`) are by key.
 */
export type ComponentDefinitionMeta = {
  _id: string;
  path: string;
  definitionType: ComponentDefinitionType;
  childComponents: ComponentInstantiation[];
  httpMounts: Record<string, string>;
  httpPrefix: string | null;
  exports: ComponentExport & { type: "branch" };
  envVars: [string, EnvVarValidator][];
};
/** A definition's fields without its id: what a new row is written from. */
export type NewComponentDefinition = Omit<ComponentDefinitionMeta, "_id">;

const sortExports = (e: ComponentExport): ComponentExport =>
  e.type === "leaf" ? e : { type: "branch", branch: byKey(e.branch.map(([k, v]) => [k, sortExports(v)])) };

/**
 * A `_component_definitions` row as Convex stores it (`SerializedComponentDefinitionMetadata`): each child tagged
 * `SerializedComponentInstantiation`, `envVars` null when none are declared, every map by key (checked against a
 * store the Convex binary wrote).
 */
export function componentDefinitionRow(m: NewComponentDefinition): Record<string, unknown> {
  return {
    path: m.path,
    definitionType:
      m.definitionType.type === "app"
        ? { type: "app" }
        : { type: "childComponent", name: m.definitionType.name, args: byKey(m.definitionType.args) },
    childComponents: m.childComponents.map((c) => ({
      type: "SerializedComponentInstantiation",
      name: c.name,
      path: c.path,
      args: c.args && byKey(c.args),
      env: byKey(c.env),
    })),
    httpMounts: Object.fromEntries(byKey(Object.entries(m.httpMounts))),
    httpPrefix: m.httpPrefix,
    exports: sortExports(m.exports),
    envVars: m.envVars.length ? byKey(m.envVars) : null,
  };
}

const isPairs = (v: unknown): v is [string, unknown][] =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string");

function readExports(e: unknown): ComponentExport {
  const x = e as { type?: unknown; branch?: unknown; leaf?: unknown } | null;
  if (x?.type === "leaf" && typeof x.leaf === "string") return { type: "leaf", leaf: x.leaf };
  if (x?.type === "branch" && isPairs(x.branch))
    return { type: "branch", branch: x.branch.map(([k, v]) => [k, readExports(v)]) };
  throw new ComponentMetadataError("Invalid component exports");
}

/** Convex's `HttpMountPath`: starting and ending with `/`, no `*`, no query. */
const isHttpMountPath = (s: unknown): s is string =>
  typeof s === "string" && s.startsWith("/") && s.endsWith("/") && !s.includes("*") && !s.includes("?");

/** A `_component_definitions` row read back, checked as Convex's `TryFrom<SerializedComponentDefinitionMetadata>`. */
export function componentDefinitionMeta(row: Record<string, unknown>): ComponentDefinitionMeta {
  const fail = (what: string): never => {
    throw new ComponentMetadataError(`Invalid component definition: ${what}`);
  };
  if (typeof row.path !== "string") fail("path");
  const type = row.definitionType as { type?: unknown; name?: unknown; args?: unknown } | null | undefined;
  let definitionType: ComponentDefinitionType;
  if (type?.type === "app") definitionType = { type: "app" };
  else if (type?.type === "childComponent" && typeof type.name === "string" && isPairs(type.args))
    definitionType = { type: "childComponent", name: type.name, args: type.args as [string, ComponentArgument][] };
  else return fail("definitionType");
  if (!Array.isArray(row.childComponents)) fail("childComponents");
  const childComponents = (row.childComponents as Record<string, unknown>[]).map((c): ComponentInstantiation => {
    if (typeof c?.name !== "string" || typeof c.path !== "string") fail("childComponents");
    if (c.args !== null && !isPairs(c.args)) fail("childComponents");
    const env = c.env ?? [];
    if (!isPairs(env)) fail("childComponents");
    return {
      name: c.name as string,
      path: c.path as string,
      args: c.args as [string, ComponentArgument][] | null,
      env: env as [string, EnvBinding][],
    };
  });
  const mounts = (row.httpMounts ?? {}) as Record<string, unknown>;
  if (typeof mounts !== "object" || Array.isArray(mounts)) fail("httpMounts");
  for (const [k, v] of Object.entries(mounts)) if (!isHttpMountPath(k) || typeof v !== "string") fail("httpMounts");
  const httpPrefix = (row.httpPrefix ?? null) as unknown;
  if (httpPrefix !== null && !isHttpMountPath(httpPrefix)) fail("httpPrefix");
  const exports = readExports(row.exports);
  if (exports.type !== "branch") fail("exports");
  const envVars = row.envVars ?? [];
  if (!isPairs(envVars)) fail("envVars");
  return {
    _id: row._id as string,
    path: row.path as string,
    definitionType,
    childComponents,
    httpMounts: mounts as Record<string, string>,
    httpPrefix: httpPrefix as string | null,
    exports: exports as ComponentExport & { type: "branch" },
    envVars: envVars as [string, EnvVarValidator][],
  };
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
