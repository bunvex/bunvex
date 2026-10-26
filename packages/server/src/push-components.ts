// A push with components (STUDY-153 §1.1, §1.2, §1.6; PR 3c): the request's definitions read as Convex's
// `StartPushRequest::into_project_config` reads them, the schema change walked over the existing and the new trees as
// Convex's `start_component_schema_changes` (crates/model/src/components/config.rs), and the parts of `start_push`'s
// answer that are per component (`analysis`, `schemaChange`).
import {
  type ComponentExport,
  type ComponentMeta,
  componentDefinitionRow,
  componentMeta,
  componentRow,
  type Engine,
  type EngineSchema,
  type NewComponent,
  type NewComponentDefinition,
  schemaToJson,
  type TableDef,
  type Tx,
} from "@bunvex/core";
import type { ComponentDiff } from "./audit-log.ts";
import {
  clearCodeRows,
  modulePathsIn,
  type SourcePackage,
  type SourcePackageFields,
  setUdfConfigIn,
  type UdfServerVersionDiff,
  writeCodeRows,
} from "./code-store.ts";
import type { AnalyzedModule, LoadedCode, ModuleSource } from "./code-version.ts";
import { type CheckedComponent, fileBasedExports } from "./component-tree.ts";
import { cronSpecsJson } from "./cron-rows.ts";
import { DEFINITION_MODULE, definitionPathError } from "./definition-eval.ts";
import { indexAuditDiff, indexDiffJson } from "./push-audit.ts";
import { SERVER_VERSION } from "./server-version.ts";

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
    { definition: NewComponentDefinition; schema: EngineSchema | null; functions: Record<string, AnalyzedModule> }
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

const EMPTY: EngineSchema = { tables: {}, schemaValidation: false };

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
  schemas: ReadonlyMap<string, EngineSchema | null>,
  /** The app's schema; null when pushed without one. */
  rootSchema: EngineSchema | null,
  dryRun: boolean,
): Promise<ComponentsSchemaChange & { start: () => Promise<{ rootSchemaId: string | null }> }> {
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
  const childSchemas = new Map<string, EngineSchema | null>();
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

/** A definition's code as `finish_push` writes it: its package, its loaded modules, its other modules (no functions). */
export type DefinitionCode = { pkg: SourcePackageFields; version: LoadedCode; other: ModuleSource[] };

/** What `finishComponents` needs besides the transaction (Convex's `apply_component_definitions_diff` and tree diff). */
export type FinishComponentsInput = {
  definitions: ReadonlyMap<string, { definition: NewComponentDefinition; udfServerVersion: string | null }>;
  tree: CheckedComponent;
  change: ComponentsSchemaChange;
  /** Each definition's code, by definition path (two instances of one share it, as Convex's). */
  code: ReadonlyMap<string, DefinitionCode>;
  /** The app's import seed and time: every namespace's `_udf_config` has them. */
  importPhase: { seed: Uint32Array; timestamp: number };
  /** The app's server version change, made at `start_push`. */
  rootUdfConfigDiff: UdfServerVersionDiff | null;
  /** Each instance's index and schema change, by component path, read before the commit. */
  indexDiffs: ReadonlyMap<string, ComponentDiff["indexDiff"]>;
  schemaDiffs: ReadonlyMap<string, ComponentDiff["schemaDiff"]>;
  /** The `_components` table (global), whose rows a create inserts with their allocated ids. */
  componentsTable: TableDef;
  /** Apply a namespace's crons (null: the app's), Convex's `CronModel::apply`. */
  crons: (db: Tx, namespace: string | null, version: LoadedCode | null) => Promise<ComponentDiff["cronDiff"]>;
};

/** Module paths as Convex's `ModuleDiff` lists them (a `BTreeSet`): sorted, `_deps/` left out. */
const notDeps = (paths: string[]) => paths.filter((p) => !p.startsWith("_deps/")).sort();
const pathsDiff = (before: string[], after: string[]) => ({
  added: notDeps(after.filter((p) => !before.includes(p))),
  removed: notDeps(before.filter((p) => !after.includes(p))),
});
const EMPTY_INDEX_DIFF: ComponentDiff["indexDiff"] = {
  added_indexes: [],
  removed_indexes: [],
  enabled_indexes: [],
  disabled_indexes: [],
};

/**
 * In `finish_push`'s ONE commit (Convex's `apply_component_definitions_diff` and `apply_component_tree_diff`): the
 * `_component_definitions` rows replaced, inserted, or deleted when no longer pushed; then the existing and the new
 * trees walked together, each instance created (its `_components` row with the id `start_push` allocated), modified,
 * remounted or unmounted, with its namespace's code (`_source_packages`, `_modules`), `_udf_config` and crons. A
 * component another push created meanwhile under another id is a 409 `RaceDetected`. Each definition's diff (`{}`)
 * and each instance's, by path; the packages no row names any more.
 */
export async function finishComponents(db: Tx, input: FinishComponentsInput) {
  const definitionDiffs = new Map<string, Record<string, never>>();
  const definitionIds = new Map<string, string>();
  await db.asSystem(async () => {
    const existing = await db.query("_component_definitions").collect();
    for (const row of existing) {
      const path = row.path as string;
      if (input.definitions.has(path)) definitionIds.set(path, row._id as string);
      else {
        await db.delete("_component_definitions", row._id as string);
        definitionDiffs.set(path, {});
      }
    }
    for (const [path, d] of input.definitions) {
      // Stored with its exports empty, as Convex's (`load_all_definitions` clears them).
      const row = componentDefinitionRow({ ...d.definition, exports: { type: "branch", branch: [] } });
      const id = definitionIds.get(path);
      if (id) await db.replace("_component_definitions", id, row);
      else definitionIds.set(path, await db.insert("_component_definitions", row));
      definitionDiffs.set(path, {});
    }
  });

  const rows = (await db.asSystem(() => db.query("_components").collect())).map((r) =>
    componentMeta(r as Record<string, unknown>),
  );
  const childrenOf = (parent: string) =>
    rows.filter((r): r is ComponentMeta & { name: string } => r.parent === parent && r.name !== null);
  const componentDiffs = new Map<string, ComponentDiff>();
  const unused: SourcePackage[] = [];

  /** An instance's code written in its namespace: its module diff, its server version's, its crons'. */
  const writeCode = async (key: string, ns: string | null, node: CheckedComponent) => {
    const code = input.code.get(node.definitionPath);
    if (!code) throw new Error(`Missing code for component definition ${node.definitionPath}`);
    const before = await modulePathsIn(db, ns);
    unused.push(...(await writeCodeRows(db, code.pkg, code.version, code.other, ns)));
    // What `writeCodeRows` left: the version's modules and the others.
    const after = [...code.version.modules.keys(), ...code.other.map((m) => m.path)];
    const udfConfigDiff =
      ns === null
        ? input.rootUdfConfigDiff
        : await setUdfConfigIn(db, ns, {
            serverVersion: input.definitions.get(node.definitionPath)?.udfServerVersion ?? SERVER_VERSION,
            ...input.importPhase,
          });
    return {
      moduleDiff: pathsDiff(before, after),
      udfConfigDiff,
      cronDiff: await input.crons(db, ns, code.version),
      indexDiff: input.indexDiffs.get(key) ?? EMPTY_INDEX_DIFF,
      schemaDiff: input.schemaDiffs.get(key) ?? null,
    };
  };

  type Visit = { path: string[]; parent: string | null; existing: ComponentMeta | null; node: CheckedComponent | null };
  const stack: Visit[] = [
    { path: [], parent: null, existing: rows.find((r) => r.parent === null) ?? null, node: input.tree },
  ];
  for (let visit = stack.pop(); visit; visit = stack.pop()) {
    const { path, parent, existing, node } = visit;
    const key = path.join("/");
    const root = path.length === 0;
    let id: string;
    if (node) {
      const definitionId = definitionIds.get(node.definitionPath);
      if (!definitionId) throw new Error(`Missing definition id for ${node.definitionPath}`);
      const meta: NewComponent = root
        ? { definitionId, parent: null, name: null, state: "active", httpPrefix: node.httpPrefix }
        : {
            definitionId,
            parent: parent!,
            name: path.at(-1)!,
            args: [...node.args].map(([k, r]) => [k, r]),
            env: [...node.env],
            state: "active",
            httpPrefix: node.httpPrefix,
          };
      if (!existing) {
        const allocated = input.change.allocatedComponentIds.get(key);
        if (!allocated) throw new Error(`Missing allocated component id for ${key || "the app"}`);
        await db.asSystem(() => db.importInsert(input.componentsTable, { _id: allocated, ...componentRow(meta) }));
        id = allocated;
        componentDiffs.set(key, { diffType: { type: "create" }, ...(await writeCode(key, root ? null : id, node)) });
      } else {
        const allocated = input.change.allocatedComponentIds.get(key);
        if (allocated !== undefined && allocated !== existing._id)
          throw new RaceError(`Component ${key} was created by a concurrent push`);
        id = existing._id;
        await db.asSystem(() => db.replace("_components", id, componentRow(meta)));
        const type = existing.state === "unmounted" ? "remount" : "modify";
        componentDiffs.set(key, { diffType: { type }, ...(await writeCode(key, root ? null : id, node)) });
      }
    } else {
      // Removed: unmounted, its code and crons cleared, its data kept; one unmounted already is left, with its
      // children (Convex does not recurse into it).
      if (!existing || existing.state === "unmounted") continue;
      id = existing._id;
      await db.asSystem(() => db.replace("_components", id, componentRow({ ...existing, state: "unmounted" })));
      const removed = await clearCodeRows(db, id);
      componentDiffs.set(key, {
        diffType: { type: "unmount" },
        moduleDiff: { added: [], removed: notDeps(removed) },
        udfConfigDiff: null,
        cronDiff: await input.crons(db, id, null),
        indexDiff: EMPTY_INDEX_DIFF,
        schemaDiff: null,
      });
    }
    const seen = new Set<string>();
    for (const c of childrenOf(id)) {
      seen.add(c.name);
      stack.push({ path: [...path, c.name], parent: id, existing: c, node: node?.childComponents.get(c.name) ?? null });
    }
    for (const [name, c] of node?.childComponents ?? [])
      if (!seen.has(name)) stack.push({ path: [...path, name], parent: id, existing: null, node: c });
  }
  return { definitionDiffs, componentDiffs, unused };
}

/** A component a concurrent push created: Convex's 409 `RaceDetected`. */
export class RaceError extends Error {
  readonly code = "RaceDetected";
}
