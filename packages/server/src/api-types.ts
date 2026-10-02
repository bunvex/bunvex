// `api`'s type from the modules' types (STUDY-36), as Convex's npm-packages/convex/src/server/api.ts:
// `_generated/api.d.ts` writes `ApiFromModules<{ "dir/file": typeof import("../dir/file"), … }>` and
// filters it into `api` (public) and `internal`. Types only.
import type { Expand } from "@bunvex/core";
import type { FunctionReference } from "@bunvex/protocol";
import type { RegisteredAction, RegisteredMutation, RegisteredQuery } from "./registration.ts";

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
        : never;

// biome-ignore lint/suspicious/noExplicitAny: any module's exports
type FunctionReferencesInModule<Module extends Record<string, any>> = {
  -readonly [ExportName in keyof Module as Module[ExportName]["isBunvexFunction"] extends true
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
type FilterKeysInApi<Key, API, Predicate> = API extends Predicate
  ? Key
  : API extends AnyReference
    ? never
    : FilterApi<API, Predicate> extends Record<string, never>
      ? never
      : Key;

/** The references of an api that match `Predicate` (e.g. `FunctionReference<any, "public">`), dropping empty nodes. */
export type FilterApi<API, Predicate> = Expand<{
  [Mod in keyof API as FilterKeysInApi<Mod, API[Mod], Predicate>]: API[Mod] extends Predicate
    ? API[Mod]
    : FilterApi<API[Mod], Predicate>;
}>;
