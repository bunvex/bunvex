// Components' definitions (STUDY-153 PR 1): `defineApp`, `defineComponent`, `app.use` and `componentsGeneric`, as
// Convex's `server/components/index.ts`. A definition module (`bunvex.config.ts`, DV-494) default-exports what these
// return; the server evaluates it and reads one thing: `export()`, the definition as Convex serializes it
// (`AppDefinitionAnalysis` / `ComponentDefinitionAnalysis`). Inside that evaluation an imported child definition is
// a stand-in `{componentDefinitionPath, defaultName}` the server makes (STUDY-153 §1.3).

import type { Expand } from "@bunvex/core";
import { toReferencePath } from "@bunvex/protocol";
import type { GenericValidator, Infer } from "@bunvex/values";

// Convex's `EnvRef`.
/** A variable the parent passes down by reference (`app.env.X`). */
export type EnvRef = { __envVarRef: string };
/** A definition's declared environment variables: each a string validator (`v.string()`, a literal, a union). */
export type EnvDefinition = Record<string, GenericValidator>;
/** What `app.env` / `component.env` gives: a reference per declared variable. */
export type EnvRefs<Env extends EnvDefinition> = { [K in keyof Env]: EnvRef };
// Convex's `EnvFromDefinition`.
/** The values of declared variables: a required one's validator type, an optional one's or `undefined`. */
export type EnvFromDefinition<E extends EnvDefinition> = Expand<
  { [K in keyof E as E[K] extends { isOptional: "optional" } ? never : K]: Infer<E[K]> } & {
    [K in keyof E as E[K] extends { isOptional: "optional" } ? K : never]?: Infer<E[K]> | undefined;
  }
>;
// Convex's `EnvFromAppDefinition`.
/** The values of an app's declared variables. */
export type EnvFromAppDefinition<D> =
  D extends AppDefinition<infer Env> ? EnvFromDefinition<Env> : Record<string, never>;

/** The options of `use` (Convex's): the instance's name, the prefix its HTTP routes mount at, its variables. */
export type UseOptions = { name?: string; httpPrefix?: string; env?: Record<string, string | EnvRef | undefined> };

/** A child once mounted: a reference to it (`_reference/childComponent/<name>`). */
export type InstalledComponent<Definition extends ComponentDefinition = ComponentDefinition> = {
  readonly exports: AnyComponentReference;
  /** Only for types. */
  readonly __definition?: Definition;
};

type CommonDefinition = {
  use<Definition extends ComponentDefinition>(
    definition: Definition,
    options?: UseOptions,
  ): InstalledComponent<Definition>;
};
// Convex's `ComponentDefinition`.
/** A component's definition, the default export of its `bunvex.config.ts`. */
export type ComponentDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: a component's exports are any shape, as Convex's
  Exports = any,
  Env extends EnvDefinition = EnvDefinition,
> = CommonDefinition & {
  readonly env: EnvRefs<Env>;
  /** Only for types. */
  readonly __exports?: Exports;
  readonly __env?: Env;
};
// Convex's `AppDefinition`.
/** The app's definition, the default export of the app's `bunvex.config.ts`. */
export type AppDefinition<Env extends EnvDefinition = EnvDefinition> = CommonDefinition & {
  readonly env: EnvRefs<Env>;
  readonly __env?: Env;
};

/** An env value as serialized (Convex's `SerializedEnvArg`). */
type SerializedEnvArg = { type: "value"; value: string } | { type: "envVar"; name: string };
/** A declared variable as serialized: its validator's JSON as a string, `optional` for `v.optional(…)`. */
type SerializedEnvVar = [string, { type: "value"; value: string; optional?: true }];
type ChildComponent = { name: string; path: string; args: []; env: [string, SerializedEnvArg][] };
type ExportTree = { type: "branch"; branch: [] };
// Convex's `AppDefinitionAnalysis`.
/** What the server reads from the app's definition. */
export type AppDefinitionAnalysis = {
  definitionType: { type: "app" };
  httpPrefix?: string;
  childComponents: ChildComponent[];
  httpMounts: Record<string, string>;
  exports: ExportTree;
  envVars?: SerializedEnvVar[];
};
// Convex's `ComponentDefinitionAnalysis`.
/** What the server reads from a component's definition. */
export type ComponentDefinitionAnalysis = {
  name: string;
  definitionType: { type: "childComponent"; name: string; args: [] };
  childComponents: ChildComponent[];
  httpMounts: Record<string, string>;
  exports: ExportTree;
  envVars?: SerializedEnvVar[];
};

/** A child definition as the server's evaluation hands it over (Convex's `ImportedComponentDefinition`). */
type ImportedComponentDefinition = { componentDefinitionPath: string; defaultName?: string };
type Child = [name: string, definition: ImportedComponentDefinition, env: Record<string, unknown>, httpPrefix?: string];

const reference = (name: string, parts: readonly string[]) => ["_reference/childComponent", name, ...parts].join("/");

/** A reference proxy below a mounted child: `.exports.a.b` is `_reference/childComponent/<name>/a/b`. */
function exportsOf(name: string, parts: readonly string[]): AnyComponentReference {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === "string") return exportsOf(name, [...parts, prop]);
        return prop === toReferencePath ? reference(name, parts) : undefined;
      },
    },
  ) as AnyComponentReference;
}

function envRefs(owner: string, definer: string, declared: EnvDefinition | undefined) {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== "string") return undefined;
        if (!declared || !Object.hasOwn(declared, prop))
          throw new Error(`Env var "${prop}" is not declared on ${owner}. Add it to the \`env\` option of ${definer}.`);
        return { __envVarRef: prop } satisfies EnvRef;
      },
    },
  );
}

const isValidator = (v: unknown): v is GenericValidator =>
  (v as { isValidator?: unknown } | null | undefined)?.isValidator === true;

function checkEnvDefinition(env: Record<string, unknown> | undefined) {
  for (const [name, validator] of Object.entries(env ?? {}))
    if (!isValidator(validator))
      throw new Error(`Environment variable "${name}" must be defined with a validator (e.g. v.string()).`);
}

const checkHttpPrefix = (prefix: string | undefined) => {
  if (prefix !== undefined && !prefix.startsWith("/"))
    throw new Error(`httpPrefix must start with "/". Received: "${prefix}"`);
};
/** A prefix as Convex's `HttpMountPath` wants it: ending with `/`. */
const normalizeHttpPrefix = (prefix: string) => (prefix.endsWith("/") ? prefix : `${prefix}/`);

function use(this: { _children: Child[] }, definition: ComponentDefinition, options?: UseOptions) {
  const imported = definition as unknown as ImportedComponentDefinition;
  if (typeof imported.componentDefinitionPath !== "string")
    throw new Error(
      "Component definition does not have the required componentDefinitionPath property. This code only works in the bunvex runtime.",
    );
  const name: unknown = options?.name ?? imported.defaultName ?? imported.componentDefinitionPath.split("/").pop();
  if (typeof name !== "string") throw new Error(`Component name must be a string. Received: ${typeof name}`);
  if (name.length === 0) throw new Error("Component name cannot be empty.");
  checkHttpPrefix(options?.httpPrefix);
  // An `undefined` value is dropped when serialized (`serializeChildren`), as Convex's.
  this._children.push([name, imported, { ...options?.env }, options?.httpPrefix]);
  const installed = { exports: exportsOf(name, []) };
  Object.defineProperty(installed, toReferencePath, { value: reference(name, []) });
  return installed as InstalledComponent;
}

function serializeChildren(children: Child[]): ChildComponent[] {
  return children.map(([name, definition, values]) => {
    const env: [string, SerializedEnvArg][] = [];
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const ref = value as Partial<EnvRef> | null;
      if (typeof value === "object" && value !== null && typeof ref?.__envVarRef === "string")
        env.push([key, { type: "envVar", name: ref.__envVarRef }]);
      else if (typeof value === "string") env.push([key, { type: "value", value }]);
      else throw new Error(`Env var "${key}" must be a string or an env var reference. Received: ${typeof value}`);
    }
    return { name, path: definition.componentDefinitionPath, args: [], env };
  });
}

function httpMounts(children: Child[]): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const [name, , , prefix] of children)
    if (prefix !== undefined) mounts[normalizeHttpPrefix(prefix)] = reference(name, []);
  return mounts;
}

const serializeEnvVars = (env: EnvDefinition): SerializedEnvVar[] =>
  Object.entries(env).map(([name, validator]) => [
    name,
    {
      type: "value",
      value: JSON.stringify(validator.json),
      ...(validator.isOptional === "optional" ? { optional: true as const } : {}),
    },
  ]);

// Convex's `defineComponent`.
/**
 * Define a component: its name, and the variables its functions read, each a string validator; the parent passes their
 * values with `use(component, {env})`.
 */
export function defineComponent<
  // biome-ignore lint/suspicious/noExplicitAny: a component's exports are any shape, as Convex's
  Exports = any,
  const Env extends EnvDefinition = Record<never, GenericValidator>,
>(name: string, options?: { env?: Env }): ComponentDefinition<Exports, Env> {
  checkEnvDefinition(options?.env);
  const children: Child[] = [];
  const env = options?.env ?? {};
  return {
    _isRoot: false,
    _name: name,
    _children: children,
    env: envRefs(`component "${name}"`, "defineComponent", options?.env),
    use,
    export: (): ComponentDefinitionAnalysis => {
      const envVars = serializeEnvVars(env);
      return {
        name,
        definitionType: { type: "childComponent", name, args: [] },
        childComponents: serializeChildren(children),
        httpMounts: httpMounts(children),
        exports: { type: "branch", branch: [] },
        ...(envVars.length > 0 ? { envVars } : {}),
      };
    },
  } as unknown as ComponentDefinition<Exports, Env>;
}

// Convex's `defineApp`.
/**
 * Define the app: the components it mounts with `use`, the prefix of its HTTP routes, and the variables it declares.
 */
export function defineApp<Env extends EnvDefinition = EnvDefinition>(options?: {
  httpPrefix?: string;
  env?: Env;
}): AppDefinition<Env> {
  checkHttpPrefix(options?.httpPrefix);
  checkEnvDefinition(options?.env);
  const children: Child[] = [];
  return {
    _isRoot: true,
    _children: children,
    env: envRefs("this app", "defineApp", options?.env),
    use,
    export: (): AppDefinitionAnalysis => ({
      definitionType: { type: "app" },
      ...(options?.httpPrefix !== undefined ? { httpPrefix: normalizeHttpPrefix(options.httpPrefix) } : {}),
      childComponents: serializeChildren(children),
      httpMounts: httpMounts(children),
      exports: { type: "branch", branch: [] },
      ...(options?.env !== undefined ? { envVars: serializeEnvVars(options.env) } : {}),
    }),
  } as unknown as AppDefinition<Env>;
}

// Convex's `AnyComponentReference`.
/** A reference to a component's function, or to a module of it. */
// biome-ignore lint/suspicious/noExplicitAny: references below a component are any path, as Convex's
export type AnyComponentReference = Record<string, any>;
// Convex's `AnyChildComponents`.
/** A definition's mounted children by name. */
export type AnyChildComponents = Record<string, AnyComponentReference>;
// Convex's `AnyComponents`.
/** The app's mounted components, as `_generated/api`'s `components`. */
export type AnyComponents = AnyChildComponents;

function childComponents(parts: readonly string[]): AnyComponents {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === "string") return childComponents([...parts, prop]);
        if (prop !== toReferencePath) return undefined;
        if (parts.length < 1)
          throw new Error(
            `API path is expected to be of the form \`components.childComponent.functionName\`. Found: \`${["components", ...parts].join(".")}\``,
          );
        return ["_reference/childComponent", ...parts].join("/");
      },
    },
  ) as AnyComponents;
}

// Convex's `componentsGeneric`.
/** The `components` object of `_generated/api`: `components.<name>.<module>.<fn>`. */
export const componentsGeneric = (): AnyComponents => childComponents([]);

// Convex's `currentSystemUdfInComponent` (STUDY-152 §4).
/** A reference that runs a system function of the dashboard inside a component. */
export function currentSystemUdfInComponent(componentId: string): AnyComponentReference {
  return { [toReferencePath]: `_reference/currentSystemUdfInComponent/${componentId}` };
}
