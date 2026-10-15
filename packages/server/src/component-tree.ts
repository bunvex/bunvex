// The components' tree of a push (STUDY-153 §1.5; PR 3b): the evaluated definitions (`definition-eval.ts`) checked
// and instantiated from the app's, as Convex's `TypecheckContext` (crates/model/src/components/type_checking.rs),
// with the declaration check before it (`validate_env_var_declarations`, crates/application/src/deploy_config.rs)
// and each component's exports from its public functions (`file_based_exports`,
// crates/model/src/components/file_based_routing.rs).
//
// Every refusal is Convex's `TypecheckError` (or `InvalidEnvVarDeclaration` / `InvalidExport` /
// `InvalidModulePath`), its text Convex's byte for byte: the values are printed as Rust's `Debug` prints them
// (`[ComponentName(Identifier("counter"))]`, `ComponentDefinitionPath { path: "" }`, `HttpMountPath("/c/")`,
// `Identifier("X")`), and the "definition not found" text keeps Convex's unformatted `{definition_path:?}`
// (STUDY-153 C-5).
import { type EnvBinding, type NewComponentDefinition, validatorIsSubset } from "@bunvex/core";
import { checkValue, fromJsonValue, type Value, validatorFromJson } from "@bunvex/values";
import type { AnalyzedModule } from "./code-version.ts";

/** A definition as the push evaluated it (Convex's `EvaluatedComponentDefinition`): its metadata and its modules. */
export type EvaluatedDefinition = {
  definition: NewComponentDefinition;
  /** Each function module's analysis, by module path (`lib.js`). */
  functions: Record<string, AnalyzedModule>;
};

/** A component's resource (Convex's `Resource`): a legacy argument's value, or one of its functions. */
export type Resource =
  | { type: "value"; value: string }
  | { type: "function"; path: { component: string; udfPath: string } };
/** A component's exports, resolved (Convex's `ResourceTree`). */
export type ResourceTree =
  | { type: "branch"; children: Map<string, ResourceTree> }
  | { type: "leaf"; resource: Resource };

/** A component in the push's tree (Convex's `CheckedComponent`). */
export type CheckedComponent = {
  definitionPath: string;
  /** Its names from the root (`[]` for the app). */
  componentPath: string[];
  /** Where its HTTP routes are served: the app's `httpPrefix`, a child's mount path. */
  httpPrefix: string | null;
  args: Map<string, Resource>;
  env: Map<string, EnvBinding>;
  childComponents: Map<string, CheckedComponent>;
  httpRoutes: { httpModuleRoutes: { method: string; path: string }[] | null; mounts: Set<string> };
  exports: Map<string, ResourceTree>;
};

/** A push's tree that cannot be: Convex's `ErrorMetadata`, a 400. */
export class ComponentTreeError extends Error {
  readonly status = 400;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComponentTreeError";
  }
}
const typecheck = (message: string) => new ComponentTreeError("TypecheckError", message);

// Rust's `Debug` of Convex's values, as its messages print them.
const debugString = (s: string) => JSON.stringify(s);
const debugIdentifier = (s: string) => `Identifier(${debugString(s)})`;
const debugName = (s: string) => `ComponentName(${debugIdentifier(s)})`;
const debugComponentPath = (path: readonly string[]) => `[${path.map(debugName).join(", ")}]`;
const debugDefinitionPath = (path: string) => `ComponentDefinitionPath { path: ${debugString(path)} }`;
const debugMount = (path: string) => `HttpMountPath(${debugString(path)})`;

/** A validator's JSON as a schema stores it. */
type ValidatorJson = { type: string; value?: unknown };
const parsed = (json: string) => JSON.parse(json) as ValidatorJson;

/** Convex's `is_string_like_validator`: `v.string()`, a string literal, or a union of those. */
function isStringLike(v: ValidatorJson): boolean {
  if (v.type === "string") return true;
  if (v.type === "literal") return typeof v.value === "string";
  if (v.type === "union") return (v.value as ValidatorJson[]).every(isStringLike);
  return false;
}

/**
 * Convex's `validate_env_var_declarations`: every declared variable, of every definition (by path, the app's first),
 * string-like, else `InvalidEnvVarDeclaration`.
 */
export function checkEnvVarDeclarations(definitions: ReadonlyMap<string, EvaluatedDefinition>) {
  for (const path of [...definitions.keys()].sort()) {
    for (const [name, validator] of definitions.get(path)!.definition.envVars) {
      if (isStringLike(parsed(validator.value))) continue;
      const label = path === "" ? "the app" : `component ${path}`;
      throw new ComponentTreeError(
        "InvalidEnvVarDeclaration",
        `Env var \`${name}\` on ${label} has a non-string validator. Component env vars must be declared with \`v.string()\`, \`v.literal("...")\`, or a union of those.`,
      );
    }
  }
}

/** Convex's `instantiate_root`: the app's definition instantiated, its children in turn. */
export function instantiateRoot(
  definitions: ReadonlyMap<string, EvaluatedDefinition>,
  options: { validateEnvVars?: boolean } = {},
): CheckedComponent {
  const root = definitions.get("");
  if (!root) throw typecheck("Root component definition not found");
  return instantiate(
    definitions,
    options.validateEnvVars ?? true,
    "",
    [],
    new Map(),
    new Map(),
    root.definition.httpPrefix,
  );
}

const byKey = <T>(m: Map<string, T>) => new Map([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function instantiate(
  definitions: ReadonlyMap<string, EvaluatedDefinition>,
  validateEnvVars: boolean,
  definitionPath: string,
  componentPath: string[],
  args: Map<string, Resource>,
  env: Map<string, EnvBinding>,
  httpPrefix: string | null,
): CheckedComponent {
  const evaluated = definitions.get(definitionPath);
  // Convex's text, its `format!` missing (type_checking.rs:149).
  if (!evaluated) throw typecheck("Component definition not found: {definition_path:?}");
  const { definition } = evaluated;
  checkArgs(definition, componentPath, args, env, validateEnvVars);
  const declared = new Map(definition.envVars);

  // Each child's mount path, from the definition's mounts naming a direct child.
  const mountOf = new Map<string, string>();
  for (const [mount, reference] of Object.entries(definition.httpMounts)) {
    const parts = reference.split("/");
    if (parts[1] === "childComponent" && parts.length === 3) mountOf.set(parts[2]!, mount);
  }

  const children = new Map<string, CheckedComponent>();
  for (const instantiation of definition.childComponents) {
    // The legacy initializer (`args: null`) is not built: no client this side of 1.46 sends one (STUDY-153 C-13).
    if (instantiation.args === null)
      throw typecheck(`Component ${debugComponentPath([...componentPath, instantiation.name])} has no arguments`);
    const childArgs = new Map<string, Resource>(
      instantiation.args.map(([name, a]) => [name, { type: "value", value: a.value }]),
    );
    const childPath = [...componentPath, instantiation.name];
    const child = definitions.get(instantiation.path);
    if (!child) throw typecheck(`Component definition not found: ${debugDefinitionPath(instantiation.path)}`);
    const bindings = new Map(instantiation.env);
    checkComponentEnv(childPath, new Map(child.definition.envVars), bindings, declared);
    // A binding to a parent's variable: the app's stays a deployment variable; below it, the parent's own binding
    // replaces it, or it is dropped when the parent has none (an optional, unbound variable).
    const resolved = new Map<string, EnvBinding>();
    for (const [name, b] of bindings) {
      if (b.type === "value" || componentPath.length === 0) resolved.set(name, b);
      else {
        const parent = env.get(b.name);
        if (parent) resolved.set(name, parent);
      }
    }
    // Its prefix: its mount path, under its parent's prefix below the root.
    const mount = mountOf.get(instantiation.name);
    const childPrefix =
      mount === undefined
        ? null
        : componentPath.length > 0 && httpPrefix !== null
          ? `${httpPrefix.replace(/\/+$/, "")}${mount}`
          : mount;
    const checked = instantiate(
      definitions,
      validateEnvVars,
      instantiation.path,
      childPath,
      childArgs,
      resolved,
      childPrefix,
    );
    if (children.has(instantiation.name))
      throw typecheck(
        `Component ${debugDefinitionPath(definitionPath)} has multiple child components with the same name: ${debugName(instantiation.name)}`,
      );
    children.set(instantiation.name, checked);
  }

  const httpModuleRoutes = evaluated.functions["http.js"]?.httpRoutes?.map((r) => r.route) ?? null;
  const httpRoutes = { httpModuleRoutes, mounts: new Set<string>() };
  for (const [mount, reference] of Object.entries(definition.httpMounts).sort(([a], [b]) => (a < b ? -1 : 1)))
    insertMount(definitions, children, httpRoutes, mount, reference);

  return {
    definitionPath,
    componentPath,
    httpPrefix,
    args,
    env,
    childComponents: children,
    httpRoutes,
    exports: resolveExports(fileBasedExports(evaluated.functions), evaluated, componentPath),
  };
}

/** Convex's `check_args`: the app has no arguments; every binding declared; a child's required variables bound. */
function checkArgs(
  definition: NewComponentDefinition,
  componentPath: string[],
  args: Map<string, Resource>,
  env: Map<string, EnvBinding>,
  validateEnvVars: boolean,
) {
  if (definition.definitionType.type === "app") {
    if (args.size > 0) throw typecheck("Can't have arguments for the root app");
  } else {
    const validators = new Map(definition.definitionType.args);
    for (const [name, resource] of [...args].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const validator = validators.get(name);
      if (!validator)
        throw typecheck(
          `Component ${debugComponentPath(componentPath)} has no argument named ${debugIdentifier(name)}`,
        );
      if (resource.type !== "value") throw typecheck("Function references are not supported");
      const problem = checkValue(
        validatorFromJson(parsed(validator.value) as never),
        fromJsonValue(JSON.parse(resource.value)) as Value,
      );
      if (problem !== null)
        throw typecheck(
          `Component ${debugComponentPath(componentPath)} has an invalid value for argument ${debugIdentifier(name)}: ${problem}`,
        );
    }
  }
  const declared = new Map(definition.envVars);
  for (const name of [...env.keys()].sort())
    if (!declared.has(name))
      throw typecheck(`Component ${debugComponentPath(componentPath)} has no env var named ${debugIdentifier(name)}`);
  if (componentPath.length > 0 && validateEnvVars)
    for (const [name, v] of [...declared].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!v.optional && !env.has(name))
        throw typecheck(
          `Component ${debugComponentPath(componentPath)} is missing required env var ${debugIdentifier(name)}`,
        );
}

/** Convex's `validate_component_env`: a child's bindings against its declarations and its parent's. */
function checkComponentEnv(
  componentPath: string[],
  validators: Map<string, NewComponentDefinition["envVars"][number][1]>,
  bindings: Map<string, EnvBinding>,
  parentValidators: Map<string, NewComponentDefinition["envVars"][number][1]>,
) {
  const at = debugComponentPath(componentPath);
  for (const [name, binding] of [...bindings].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const child = validators.get(name);
    if (!child) throw typecheck(`Component ${at} has no env var named ${debugIdentifier(name)}`);
    if (binding.type === "value") {
      const problem = checkValue(validatorFromJson(parsed(child.value) as never), binding.value);
      if (problem !== null)
        throw typecheck(`Component ${at} has an invalid value for env var ${debugIdentifier(name)}: ${problem}`);
      continue;
    }
    const parent = parentValidators.get(binding.name);
    if (!parent)
      throw typecheck(
        `Component ${at} env var ${debugIdentifier(name)} references undeclared parent env var ${binding.name}`,
      );
    if (parent.optional === true && child.optional !== true)
      throw typecheck(
        `Component ${at} env var ${debugIdentifier(name)} is required, but parent env var ${binding.name} is optional`,
      );
    if (!validatorIsSubset(parsed(parent.value), parsed(child.value)))
      throw typecheck(
        `Component ${at} env var ${debugIdentifier(name)} validator is not satisfied by parent env var ${binding.name} validator`,
      );
  }
}

/** Convex's `insert_http_mount` and `CheckedHttpRoutes::mount`. */
function insertMount(
  definitions: ReadonlyMap<string, EvaluatedDefinition>,
  children: Map<string, CheckedComponent>,
  routes: CheckedComponent["httpRoutes"],
  mount: string,
  reference: string,
) {
  const parts = reference.split("/");
  if (parts[1] !== "childComponent")
    throw typecheck("Non-root child component references for HTTP mounts currently unsupported");
  if (parts.length > 3) throw typecheck("Child component references with attributes currently unsupported");
  const name = parts[2]!;
  const child = children.get(name);
  if (!child)
    throw typecheck(`HTTP mount ${debugMount(mount)} is invalid: Child component ${debugName(name)} not found.`);
  if (!definitions.has(child.definitionPath))
    throw typecheck(`Component definition not found: ${debugDefinitionPath(child.definitionPath)}`);
  if ((child.httpRoutes.httpModuleRoutes ?? []).length === 0 && child.httpRoutes.mounts.size === 0)
    throw typecheck(
      `HTTP mount ${debugMount(mount)} is invalid: Child component ${debugName(name)} doesn't have any HTTP routes.`,
    );
  // Only a prefix route (`/p/*`; a bare `*` is `/*`) can overlap a mount.
  const overlaps = (routes.httpModuleRoutes ?? []).some((r) => {
    if (!r.path.endsWith("*")) return false;
    return (r.path.slice(0, -1) || "/") === mount;
  });
  if (overlaps) throw typecheck(`HTTP mount ${debugMount(mount)} is invalid: Overlap with existing prefix route`);
  if (routes.mounts.has(mount))
    throw typecheck(`HTTP mount ${debugMount(mount)} is invalid: Overlap with previously mounted route`);
  routes.mounts.add(mount);
}

/** A definition's exports before they are resolved (Convex's `ComponentExport`): a function's path at each leaf. */
type ExportTree = Map<string, { type: "branch"; branch: ExportTree } | { type: "leaf"; udfPath: string }>;

/** Convex's `PathComponent` check of a module path's segment. */
const isPathComponent = (s: string) => s.length <= 64 && /^[A-Za-z0-9_.]*$/.test(s) && /[A-Za-z0-9]/.test(s);

/**
 * Convex's `file_based_exports`: each public function of each module, at its module's path without `.js` and its
 * name (`lib.js:add` at `lib` / `add`); a function where a module's branch is, or the other way round, is
 * `InvalidExport`.
 */
export function fileBasedExports(functions: Record<string, AnalyzedModule>): ExportTree {
  const exports: ExportTree = new Map();
  for (const modulePath of Object.keys(functions).sort()) {
    const segments = modulePath.replace(/\.js$/, "").split("/");
    for (const s of segments)
      if (!isPathComponent(s))
        throw new ComponentTreeError(
          "InvalidModulePath",
          `Invalid component ${debugString(s)} in module path ${modulePath}`,
        );
    for (const f of functions[modulePath]!.functions) {
      if (f.visibility.kind !== "public") continue;
      const conflict = () =>
        new ComponentTreeError("InvalidExport", `Path ${modulePath}:${f.name} conflicts with existing export`);
      let current = exports;
      for (const s of segments) {
        let node = current.get(s);
        if (!node) {
          node = { type: "branch", branch: new Map() };
          current.set(s, node);
        }
        if (node.type !== "branch") throw conflict();
        current = node.branch;
      }
      if (current.has(f.name)) throw conflict();
      current.set(f.name, { type: "leaf", udfPath: `${modulePath}:${f.name}` });
    }
  }
  return exports;
}

/** Convex's `resolve_exports`: each leaf a function of this component. */
function resolveExports(
  exports: ExportTree,
  evaluated: EvaluatedDefinition,
  componentPath: string[],
): Map<string, ResourceTree> {
  const out = new Map<string, ResourceTree>();
  for (const [name, node] of [...exports].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (node.type === "branch") {
      out.set(name, { type: "branch", children: resolveExports(node.branch, evaluated, componentPath) });
      continue;
    }
    const i = node.udfPath.lastIndexOf(":");
    const [module, fn] = [node.udfPath.slice(0, i), node.udfPath.slice(i + 1)];
    if (!evaluated.functions[module]?.functions.some((f) => f.name === fn))
      throw typecheck(`Component ${debugDefinitionPath(evaluated.definition.path)} has an unresolved export`);
    out.set(name, {
      type: "leaf",
      resource: { type: "function", path: { component: componentPath.join("/"), udfPath: node.udfPath } },
    });
  }
  return out;
}

/** A tree as `start_push` answers it (Convex's `SerializedCheckedComponent`): maps as objects, by key. */
export function serializedCheckedComponent(c: CheckedComponent): Record<string, unknown> {
  const tree = (t: ResourceTree): unknown =>
    t.type === "leaf"
      ? t
      : { type: "branch", children: Object.fromEntries([...t.children].map(([k, v]) => [k, tree(v)])) };
  return {
    definitionPath: c.definitionPath,
    componentPath: c.componentPath.join("/"),
    httpPrefix: c.httpPrefix,
    args: Object.fromEntries(byKey(c.args)),
    env: Object.fromEntries(byKey(c.env)),
    childComponents: Object.fromEntries(
      [...byKey(c.childComponents)].map(([k, v]) => [k, serializedCheckedComponent(v)]),
    ),
    httpRoutes: { httpModuleRoutes: c.httpRoutes.httpModuleRoutes, mounts: [...c.httpRoutes.mounts].sort() },
    exports: Object.fromEntries([...byKey(c.exports)].map(([k, v]) => [k, tree(v)])),
  };
}

/** Every component in the tree, by its path (`""` for the app's, `a/b` below), parents before children. */
export function componentsOf(root: CheckedComponent): Map<string, CheckedComponent> {
  const out = new Map<string, CheckedComponent>();
  const visit = (c: CheckedComponent) => {
    out.set(c.componentPath.join("/"), c);
    for (const child of c.childComponents.values()) visit(child);
  };
  visit(root);
  return out;
}
