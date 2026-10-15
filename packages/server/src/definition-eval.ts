// Evaluating components' definitions at a push (STUDY-153 §1.3, §2.3; PR 3a): each `bunvex.config.js` (DV-494) the
// push sends, as Convex's `AppDefinitionEvaluator` (crates/isolate/src/environment/component_definitions.rs) and its
// caller `evaluate_components` (crates/application/src/deploy_config.rs).
//
// - Definitions are evaluated after what they depend on (a post-order walk from the app's), each in a fresh `vm`
//   context; re-entering one still being evaluated is `CyclicImport`.
// - A definition imports its children as `./_componentDeps/<base64url(definition path)>`: each is answered with a
//   stand-in module whose default export is `{export: () => <the child's evaluated definition>,
//   componentDefinitionPath, defaultName}`, as Convex's synthetic module. It may import `bunvex/server` and
//   `bunvex/values` too, the server's own (DV-495); nothing else.
// - The context refuses what Convex's definition environment refuses (`Date`, `Math.random`, crypto randomness,
//   `performance`, `fetch`, timers), each thrown into the definition's code with Convex's message; `console` is
//   accepted and dropped; `process.env` is the deployment's in the app's definition and refused in a component's.
// - The default export's `export()` is called, its result given the definition's `path` and read as Convex reads
//   it (`SerializedComponentDefinitionMetadata`, then its `TryFrom`), each failure an `InvalidDefinition` in
//   Convex's words.
//
// An exception the definition's code throws is `InvalidBunvexConfig` (Convex's `InvalidConvexConfig`, DV-494),
// described as Convex's `JsError` (`describeUncaught`, its frames mapped through the module's source map).
import { posix } from "node:path";
import vm from "node:vm";
import {
  type ComponentExport,
  checkEnvVarName,
  componentDefinitionRow,
  type NewComponentDefinition,
} from "@bunvex/core";
import { decodeId, fromJsonValue, identifierError, MAX_IDENTIFIER_LEN } from "@bunvex/values";
import { appNamespace } from "./app-errors.ts";
import { BUNVEX_MODULES, contextGlobals, type ModuleSource } from "./code-version.ts";
import { describeUncaught } from "./errors.ts";
import { decodeMappingsWithSources, SourceMapTokens } from "./source-position.ts";
import { moduleUrl, registerModules } from "./stack-map.ts";

/** A definition module's name, the app's and every component's (Convex's `convex.config.js`, DV-494). */
export const DEFINITION_MODULE = "bunvex.config.js";
/** The prefix of a child definition's import (Convex's esbuild plugin, `cli/lib/components/definition/bundle.ts`). */
const DEPS_PREFIX = "_componentDeps/";
/** Convex's `DATABASE_UDF_USER_TIMEOUT`, the time a definition's evaluation may take. */
const DEFINITION_TIMEOUT_MS = 1000;

/** A push that cannot go on because of a definition: Convex's `ErrorMetadata`, always a 400. */
export class DefinitionError extends Error {
  readonly status = 400;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DefinitionError";
  }
}

/** What a push sends to evaluate definitions (Convex's `ProjectConfig` parts `evaluate_components` reads). */
export type DefinitionsInput = {
  /** The app's definition module, and the definition paths it imports. */
  app: { definition: Omit<ModuleSource, "path" | "environment">; dependencies: readonly string[] };
  /** Each component definition pushed, by definition path: its module and the definition paths it imports. */
  components: ReadonlyMap<
    string,
    { definition: Omit<ModuleSource, "path" | "environment">; dependencies: readonly string[] }
  >;
  /** The variables the app's definition reads as `process.env` (the deployment's, with the built-ins). */
  env: Record<string, string>;
  timeoutMs?: number;
};

/**
 * Evaluate every definition the app's reaches (Convex's `AppDefinitionEvaluator::evaluate`): each one's metadata, by
 * definition path, the app's under `""`. A definition no dependency reaches is not evaluated, as Convex's.
 */
export async function evaluateDefinitions(input: DefinitionsInput): Promise<Map<string, NewComponentDefinition>> {
  const dependencies = new Map<string, readonly string[]>([["", input.app.dependencies]]);
  for (const [path, c] of input.components) dependencies.set(path, c.dependencies);
  const evaluated = new Map<string, NewComponentDefinition>();
  const inProgress = new Set<string>();
  type Visit = { path: string; second: boolean };
  const stack: Visit[] = [{ path: "", second: false }];
  // Convex's walk: a stack, each node's dependencies pushed in path order (a `BTreeSet` of edges), so popped last
  // to first.
  for (let visit = stack.pop(); visit; visit = stack.pop()) {
    const { path } = visit;
    if (!visit.second) {
      if (inProgress.has(path)) throw new DefinitionError("CyclicImport", "Found cyclic definition dependency");
      inProgress.add(path);
      stack.push({ path, second: true });
      for (const d of [...new Set(dependencies.get(path) ?? [])].sort()) stack.push({ path: d, second: false });
      continue;
    }
    const source = path === "" ? input.app.definition : input.components.get(path)?.definition;
    // Convex answers this with a 500 ("Component definition not found"); bunvex refuses the push (DV-496).
    if (!source) throw notPushed(path);
    evaluated.set(path, await evaluateOne(path, source, evaluated, path === "" ? input.env : null, input.timeoutMs));
    inProgress.delete(path);
  }
  return evaluated;
}

/** A dependency or import naming no pushed definition: Convex's 500, a 400 in bunvex (DV-496). */
const notPushed = (path: string) =>
  new DefinitionError("InvalidDefinition", `Component definition ${path} does not name a pushed component definition`);

/** Convex's `invalid_export_value`, in bunvex's words (DV-494). */
function invalidExport(path: string, problem: string): DefinitionError {
  return new DefinitionError(
    "InvalidDefinition",
    path === ""
      ? `The default export of \`bunvex.config.ts\` in your app has an invalid value (${problem}). Please make sure that you’re exporting the return value of \`defineApp()\` (\`import { defineApp } from 'bunvex/server'\`).`
      : `The default export of \`bunvex.config.ts\` in component \`${path}\` has an invalid value (${problem}). Please make sure that the component is exporting the return value of \`defineComponent()\` (\`import { defineComponent } from 'bunvex/server'\`).`,
  );
}

/** A JS exception from the definition's code: Convex's `InvalidConvexConfig` (`InvalidBunvexConfig`, DV-494). */
const invalidConfig = (e: unknown) => new DefinitionError("InvalidBunvexConfig", describeUncaught(e).message);

const isObject = (v: unknown): v is Record<string, unknown> =>
  (typeof v === "object" && v !== null) || typeof v === "function";

async function evaluateOne(
  path: string,
  source: Omit<ModuleSource, "path" | "environment">,
  evaluated: ReadonlyMap<string, NewComponentDefinition>,
  env: Record<string, string> | null,
  timeoutMs = DEFINITION_TIMEOUT_MS,
): Promise<NewComponentDefinition> {
  const maps = new SourceMapTokens((p) => (p === DEFINITION_MODULE ? source.sourceMap : undefined));
  const version = registerModules(maps);
  const context = definitionContext(env);
  // The maps live as long as the code that throws (`stack-map.ts` holds them weakly).
  Object.defineProperty(context, Symbol.for("bunvex.definitionMaps"), { value: maps });
  const url = `bunvex:/${DEFINITION_MODULE}`;
  let module: vm.SourceTextModule;
  try {
    module = new vm.SourceTextModule(`${source.source}\n//# sourceURL=${moduleUrl(version, DEFINITION_MODULE)}`, {
      context,
      identifier: DEFINITION_MODULE,
    });
  } catch (e) {
    throw invalidConfig(e);
  }
  const children = new Map<string, vm.Module>();
  const linker = async (spec: string): Promise<vm.Module> => {
    if (spec in BUNVEX_MODULES) {
      const ns = appNamespace(context, await BUNVEX_MODULES[spec]!());
      const names = Object.keys(ns);
      return new vm.SyntheticModule(
        names,
        function (this: vm.SyntheticModule) {
          for (const n of names) this.setExport(n, ns[n]);
        },
        { context, identifier: spec },
      );
    }
    // Resolved as Convex resolves an import against `convex:/convex.config.js`.
    const target = spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") ? resolved(spec) : null;
    // Convex fails a bare specifier as a system error; bunvex refuses it as any other import (DV-496).
    const where = (m: DefinitionError | string) => importError(source, url, spec, m);
    if (target === DEFINITION_MODULE) return module;
    if (target?.startsWith(DEPS_PREFIX)) {
      const child = target.slice(DEPS_PREFIX.length);
      const childPath = decodedDefinitionPath(child);
      if (typeof childPath !== "string") throw where(childPath.error);
      const def = evaluated.get(childPath);
      if (!def) throw where(notPushed(childPath));
      let m = children.get(childPath);
      if (!m) {
        // Convex's synthetic module: the child's serialized definition (`SerializedComponentDefinitionMetadata`).
        const row = componentDefinitionRow({ ...def, exports: { type: "branch", branch: [] } });
        const name = def.definitionType.type === "childComponent" ? def.definitionType.name : "";
        m = new vm.SourceTextModule(
          `export default { export: () => { return ${JSON.stringify(row)} }, componentDefinitionPath: ${JSON.stringify(childPath)}, defaultName: ${JSON.stringify(name)} }`,
          { context, identifier: target },
        );
        children.set(childPath, m);
      }
      return m;
    }
    throw where(
      new DefinitionError(
        "NoImportModuleDuringDefinitionEvaluation",
        `Can't import ${target ?? spec} while evaluating app definition`,
      ),
    );
  };
  try {
    await module.link(linker);
  } catch (e) {
    if (e instanceof DefinitionError) throw e;
    throw invalidConfig(e);
  }
  const evaluation = module.evaluate({ timeout: timeoutMs });
  // Convex checks the module's promise right after evaluating it: one still pending awaited at the top level.
  if (module.status === "evaluating") {
    evaluation.catch(() => {});
    throw new DefinitionError("InvalidBunvexConfig", "Top-level awaits in source files are unsupported\n");
  }
  try {
    await evaluation;
  } catch (e) {
    throw invalidConfig(e);
  }
  const namespace = module.namespace as Record<string, unknown>;
  if (!("default" in namespace)) throw invalidExport(path, "missing default export");
  const exported = namespace.default;
  if (!isObject(exported)) throw invalidExport(path, "the default export is not an object");
  if (Object.keys(namespace).length !== 1) throw invalidExport(path, "`bunvex.config.ts` has more than one export");
  if (!("export" in exported))
    throw invalidExport(path, "missing `export` property on the default export of `bunvex.config.ts`");
  const exportFn = exported.export;
  if (typeof exportFn !== "function")
    throw invalidExport(
      path,
      "`app.export` (where `app` is the default export of `bunvex.config.ts`) is not a function",
    );
  let result: unknown;
  try {
    result = (exportFn as (this: unknown) => unknown).call(exported);
  } catch (e) {
    // Convex fails this as a system error ("Failed to call export function"); bunvex as the code's exception.
    throw invalidConfig(e);
  }
  if (!isObject(result))
    throw invalidExport(
      path,
      "`app.export()` (where `app` is the default export of `bunvex.config.ts`) doesn’t return an object",
    );
  // Convex injects the definition's path into the result.
  try {
    result.path = path;
  } catch (e) {
    throw invalidConfig(e);
  }
  return readDefinition(result);
}

/** An import resolved against `bunvex:/bunvex.config.js`: the module path it names. */
const resolved = (spec: string) => posix.normalize(posix.join("/", spec)).slice(1);

/**
 * An error raised while linking an import, located as Convex's `nicely_show_line_number_on_error`: the import's
 * position in the module (0-based), and, with a source map, the original line with the position marked.
 */
function importError(
  source: Omit<ModuleSource, "path" | "environment">,
  url: string,
  spec: string,
  e: DefinitionError | string,
): DefinitionError {
  const error = typeof e === "string" ? new DefinitionError("InvalidModule", e) : e;
  const at = specifierOffset(source.source, spec);
  if (at === null) return error;
  const before = source.source.slice(0, at);
  const line = before.split("\n").length - 1;
  const col = at - (before.lastIndexOf("\n") + 1);
  const original = source.sourceMap ? originalLine(source.sourceMap, line, col) : null;
  const message = original
    ? `${url}:${original.line}:${original.col}: ${error.message}\n\n${original.text}\n${" ".repeat(original.col)}${"~".repeat(Math.max(0, original.text.length - original.col))}`
    : `${url}:${line}:${col}: ${error.message}`;
  return new DefinitionError(error.code, message);
}

/** Where the module names `spec` in an import or export (its string literal's offset), or null. */
function specifierOffset(text: string, spec: string): number | null {
  const quoted = new RegExp(`(?:\\bfrom|\\bimport)\\s*(["'])${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\1`);
  const m = quoted.exec(text);
  return m ? m.index + m[0].length - spec.length - 2 : null;
}

/** The original line and 0-based position of generated (`line`, `col`), and the line's text, from a source map. */
function originalLine(
  sourceMap: string,
  line: number,
  col: number,
): { line: number; col: number; text: string } | null {
  let map: { mappings?: unknown; sourcesContent?: unknown };
  try {
    map = JSON.parse(sourceMap);
  } catch {
    return null;
  }
  if (typeof map.mappings !== "string" || !Array.isArray(map.sourcesContent)) return null;
  const tokens = decodeMappingsWithSources(map.mappings);
  if (!tokens) return null;
  let found = -1;
  for (let k = 0; k < tokens.length; k += 5) {
    const l = tokens[k]!;
    if (l < line || (l === line && tokens[k + 1]! <= col)) found = k;
    else break;
  }
  if (found === -1) return null;
  const content = map.sourcesContent[tokens[found + 4]!];
  if (typeof content !== "string") return null;
  const text = content.split("\n")[tokens[found + 2]!];
  return text === undefined ? null : { line: tokens[found + 2]!, col: tokens[found + 3]!, text };
}

/** A child's definition path from its import (`_componentDeps/<base64url>`), or why it names none. */
function decodedDefinitionPath(encoded: string): string | { error: DefinitionError | string } {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) return { error: `Invalid base64 in ${DEPS_PREFIX}${encoded}` };
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url"));
  } catch {
    return { error: `Invalid UTF-8 in ${DEPS_PREFIX}${encoded}` };
  }
  const invalid = definitionPathError(path);
  return invalid === null ? path : { error: invalid };
}

/**
 * Convex's `ComponentDefinitionPath::from_str` (crates/common/src/components/component_definition_path.rs): a
 * relative path, `..` allowed, each other segment non-empty, at most 2048 bytes, non-control ASCII without a backslash.
 * Null when `path` is one.
 */
export function definitionPathError(path: string): string | null {
  if (path.startsWith("/")) return `Component paths must be relative (${path} is absolute).`;
  for (const [i, c] of path.split("/").entries()) {
    // As Rust's `Path::components`: empty segments and `.` past the first are skipped.
    if (c === "" || (c === "." && i > 0) || c === "..") continue;
    if (c === ".") return `Invalid path component CurDir in ${path}.`;
    const bytes = Buffer.byteLength(c);
    if (bytes > 2048) return `Path component is too long (${bytes} > maximum 2048): ${c.slice(0, 32)}...`;
    if (![...c].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f && ch !== "\\"))
      return `Path component ${c} can only include non-control ASCII characters.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The evaluation's context.

const refused = (message: string) => () => {
  throw new Error(message);
};

/**
 * A definition's globals (Convex's `DefinitionEnvironment`): the web platform functions have, with what reads time,
 * randomness or the outside refused, each throwing Convex's message into the code; `console` dropped; `process.env`
 * the deployment's for the app (`env`), refused for a component (`null`).
 */
function definitionContext(env: Record<string, string> | null): vm.Context {
  const globals = contextGlobals(false, env ?? {});
  const noop = () => {};
  globals.console = new Proxy({}, { get: () => noop });
  const random = refused("Cannot use cryptographic randomness when evaluating app definition");
  globals.crypto = { getRandomValues: random, randomUUID: random, subtle: (globalThis.crypto as Crypto).subtle };
  const performance = refused("The Performance API is not supported when evaluating app definition");
  globals.performance = Object.defineProperties({}, { now: { value: performance }, timeOrigin: { get: performance } });
  globals.fetch = refused("fetch() unsupported while evaluating app definition");
  for (const timer of ["setTimeout", "setInterval"])
    globals[timer] = refused(`${timer} unsupported while evaluating app definition`);
  const unsupported = refused("Environment variables are only supported in the app's bunvex.config.ts.") as () => never;
  globals.process = {
    env:
      env === null
        ? new Proxy(
            {},
            { get: unsupported, has: unsupported, ownKeys: unsupported, getOwnPropertyDescriptor: unsupported },
          )
        : { ...env },
  };
  const context = vm.createContext(globals);
  // The context's own `Date` and `Math.random`: reading the time or drawing a number is refused.
  const intrinsics = vm.runInContext("({ Date, Math })", context) as { Date: DateConstructor; Math: Math };
  const noDate = refused("Date unsupported when evaluating app definition");
  const ContextDate = intrinsics.Date;
  ContextDate.now = noDate as () => number;
  const RefusingDate = new Proxy(ContextDate, {
    construct: (target, args, newTarget) => (args.length === 0 ? noDate() : Reflect.construct(target, args, newTarget)),
    apply: noDate,
  });
  vm.runInContext("(D) => { globalThis.Date = D; }", context)(RefusingDate);
  intrinsics.Math.random = refused("Math.random unsupported when evaluating app definition") as () => number;
  return context;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading `export()`'s result: Convex's serde of `SerializedComponentDefinitionMetadata`
// (crates/common/src/bootstrap_model/components/definition.rs), then its `TryFrom`.

/** A failure of serde's read: Convex's "Failed to deserialize {json}: {error}". */
class Shape extends Error {}

/** A name in backticks, as serde quotes one. */
const tick = (s: string) => "`" + s + "`";

/** What serde names a value it did not expect (its `Unexpected`). */
function unexpected(v: unknown): string {
  if (v === null || v === undefined) return "unit value";
  if (typeof v === "string") return `string ${JSON.stringify(v)}`;
  if (typeof v === "boolean") return `boolean ${tick(String(v))}`;
  if (typeof v === "number") return `${Number.isInteger(v) ? "integer" : "floating point"} ${tick(String(v))}`;
  if (Array.isArray(v)) return "sequence";
  return "map";
}

const field = (o: Record<string, unknown>, name: string): unknown => {
  const v = o[name];
  if (v === undefined) throw new Shape(`missing field ${tick(name)}`);
  return v;
};
const optional = (o: Record<string, unknown>, name: string): unknown => (o[name] === undefined ? null : o[name]);
const struct = (v: unknown, name: string): Record<string, unknown> => {
  if (!isObject(v) || Array.isArray(v)) throw new Shape(`invalid type: ${unexpected(v)}, expected struct ${name}`);
  return v;
};
const string = (v: unknown): string => {
  if (typeof v !== "string") throw new Shape(`invalid type: ${unexpected(v)}, expected a string`);
  return v;
};
const sequence = <T>(v: unknown, each: (x: unknown) => T): T[] => {
  if (!Array.isArray(v)) throw new Shape(`invalid type: ${unexpected(v)}, expected a sequence`);
  return v.map(each);
};
const pair = <T>(v: unknown, second: (x: unknown) => T): [string, T] => {
  if (!Array.isArray(v)) throw new Shape(`invalid type: ${unexpected(v)}, expected a tuple of size 2`);
  if (v.length !== 2) throw new Shape(`invalid length ${v.length}, expected a tuple of size 2`);
  return [string(v[0]), second(v[1])];
};
/** An internally tagged enum (serde's `tag = "type"`): its variant, of `variants`. */
const tagged = (v: unknown, name: string, variants: string[]): [string, Record<string, unknown>] => {
  if (!isObject(v) || Array.isArray(v))
    throw new Shape(`invalid type: ${unexpected(v)}, expected internally tagged enum ${name}`);
  const tag = field(v, "type");
  if (typeof tag !== "string" || !variants.includes(tag))
    throw new Shape(
      `unknown variant ${typeof tag === "string" ? tick(tag) : unexpected(tag)}, expected ${variants.map(tick).join(variants.length === 2 ? " or " : ", ")}`,
    );
  return [tag, v];
};
const valueVariant = (v: unknown, name: string) => string(field(tagged(v, name, ["value"])[1], "value"));

type RawExport = { type: "branch"; branch: [string, RawExport][] } | { type: "leaf"; leaf: string };
const rawExport = (v: unknown): RawExport => {
  const [tag, o] = tagged(v, "SerializedComponentExport", ["branch", "leaf"]);
  return tag === "branch"
    ? { type: "branch", branch: sequence(field(o, "branch"), (p) => pair(p, rawExport)) }
    : { type: "leaf", leaf: string(field(o, "leaf")) };
};

/** `export()`'s result read as Convex's serde reads it, then checked as its `TryFrom`; `InvalidDefinition` else. */
function readDefinition(result: Record<string, unknown>): NewComponentDefinition {
  let raw: ReturnType<typeof serialized>;
  try {
    raw = serialized(result);
  } catch (e) {
    if (!(e instanceof Shape)) throw e;
    let json: string;
    try {
      json = JSON.stringify(result) ?? "<unknown>";
    } catch {
      json = "<unknown>";
    }
    throw new DefinitionError("InvalidDefinition", `Failed to deserialize ${json}: ${e.message}`);
  }
  try {
    return checked(raw);
  } catch (e) {
    if (e instanceof Invalid) throw new DefinitionError("InvalidDefinition", e.message);
    throw e;
  }
}

/** Serde's read: the fields in the struct's order, the first missing one named. */
function serialized(v: Record<string, unknown>) {
  const o = struct(v, "SerializedComponentDefinitionMetadata");
  const path = string(field(o, "path"));
  const [type, t] = tagged(field(o, "definitionType"), "SerializedComponentDefinitionType", ["app", "childComponent"]);
  const definitionType =
    type === "app"
      ? { type: "app" as const }
      : {
          type: "childComponent" as const,
          name: string(field(t, "name")),
          args: sequence(field(t, "args"), (p) =>
            pair(p, (x) => valueVariant(x, "SerializedComponentArgumentValidator")),
          ),
        };
  const childComponents = sequence(field(o, "childComponents"), (c) => {
    const i = struct(c, "SerializedComponentInstantiation");
    const args = optional(i, "args");
    return {
      name: string(field(i, "name")),
      path: string(field(i, "path")),
      args:
        args === null ? null : sequence(args, (p) => pair(p, (x) => valueVariant(x, "SerializedComponentArgument"))),
      env: sequence(optional(i, "env") ?? [], (p) =>
        pair(p, (x) => {
          const [kind, b] = tagged(x, "SerializedEnvBinding", ["value", "envVar"]);
          return kind === "value"
            ? { type: "value" as const, value: string(field(b, "value")) }
            : { type: "envVar" as const, name: string(field(b, "name")) };
        }),
      ),
    };
  });
  const mounts = optional(o, "httpMounts");
  const httpMounts =
    mounts === null ? null : Object.entries(struct(mounts, "a map")).map(([k, x]): [string, string] => [k, string(x)]);
  const prefix = optional(o, "httpPrefix");
  const httpPrefix = prefix === null ? null : string(prefix);
  const exports = rawExport(field(o, "exports"));
  const vars = optional(o, "envVars");
  const envVars =
    vars === null
      ? null
      : sequence(vars, (p) =>
          pair(p, (x) => {
            const [, e] = tagged(x, "SerializedEnvVarValidator", ["value"]);
            const opt = optional(e, "optional");
            if (opt !== null && typeof opt !== "boolean")
              throw new Shape(`invalid type: ${unexpected(opt)}, expected a boolean`);
            return { value: string(field(e, "value")), optional: opt === true };
          }),
        );
  return { path, definitionType, childComponents, httpMounts, httpPrefix, exports, envVars };
}

/** A failure of Convex's `TryFrom`: its error's text. */
class Invalid extends Error {}
const must = (error: string | null) => {
  if (error !== null) throw new Invalid(error);
};

/** Convex's `Identifier::from_str`. */
const identifier = (s: string) => must(identifierError(s));

/** Convex's `PathComponent::from_str` (an export's name): letters, digits, `_` and `.`, one alphanumeric at least. */
function pathComponent(s: string) {
  if (s.length > MAX_IDENTIFIER_LEN)
    must(
      `Path component is too long (${s.length} > maximum ${MAX_IDENTIFIER_LEN}): ${s.slice(0, MAX_IDENTIFIER_LEN)}...`,
    );
  if (!/^[A-Za-z0-9_.]*$/.test(s))
    must(`Path component ${s} can only contain alphanumeric characters, underscores, or periods.`);
  if (!/[A-Za-z0-9]/.test(s)) must(`Path component ${s} must have at least one alphanumeric character.`);
}

/** Convex's `HttpMountPath::from_str`: its `ensure!`s, whose failures name the condition. */
function httpMountPath(s: string) {
  if (!s.startsWith("/")) must("Condition failed: `s.starts_with('/')`");
  if (!s.endsWith("/")) must("Condition failed: `s.ends_with('/')`");
  if (s.includes("*")) must("Condition failed: `!s.contains('*')`");
  // The `http` crate's `PathAndQuery`: no control characters, spaces or non-ASCII.
  if ([...s].some((c) => c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) >= 0x7f)) must("invalid uri character");
  if (s.includes("?")) must("Condition failed: `path.query().is_none()`");
}

/** Convex's `Reference::from_str` (crates/common/src/components/reference.rs). */
function reference(s: string) {
  const parts = s.split("/");
  if (parts[0] !== "_reference") must(`Invalid reference: ${s}`);
  const kind = parts[1];
  const rest = parts.slice(2);
  if (kind === "componentArgument") for (const a of rest) identifier(a);
  else if (kind === "function") {
    if (parts.length < 3) must(`Invalid reference ${s}`);
  } else if (kind === "childComponent") {
    if (rest.length === 0) must(`Invalid reference ${s}`);
    for (const a of rest) identifier(a);
  } else if (kind === "currentSystemUdfInComponent") {
    if (rest.length === 0) must(`Invalid reference ${s}`);
    try {
      decodeId(rest[0]!);
    } catch (e) {
      must((e as Error).message);
    }
  } else must(`Invalid reference ${s}`);
}

/** A validator's JSON as Convex's `Validator::json_deserialize` takes it: a JSON object with a `type`. */
function validatorJson(s: string) {
  let j: unknown;
  try {
    j = JSON.parse(s);
  } catch (e) {
    must((e as Error).message);
  }
  if (!isObject(j) || typeof j.type !== "string") must(`Invalid validator JSON: ${s}`);
}

/** Convex's `ComponentExport` from its serialized form. */
function exportOf(e: RawExport): ComponentExport {
  if (e.type === "leaf") {
    reference(e.leaf);
    return e;
  }
  return {
    type: "branch",
    branch: e.branch.map(([k, x]) => {
      pathComponent(k);
      return [k, exportOf(x)];
    }),
  };
}

/** Convex's `TryFrom<SerializedComponentDefinitionMetadata>`, its checks in its order. */
function checked(raw: ReturnType<typeof serialized>): NewComponentDefinition {
  const exports = exportOf(raw.exports);
  if (exports.type !== "branch") must("Expected branch of exports at the top level");
  const envVars = (raw.envVars ?? []).map(([name, x]): NewComponentDefinition["envVars"][number] => {
    identifier(name);
    validatorJson(x.value);
    return [name, x.optional ? { type: "value", value: x.value, optional: true } : { type: "value", value: x.value }];
  });
  must(definitionPathError(raw.path));
  let definitionType: NewComponentDefinition["definitionType"];
  if (raw.definitionType.type === "app") definitionType = { type: "app" };
  else {
    identifier(raw.definitionType.name);
    const args = raw.definitionType.args.map(([k, value]): [string, { type: "value"; value: string }] => {
      identifier(k);
      validatorJson(value);
      return [k, { type: "value", value }];
    });
    definitionType = { type: "childComponent", name: raw.definitionType.name, args };
  }
  const childComponents = raw.childComponents.map((c) => {
    identifier(c.name);
    must(definitionPathError(c.path));
    const args =
      c.args === null
        ? null
        : c.args.map(([k, value]): [string, { type: "value"; value: string }] => {
            identifier(k);
            try {
              fromJsonValue(JSON.parse(value));
            } catch (e) {
              must((e as Error).message);
            }
            return [k, { type: "value", value }];
          });
    const env = c.env.map(([k, b]): [string, typeof b] => {
      identifier(k);
      if (b.type === "envVar")
        try {
          checkEnvVarName(b.name);
        } catch (e) {
          must((e as Error).message);
        }
      return [k, b];
    });
    return { name: c.name, path: c.path, args, env };
  });
  const httpMounts = Object.fromEntries(
    (raw.httpMounts ?? []).map(([k, r]) => {
      httpMountPath(k);
      reference(r);
      return [k, r];
    }),
  );
  if (raw.httpPrefix !== null) httpMountPath(raw.httpPrefix);
  return {
    path: raw.path,
    definitionType,
    childComponents,
    httpMounts,
    httpPrefix: raw.httpPrefix,
    exports: exports as ComponentExport & { type: "branch" },
    envVars,
  };
}
