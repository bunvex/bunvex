// Function references (STUDY-26 §1.6, C3), after Convex's `server/api.ts`: how a client or a function names
// the function it calls. `anyApi.dir.file.fn` is a reference to "dir/file:fn" (`.default` to "dir/file");
// `makeFunctionReference(name)` builds one from a name; `getFunctionName` reads it back, and also accepts a
// plain name at runtime. The types carry the function's kind, visibility, arguments and result, so a typed
// API (codegen or inference, ARCH-01 open decision 1) can plug in later.

export type FunctionType = "query" | "mutation" | "action";
export type FunctionVisibility = "public" | "internal";
/** A function's arguments: one object (Convex's `DefaultFunctionArgs`). What a reference's `Args` must be. */
export type DefaultFunctionArgs = Record<string, unknown>;
/** The arguments of a reference that does not type them: any object. */
// biome-ignore lint/suspicious/noExplicitAny: a function's arguments object, any shape by default
type AnyFunctionArgs = Record<string, any>;

/** The name a reference stores. A symbol, so a reference has no enumerable fields to collide with. */
export const functionName = Symbol.for("functionName");

/** The keys of a function's arguments, `any` when they are `any`. */
// biome-ignore lint/suspicious/noExplicitAny: `0 extends 1 & T` holds only for `any`
type ArgKeys<Args> = 0 extends 1 & Args ? any : keyof Args;
/**
 * A keys parameter every `FunctionReferenceArgKeys` is assignable to and no `FutureArgKeys` is (Convex's
 * `UncheckedArgKeys`): two `FunctionReference`s compare by `_args` alone, as before `_fn` existed.
 */
type UncheckedArgKeys = (keys: never, unchecked?: unknown) => void;
/** The second parameter of `FunctionReference`'s `_fn` (Convex's `FunctionReferenceArgKeys`). */
type FunctionReferenceArgKeys<Args> = 0 extends 1 & Args
  ? // biome-ignore lint/suspicious/noExplicitAny: as above
    any
  : ((keys: (key: ArgKeys<Args>) => void) => void) | UncheckedArgKeys;
/**
 * The second parameter of `FunctionReference_future`'s `_fn` (Convex's `FunctionReference_futureArgKeys`): the keys a
 * caller passes, checked against the function's, two parameters deep.
 */
type FutureArgKeys<Args> = 0 extends 1 & Args
  ? // biome-ignore lint/suspicious/noExplicitAny: as above
    any
  : (keys: (key: ArgKeys<Args>) => void, guard?: never) => void;

/** A reference to a registered function: `anyApi.messages.list`, or `makeFunctionReference("messages:list")`. */
export type FunctionReference<
  Type extends FunctionType = FunctionType,
  Visibility extends FunctionVisibility = "public",
  Args extends DefaultFunctionArgs = AnyFunctionArgs,
  ReturnType = unknown,
  /** The component the function is in, by its path: what a component's `ComponentApi<Name>` passes (Convex's). */
  ComponentPath = string | undefined,
> = {
  _type: Type;
  _visibility: Visibility;
  _args: Args;
  _returnType: ReturnType;
  _componentPath: ComponentPath;
  /**
   * The function's signature, as Convex 1.48's: read through `FunctionArgs` and `FunctionReturnType`. A method, so
   * two references compare as before it existed; against a `FunctionReference_future`, its arguments are checked.
   */
  _fn?(args: Args, keys: FunctionReferenceArgKeys<Args>): ReturnType;
};

/**
 * Convex's `FunctionReference_future` (1.48): a reference whose arguments and result are carried by an optional `_fn`
 * signature instead of `_args` / `_returnType`, the arguments checked closer to the way a validator checks them (a
 * surplus top-level key is refused). Every API that takes a reference takes either kind; it is not assignable to a
 * plain `FunctionReference`. Types only (a reference holds its name at run time).
 */
export type FunctionReference_future<
  Type extends FunctionType,
  Visibility extends FunctionVisibility = "public",
  // biome-ignore lint/suspicious/noExplicitAny: an untyped reference's arguments, as Convex's default
  Args extends DefaultFunctionArgs = any,
  // biome-ignore lint/suspicious/noExplicitAny: an untyped reference's result, as Convex's default
  ReturnType = any,
  ComponentPath = string | undefined,
> = {
  _type: Type;
  _visibility: Visibility;
  _componentPath: ComponentPath;
  _fn?: ((args: Args, keys: FutureArgKeys<Args>) => ReturnType) | undefined;
};

/**
 * A reference to a room (`Kind` "room") or a presence scope (`Kind` "presence") an app defines (AD-42): what
 * `anyApi.rooms.doc` is typed as. Phantom types: a reference holds only its name.
 */
export type RoomReference<
  Kind extends "room" | "presence" = "room" | "presence",
  Args = AnyFunctionArgs,
  Presence = unknown,
  Events = Record<string, never>,
> = {
  _type: "room";
  _kind: Kind;
  _args: Args;
  _presence: Presence;
  _events: Events;
  _name?: string;
};

// biome-ignore lint/suspicious/noExplicitAny: any reference
export type AnyFunctionReference = FunctionReference<any, any, any, any>;
/** Any `FunctionReference_future`. */
// biome-ignore lint/suspicious/noExplicitAny: as above
export type AnyFunctionReferenceFuture = FunctionReference_future<any, any, any, any>;
/** Either kind of reference: what every API that takes one accepts (Convex 1.48). */
export type AnyReference = AnyFunctionReference | AnyFunctionReferenceFuture;
/** A reference's arguments and result: its `_args` and `_returnType`, else its `_fn`'s (Convex's `ExtractSignature`). */
type ExtractSignature<F> = F extends { _args: infer Args; _returnType: infer R }
  ? { args: Args; returnType: R }
  : F extends { _fn?: ((args: infer Args, keys: never) => infer R) | undefined }
    ? { args: Args; returnType: R }
    : // biome-ignore lint/suspicious/noExplicitAny: an untyped reference's
      { args: any; returnType: any };
export type FunctionArgs<F extends AnyReference> = ExtractSignature<F>["args"];
export type FunctionReturnType<F extends AnyReference> = ExtractSignature<F>["returnType"];
/** An object with no fields: the arguments of a function that takes none. */
export type EmptyObject = Record<string, never>;
/**
 * `[args?]` when the function takes no arguments, else `[args]`, as Convex's. With an untyped reference
 * (`anyApi`, args `any`) both forms are allowed.
 */
export type OptionalRestArgs<F extends AnyReference> =
  FunctionArgs<F> extends EmptyObject ? [args?: EmptyObject] : [args: FunctionArgs<F>];
/** `OptionalRestArgs` followed by an optional options object, as Convex's `ArgsAndOptions`. */
export type ArgsAndOptions<F extends AnyReference, Options> =
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
  Args extends DefaultFunctionArgs = AnyFunctionArgs,
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
export function getFunctionName(ref: AnyReference | string): string {
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
