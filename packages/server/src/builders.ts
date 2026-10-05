// The function builders (`query`, `mutation`, `action` and their internal and generic forms) and what they
// make. Isomorphic, as Convex's `convex/server`: they import no runtime, so an app's shared modules, and the
// `_generated/server` they come through, load in a browser and in Node (`./isomorphic.ts`); the runtime that
// runs them is `./functions.ts`.
import { type GenericValidator, type Infer, type ObjectType, type PropertyValidators, v } from "@bunvex/values";
import type { ActionCtx, MutationCtx, QueryCtx } from "./functions.ts";
import type { ActionBuilder, MutationBuilder, QueryBuilder } from "./registration.ts";
import { parseValidatorJson } from "./validator-json.ts";

/** `args`: an object of field validators or a validator (Convex's `asObjectValidator`). */
export type ArgsValidator = PropertyValidators | GenericValidator;
// biome-ignore lint/suspicious/noExplicitAny: without an `args` validator the arguments are any object
export type AnyArgs = Record<string, any>;
export type ArgsOf<A> = A extends { isValidator: true }
  ? Infer<A & GenericValidator>
  : A extends PropertyValidators
    ? ObjectType<A>
    : AnyArgs;

export type Visibility = "public" | "internal";
type Handler<Ctx> = (ctx: Ctx, args: AnyArgs) => unknown;
export type FunctionDef =
  | {
      kind: "query";
      visibility: Visibility;
      handler: Handler<QueryCtx>;
      args?: GenericValidator;
      returns?: GenericValidator;
    }
  | {
      kind: "mutation";
      visibility: Visibility;
      handler: Handler<MutationCtx>;
      args?: GenericValidator;
      returns?: GenericValidator;
    }
  | {
      kind: "action";
      visibility: Visibility;
      handler: Handler<ActionCtx>;
      args?: GenericValidator;
      returns?: GenericValidator;
    };

const asObjectValidator = (a: ArgsValidator): GenericValidator =>
  (a as GenericValidator).isValidator ? (a as GenericValidator) : v.object(a as PropertyValidators);

/** Every function a builder made: how a code version's analysis tells its functions from other exports. */
const DEFINED = new WeakSet<object>();
/** The functions of `"use node"` modules (their code version marks them): the log's `environment` (STUDY-47). */
export const NODE_FUNCTIONS = new WeakSet<FunctionDef>();

export const isFunctionDef = (x: unknown): x is FunctionDef =>
  (typeof x === "function" || (typeof x === "object" && x !== null)) && DEFINED.has(x as object);

const KIND_MARKER = { query: "isQuery", mutation: "isMutation", action: "isAction" } as const;

function define<K extends FunctionDef["kind"]>(kind: K, visibility: Visibility, def: unknown): FunctionDef {
  const spec = defineUnmarked(kind, visibility, def);
  const builderName = visibility === "public" ? kind : `internal${kind[0]!.toUpperCase()}${kind.slice(1)}`;
  const f = dontCallDirectly(builderName, spec.handler as (ctx: unknown, args: unknown) => unknown);
  assertNotBrowser();
  // Convex's markers: what the function is (`ApiFromModules` reads them as types), and its validators' JSON,
  // which the push's analysis and `apiSpec` read (`exportArgs` / `exportReturns`, plain own properties as
  // Convex's).
  Object.assign(f, spec, {
    isBunvexFunction: true,
    [KIND_MARKER[kind]]: true,
    [visibility === "public" ? "isPublic" : "isInternal"]: true,
    exportArgs: () => JSON.stringify((spec.args ?? v.any()).json, strictReplacer),
    exportReturns: () => JSON.stringify(spec.returns ? spec.returns.json : null, strictReplacer),
  });
  DEFINED.add(f);
  return f as unknown as FunctionDef;
}

/**
 * Convex's `strictReplacer` (registration_impl.ts): a validator still `undefined` when the JSON is made, usually
 * from a circular import, fails the analysis instead of vanishing from the JSON.
 */
function strictReplacer(key: string, value: unknown) {
  if (value === undefined)
    throw new Error(`A validator is undefined for field "${key}". This is often caused by circular imports.`);
  return value;
}

export type ValidatorExport = "exportArgs" | "exportReturns";

/**
 * What Convex's analyze reads from a function (analyze.rs `parse_args_validator` / `parse_returns_validator`):
 * the JSON its `exportArgs()` / `exportReturns()` returns; without the method, unvalidated (`{"type":"any"}`
 * arguments, a `null` result validator). A malformed export is a `problem`, in Convex's words, for `id`
 * (`module.js:name`); an error the method throws propagates.
 */
export function exportedValidator(
  f: object,
  method: ValidatorExport,
  id: string,
): { json: string } | { problem: string } {
  const m = (f as Record<string, unknown>)[method];
  if (m === undefined) return { json: method === "exportArgs" ? '{"type":"any"}' : "null" };
  if (typeof m !== "function") return { problem: `${id}.${method} is not a function or \`undefined\`.` };
  const json: unknown = m.call(f);
  if (typeof json !== "string")
    return { problem: `Invalid ${method} return value: ${id}.${method}() didn't return a string.` };
  // Parsed as Convex's backend parses it (validator-json.ts): what it stores, or why it refuses it.
  const r = parseValidatorJson(json, method === "exportArgs" ? "args" : "returns");
  return "json" in r ? r : { problem: `Invalid JSON returned from ${id}.${method}(): ${r.error}` };
}

/**
 * A registered function is callable, as Convex's (registration_impl.ts `dontCallDirectly`, STUDY-66 §7): called
 * directly (`await foo(ctx, args)`), it warns and runs the handler.
 */
function dontCallDirectly(builderName: string, handler: (ctx: unknown, args: unknown) => unknown) {
  return (ctx: unknown, args: unknown) => {
    console.warn(
      "bunvex functions should not directly call other bunvex functions. Consider calling a helper function instead. " +
        `e.g. \`export const foo = ${builderName}(...); await foo(ctx);\` is not supported.`,
    );
    return handler(ctx, args);
  };
}

/**
 * Convex's `assertNotBrowser`: functions imported in a real browser (its `window` getter is native code;
 * JSDOM's is not) log an error. `window.__bunvexAllowFunctionsInBrowser` turns it off.
 */
function assertNotBrowser() {
  const w = (globalThis as { window?: { __bunvexAllowFunctionsInBrowser?: unknown } }).window;
  if (w === undefined || w.__bunvexAllowFunctionsInBrowser) return;
  const isRealBrowser =
    Object.getOwnPropertyDescriptor(globalThis, "window")?.get?.toString().includes("[native code]") ?? false;
  if (isRealBrowser)
    console.error(
      "bunvex functions should not be imported in the browser. This will throw an error in future versions of `bunvex`. If this is a false negative, please report it to bunvex.",
    );
}

function defineUnmarked<K extends FunctionDef["kind"]>(kind: K, visibility: Visibility, def: unknown): FunctionDef {
  if (typeof def === "function") return { kind, visibility, handler: def } as FunctionDef;
  const d = def as { args?: ArgsValidator; returns?: ArgsValidator; handler: unknown };
  if (typeof d?.handler !== "function")
    throw new Error(`${kind}(): expected a function or { args?, returns?, handler }`);
  return {
    kind,
    visibility,
    handler: d.handler,
    args: d.args === undefined ? undefined : asObjectValidator(d.args),
    // An object of field validators is `v.object` of them, for `returns` as for `args` (Convex's
    // `asObjectValidator`).
    returns: d.returns === undefined ? undefined : asObjectValidator(d.returns),
  } as FunctionDef;
}

// The builders without a data model, as Convex's `queryGeneric` …; `_generated/server` re-exports them
// typed with the app's data model. `query` … are the same builders, for apps without codegen.
const builder = (kind: FunctionDef["kind"], visibility: Visibility) => (def: unknown) => define(kind, visibility, def);

// biome-ignore lint/suspicious/noExplicitAny: no data model
type AnyDM = any;
export const queryGeneric = builder("query", "public") as unknown as QueryBuilder<AnyDM, "public">;
export const internalQueryGeneric = builder("query", "internal") as unknown as QueryBuilder<AnyDM, "internal">;
export const mutationGeneric = builder("mutation", "public") as unknown as MutationBuilder<AnyDM, "public">;
export const internalMutationGeneric = builder("mutation", "internal") as unknown as MutationBuilder<AnyDM, "internal">;
export const actionGeneric = builder("action", "public") as unknown as ActionBuilder<AnyDM, "public">;
export const internalActionGeneric = builder("action", "internal") as unknown as ActionBuilder<AnyDM, "internal">;
export const query = queryGeneric;
export const internalQuery = internalQueryGeneric;
export const mutation = mutationGeneric;
export const internalMutation = internalMutationGeneric;
export const action = actionGeneric;
export const internalAction = internalActionGeneric;
