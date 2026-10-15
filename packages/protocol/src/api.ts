// Function references (STUDY-26 §1.6, C3), after Convex's `server/api.ts`: how a client or a function names
// the function it calls. `anyApi.dir.file.fn` is a reference to "dir/file:fn" (`.default` to "dir/file");
// `makeFunctionReference(name)` builds one from a name; `getFunctionName` reads it back, and also accepts a
// plain name at runtime. The types carry the function's kind, visibility, arguments and result, so a typed
// API (codegen or inference, ARCH-01 open decision 1) can plug in later.

export type FunctionType = "query" | "mutation" | "action";
export type FunctionVisibility = "public" | "internal";
// biome-ignore lint/suspicious/noExplicitAny: a function's arguments object, any shape by default
export type DefaultFunctionArgs = Record<string, any>;

/** The name a reference stores. A symbol, so a reference has no enumerable fields to collide with. */
export const functionName = Symbol.for("functionName");

/** A reference to a registered function: `anyApi.messages.list`, or `makeFunctionReference("messages:list")`. */
export type FunctionReference<
  Type extends FunctionType = FunctionType,
  Visibility extends FunctionVisibility = "public",
  Args extends DefaultFunctionArgs = DefaultFunctionArgs,
  ReturnType = unknown,
> = {
  _type: Type;
  _visibility: Visibility;
  _args: Args;
  _returnType: ReturnType;
};

// biome-ignore lint/suspicious/noExplicitAny: any reference
export type AnyFunctionReference = FunctionReference<any, any, any, any>;
export type FunctionArgs<F extends AnyFunctionReference> = F["_args"];
export type FunctionReturnType<F extends AnyFunctionReference> = F["_returnType"];
/** An object with no fields: the arguments of a function that takes none. */
export type EmptyObject = Record<string, never>;
/**
 * `[args?]` when the function takes no arguments, else `[args]`, as Convex's. With an untyped reference
 * (`anyApi`, args `any`) both forms are allowed.
 */
export type OptionalRestArgs<F extends AnyFunctionReference> =
  FunctionArgs<F> extends EmptyObject ? [args?: EmptyObject] : [args: FunctionArgs<F>];
/** `OptionalRestArgs` followed by an optional options object, as Convex's `ArgsAndOptions`. */
export type ArgsAndOptions<F extends AnyFunctionReference, Options> =
  FunctionArgs<F> extends EmptyObject
    ? [args?: EmptyObject, options?: Options]
    : [args: FunctionArgs<F>, options?: Options];

/** An api object: any property path, each one a reference (Convex's `AnyApi`). */
export type AnyApi = { [module: string]: AnyApi & AnyFunctionReference };

function createApi(pathParts: string[] = []): AnyApi {
  return new Proxy({} as AnyApi, {
    get(_, prop) {
      if (typeof prop === "string") return createApi([...pathParts, prop]);
      if (prop === functionName) {
        if (pathParts.length < 2) {
          const found = ["api", ...pathParts].join(".");
          throw new Error(
            `API path is expected to be of the form \`api.moduleName.functionName\`. Found: \`${found}\``,
          );
        }
        const path = pathParts.slice(0, -1).join("/");
        const exportName = pathParts[pathParts.length - 1];
        return exportName === "default" ? path : `${path}:${exportName}`;
      }
      if (prop === Symbol.toStringTag) return "FunctionReference";
      return undefined;
    },
  });
}

/** References to every function, untyped: `anyApi.messages.list` names "messages:list". */
export const anyApi: AnyApi = createApi();

export function makeFunctionReference<
  Type extends FunctionType,
  Args extends DefaultFunctionArgs = DefaultFunctionArgs,
  ReturnType = unknown,
>(name: string): FunctionReference<Type, "public", Args, ReturnType> {
  return { [functionName]: name } as unknown as FunctionReference<Type, "public", Args, ReturnType>;
}

/**
 * A component function's reference path (`_reference/childComponent/<name>/<module>/<fn>`), as Convex's
 * `toReferencePath`: what `components.<name>…` references carry (STUDY-153).
 */
export const toReferencePath = Symbol.for("toReferencePath");

/** How a call names its function (Convex's `getFunctionAddress`): a handle, a name, or a component reference. */
export type FunctionAddress = { functionHandle: string } | { name: string } | { reference: string };

/**
 * Convex's `getFunctionAddress` (components/paths.ts): a `function://` string is a handle, another string a name,
 * a reference its name, and a component reference its path.
 */
export function getFunctionAddress(ref: unknown): FunctionAddress {
  if (typeof ref === "string") return ref.startsWith("function://") ? { functionHandle: ref } : { name: ref };
  const name = (ref as { [functionName]?: unknown } | null | undefined)?.[functionName];
  if (name) return { name: name as string };
  const path = (ref as { [toReferencePath]?: unknown } | null | undefined)?.[toReferencePath];
  if (!path) throw new Error(`${ref} is not a functionReference`);
  return { reference: path as string };
}

/** The function name of a reference (e.g. "messages:list"); a plain string is returned as is. */
export function getFunctionName(ref: AnyFunctionReference | string): string {
  if (typeof ref === "string") return ref;
  const name = (ref as unknown as { [functionName]?: unknown })?.[functionName];
  if (typeof name !== "string") {
    const path = (ref as unknown as { [toReferencePath]?: unknown } | null | undefined)?.[toReferencePath];
    // A component's function is called through its reference, not by a name of this component (Convex's words).
    if (typeof path === "string")
      throw new Error(
        `Expected function reference in the current component like "api.file.func" or "internal.file.func", but received reference ${path}`,
      );
    throw new Error(
      `Expected function reference like "api.file.func" or "internal.file.func", but received ${String(ref)}`,
    );
  }
  return name;
}
