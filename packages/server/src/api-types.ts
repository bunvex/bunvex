// `api`'s type from the modules' types (STUDY-36), as Convex's npm-packages/convex/src/server/api.ts:
// `_generated/api.d.ts` writes `ApiFromModules<{ "dir/file": typeof import("../dir/file"), … }>` and
// filters it into `api` (public) and `internal`. Types, and `filterApi` (the identity, narrowed by type).
import type { Expand } from "@bunvex/core";
import type {
  DefaultFunctionArgs,
  FunctionReference,
  FunctionType,
  FunctionVisibility,
  RoomReference,
} from "@bunvex/protocol";
import type {
  RegisteredAction,
  RegisteredMutation,
  RegisteredPresence,
  RegisteredQuery,
  RegisteredRoom,
} from "./registration.ts";

export type { RoomReference };

type UndefinedToNull<T> = T extends void ? null : T;
/** A result as a client sees it: awaited, `undefined` / `void` as `null` (Convex's `ConvertReturnType`). */
export type ConvertReturnType<T> = UndefinedToNull<Awaited<T>>;

/** A module's export as a reference, if it is a function (Convex's `FunctionReferenceFromExport`). */
export type FunctionReferenceFromExport<Export> =
  Export extends RegisteredQuery<infer Visibility, infer Args, infer ReturnValue>
    ? FunctionReference<"query", Visibility, Args, ConvertReturnType<ReturnValue>>
    : Export extends RegisteredMutation<infer Visibility, infer Args, infer ReturnValue>
      ? FunctionReference<"mutation", Visibility, Args, ConvertReturnType<ReturnValue>>
      : Export extends RegisteredAction<infer Visibility, infer Args, infer ReturnValue>
        ? FunctionReference<"action", Visibility, Args, ConvertReturnType<ReturnValue>>
        : Export extends RegisteredRoom<infer Args, infer Presence, infer Events>
          ? RoomReference<"room", Args, Presence, Events>
          : Export extends RegisteredPresence<infer Args, infer State>
            ? RoomReference<"presence", Args, State>
            : never;

// biome-ignore lint/suspicious/noExplicitAny: any module's exports
type FunctionReferencesInModule<Module extends Record<string, any>> = {
  -readonly [ExportName in keyof Module as Module[ExportName]["isBunvexFunction"] extends true
    ? ExportName
    : Module[ExportName]["isBunvexRoom"] extends true
      ? ExportName
      : never]: FunctionReferenceFromExport<Module[ExportName]>;
};

/** A module at `dir/file` as `{ dir: { file: … } }`. */
type ApiForModule<
  ModulePath extends string,
  Module extends object,
> = ModulePath extends `${infer First}/${infer Second}`
  ? { [_ in First]: ApiForModule<Second, Module> }
  : { [_ in ModulePath]: FunctionReferencesInModule<Module> };

// biome-ignore lint/suspicious/noExplicitAny: the standard union-to-intersection trick
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Directories that more than one module shares, merged and expanded (for readable hovers). */
type ExpandModulesAndDirs<Obj> =
  Obj extends FunctionReference<infer Type, infer Visibility, infer Args, infer Return>
    ? FunctionReference<Type, Visibility, Args, Return>
    : { [Key in keyof Obj]: ExpandModulesAndDirs<Obj[Key]> };

type ApiFromModulesAllowEmptyNodes<AllModules extends Record<string, object>> = ExpandModulesAndDirs<
  UnionToIntersection<
    { [ModulePath in keyof AllModules]: ApiForModule<ModulePath & string, AllModules[ModulePath]> }[keyof AllModules]
  >
>;

/** The api of every module (Convex's `ApiFromModules`): each function as a typed reference. */
export type ApiFromModules<AllModules extends Record<string, object>> = FilterApi<
  ApiFromModulesAllowEmptyNodes<AllModules>,
  // biome-ignore lint/suspicious/noExplicitAny: any reference
  FunctionReference<any, any, any, any>
>;

// biome-ignore lint/suspicious/noExplicitAny: any reference
type AnyReference = FunctionReference<any, any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: any room reference
type AnyRoomReference = RoomReference<any, any, any, any>;
/**
 * Whether a predicate takes rooms (AD-42): they are public, and not functions, so a predicate takes them only if
 * it is not for `internal` and its type is `any` or includes "room" (`FunctionReference<"query">` is not).
 */
type TakesRooms<Predicate> = Predicate extends { _visibility: infer V; _type: infer T }
  ? "public" extends V
    ? "room" extends T
      ? true
      : false
    : false
  : false;
type FilterKeysInApi<Key, API, Predicate> = API extends Predicate
  ? Key
  : API extends AnyRoomReference
    ? TakesRooms<Predicate> extends true
      ? Key
      : never
    : API extends AnyReference
      ? never
      : FilterApi<API, Predicate> extends Record<string, never>
        ? never
        : Key;

/** The references of an api that match `Predicate` (e.g. `FunctionReference<any, "public">`), dropping empty nodes. */
export type FilterApi<API, Predicate> = Expand<{
  [Mod in keyof API as FilterKeysInApi<Mod, API[Mod], Predicate>]: API[Mod] extends Predicate
    ? API[Mod]
    : API[Mod] extends AnyRoomReference
      ? API[Mod]
      : FilterApi<API[Mod], Predicate>;
}>;

/**
 * `api` narrowed to the references that match `Predicate`, as Convex's `filterApi`: the same object at runtime,
 * filtered only in its type.
 *
 * ```ts
 * const queries = filterApi<typeof api, FunctionReference<"query">>(api);
 * ```
 */
export function filterApi<API, Predicate>(api: API): FilterApi<API, Predicate> {
  return api as FilterApi<API, Predicate>;
}

/**
 * An api object with any of its modules and functions left out, down every level (Convex's `PartialApi`): what a
 * test's mock of part of an api is typed as.
 */
export type PartialApi<API> = {
  // biome-ignore lint/suspicious/noExplicitAny: any reference
  [mod in keyof API]?: API[mod] extends FunctionReference<any, any, any, any> ? API[mod] : PartialApi<API[mod]>;
};

/** The keys of a function's arguments, `any` when they are `any`. */
// biome-ignore lint/suspicious/noExplicitAny: `0 extends 1 & T` holds only for `any`
type ArgKeysOf<Args> = 0 extends 1 & Args ? any : keyof Args;
/** The second parameter of `FunctionReference_future`'s `_fn`: its arguments' keys, as a callback. */
// biome-ignore lint/suspicious/noExplicitAny: as above
type FutureArgKeys<Args> = 0 extends 1 & Args ? any : (keys: (key: ArgKeysOf<Args>) => void, guard?: never) => void;

/**
 * Convex's `FunctionReference_future`: a function reference whose arguments and result are carried by an optional
 * `_fn` signature instead of `_args` / `_returnType`. Types only (a reference holds its name at run time).
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
