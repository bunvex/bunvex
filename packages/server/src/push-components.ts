// A push with components (STUDY-153 §1.1, §1.2, §1.6; PR 3c): the request's definitions read as Convex's
// `StartPushRequest::into_project_config` reads them, the schema change walked over the existing and the new trees as
// Convex's `start_component_schema_changes` (crates/model/src/components/config.rs), and the parts of `start_push`'s
// answer that are per component (`analysis`, `schemaChange`).
import {
  type ComponentExport,
  type ComponentMeta,
  componentDefinitionRow,
  componentMeta,
  type Engine,
  type NewComponentDefinition,
  type SchemaDefinition,
  schemaToJson,
} from "@bunvex/core";
import type { AnalyzedModule, ModuleSource } from "./code-version.ts";
import { type CheckedComponent, fileBasedExports } from "./component-tree.ts";
import { cronSpecsJson } from "./cron-rows.ts";
import { DEFINITION_MODULE, definitionPathError } from "./definition-eval.ts";
import { indexAuditDiff, indexDiffJson } from "./push-audit.ts";

/** A pushed component definition (Convex's `ComponentDefinitionConfig`). */
export type ComponentDefinitionConfig = {
  definitionPath: string;
  definition: ModuleSource;
  dependencies: string[];
  schema: ModuleSource | null;
  functions: ModuleSource[];
  udfServerVersion: string;
};

/** What a push sends of its components: the app's definition module and imports, and each component definition. */
export type PushedComponents = {
  definition: ModuleSource | null;
  dependencies: string[];
  components: ComponentDefinitionConfig[];
};

/** A request Convex's `into_project_config` refuses: a 400 `InvalidConfig`, its text with no "while pushing". */
export class InvalidConfigError extends Error {
  readonly code = "InvalidConfig";
}

const definitionPath = (path: unknown): string => {
  if (typeof path !== "string") throw new InvalidConfigError("A component definition path must be a string");
  const error = definitionPathError(path);
  if (error !== null) throw new InvalidConfigError(error);
  return path;
};

/**
 * The request's components, as Convex's `TryFrom<AppDefinitionConfigJson>` and `TryFrom<ComponentDefinitionConfigJson>`
 * read them, the app's first: each definition path (`ComponentDefinitionPath`), and no `"use node"` module in a
 * component (`NodeActionsNotSupported`, which reaches the client as `InvalidConfig`).
 */
export function parsePushedComponents(
  app: { definition?: ModuleSource | null; dependencies?: unknown } | undefined,
  components: unknown,
): PushedComponents {
  const dependencies = ((app?.dependencies ?? []) as unknown[]).map(definitionPath);
  const configs = ((components ?? []) as Record<string, unknown>[]).map((c): ComponentDefinitionConfig => {
    const functions = (c.functions ?? []) as ModuleSource[];
    for (const m of functions)
      if (m.environment === "node")
        throw new InvalidConfigError(
          `Node actions are not supported in components. Remove \`"use node;" from ${m.path}`,
        );
    return {
      definitionPath: definitionPath(c.definitionPath),
      definition: c.definition as ModuleSource,
      dependencies: ((c.dependencies ?? []) as unknown[]).map(definitionPath),
      schema: (c.schema ?? null) as ModuleSource | null,
      functions,
      udfServerVersion: c.udfServerVersion as string,
    };
  });
  return { definition: app?.definition ?? null, dependencies, components: configs };
}

/** The app's definition when a push sends none (Convex's `ComponentDefinitionMetadata::default_root`). */
export const DEFAULT_ROOT: NewComponentDefinition = {
  path: "",
  definitionType: { type: "app" },
  childComponents: [],
  httpMounts: {},
  httpPrefix: null,
  exports: { type: "branch", branch: [] },
  envVars: [],
};

/** Paths as Convex orders them (`ComponentPath`, `ComponentDefinitionPath`): segment by segment, `""` first. */
export function byPath(a: string, b: string): number {
  const x = a === "" ? [] : a.split("/");
  const y = b === "" ? [] : b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length - y.length;
}
const sortedObject = <T>(entries: [string, T][]) => Object.fromEntries([...entries].sort(([a], [b]) => byPath(a, b)));

/** A definition's exports as its analysis answers them: Convex's `file_based_exports`, each leaf a function reference. */
function exportsOf(functions: Record<string, AnalyzedModule>): ComponentExport & { type: "branch" } {
  const branch = (tree: ReturnType<typeof fileBasedExports>): ComponentExport & { type: "branch" } => ({
    type: "branch",
    branch: [...tree].map(([k, node]): [string, ComponentExport] => [
      k,
      node.type === "branch" ? branch(node.branch) : { type: "leaf", leaf: `_reference/function/${node.udfPath}` },
    ]),
  });
  return branch(fileBasedExports(functions));
}

/** A module's analysis as `start_push` answers it (Convex's `SerializedAnalyzedModule`). */
export const analysisJson = (m: AnalyzedModule) => ({
  functions: m.functions,
  httpRoutes: m.httpRoutes,
  cronSpecs: cronSpecsJson(m.cronSpecs),
  sourceMapped: null,
});

/**
 * `start_push`'s `analysis` (Convex's `EvaluatedComponentDefinition`s, by definition path): each definition, its
 * schema, its modules' analysis; a component's definition with its exports filled (`file_based_exports`), the app's
 * left empty, as Convex's.
 */
export function analysisAnswer(
  definitions: ReadonlyMap<
    string,
    { definition: NewComponentDefinition; schema: SchemaDefinition | null; functions: Record<string, AnalyzedModule> }
  >,
) {
  return sortedObject(
    [...definitions].map(([path, d]) => [
      path,
      {
        definition: componentDefinitionRow(
          path === "" ? d.definition : { ...d.definition, exports: exportsOf(d.functions) },
        ),
        schema: d.schema === null ? null : schemaToJson(d.schema),
        functions: Object.fromEntries(Object.entries(d.functions).map(([p, m]) => [p, analysisJson(m)])),
        udfConfig: null,
      },
    ]),
  );
}

/** A push's schema change across its components (Convex's `SchemaChange`). */
export type ComponentsSchemaChange = {
  /** The `_components` ids the push allocated, by component path (the app's under `""` on its first push). */
  allocatedComponentIds: Map<string, string>;
  /** Each component's pending schema, by path: null for one without a schema. The app's under `""`. */
  schemaIds: Map<string, string | null>;
  indexDiffs: Map<string, ReturnType<typeof indexDiffJson>>;
  /** Each component's namespace, by path (`null` for the app's), for the components in the new tree. */
  namespaces: Map<string, string | null>;
};

const EMPTY: SchemaDefinition = { tables: {}, schemaValidation: false };

/**
 * Convex's `start_component_schema_changes`: the existing `_components` tree and the new one walked together (each
 * node's existing children, then its new ones), a new component's namespace made (`initializeComponentNamespace`;
 * the app's first push allocates its id only), each new or kept component's index diff and pending schema, a removed
 * one left as it is. A dry run writes nothing (DV-444): no namespace, no schema; the index diffs only, a new
 * component's against nothing.
 */
export async function startComponentSchemas(
  engine: Engine,
  app: CheckedComponent,
  schemas: ReadonlyMap<string, SchemaDefinition | null>,
  rootSchema: SchemaDefinition,
  dryRun: boolean,
): Promise<ComponentsSchemaChange & { start: () => Promise<{ rootSchemaId: string }> }> {
  const rows = (await engine.query((db) => db.asSystem(() => db.query("_components").collect()))).map((r) =>
    componentMeta(r as Record<string, unknown>),
  );
  const childrenOf = (parent: string | null) =>
    rows.filter((r): r is ComponentMeta & { name: string } => r.parent === parent && r.name !== null);
  const change: ComponentsSchemaChange = {
    allocatedComponentIds: new Map(),
    schemaIds: new Map(),
    indexDiffs: new Map(),
    namespaces: new Map(),
  };
  const childSchemas = new Map<string, SchemaDefinition | null>();
  type Visit = { path: string[]; existing: ComponentMeta | null; node: CheckedComponent | null };
  const stack: Visit[] = [{ path: [], existing: rows.find((r) => r.parent === null) ?? null, node: app }];
  for (let visit = stack.pop(); visit; visit = stack.pop()) {
    const { path, existing, node } = visit;
    const key = path.join("/");
    const root = path.length === 0;
    let id = existing?._id ?? null;
    if (id === null && !dryRun) {
      id = root ? await engine.allocateComponentId() : await engine.initializeComponentNamespace();
      change.allocatedComponentIds.set(key, id);
    }
    if (node) {
      const schema = root ? rootSchema : (schemas.get(node.definitionPath) ?? null);
      const before = root ? engine.schema : existing ? engine.componentSchema(existing._id) : EMPTY;
      change.indexDiffs.set(key, indexDiffJson(indexAuditDiff(before, schema ?? EMPTY)));
      change.namespaces.set(key, root ? null : id);
      if (!root && id !== null) childSchemas.set(id, schema);
    }
    // Convex's `tree_diff_children`: the existing children first, then the new ones not among them.
    const existingChildren = id === null ? [] : childrenOf(id);
    const seen = new Set<string>();
    for (const c of existingChildren) {
      seen.add(c.name);
      stack.push({ path: [...path, c.name], existing: c, node: node?.childComponents.get(c.name) ?? null });
    }
    for (const [name, c] of node?.childComponents ?? [])
      if (!seen.has(name)) stack.push({ path: [...path, name], existing: null, node: c });
  }
  return {
    ...change,
    start: async () => {
      const started = await engine.startSchemaPush(rootSchema, childSchemas);
      change.schemaIds.set("", started.schemaId);
      for (const [key, ns] of change.namespaces)
        if (ns !== null) change.schemaIds.set(key, started.components.get(ns)?.schemaId ?? null);
      return { rootSchemaId: started.schemaId };
    },
  };
}

/** `start_push`'s `schemaChange` (Convex's `SerializedSchemaChange`), every map by component path. */
export function schemaChangeAnswer(change: ComponentsSchemaChange) {
  return {
    allocatedComponentIds: sortedObject([...change.allocatedComponentIds]),
    schemaIds: sortedObject([...change.schemaIds]),
    indexDiffs: sortedObject([...change.indexDiffs]),
  };
}

/** The definition module's name a push stores (DV-494), whatever path the request gave it, as Convex's. */
export const definitionModule = (m: ModuleSource): ModuleSource => ({ ...m, path: DEFINITION_MODULE });
